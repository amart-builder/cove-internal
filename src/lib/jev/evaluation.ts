/**
 * Offline evaluation for the Jev lanes.
 *
 * Two things have to be possible before Jev touches real mail or real meetings. Someone has to
 * be able to read the exact request Cove would send, without a key and without
 * a network call, because "what are we actually sending a third party" is the
 * first question anyone should ask. And the wording has to be scoreable against
 * labels that were frozen before the run, because tuning questions against the
 * answers you already saw is how a lane ends up looking better than it is.
 *
 * Prepare mode answers the first. Scoring answers the second, against whatever
 * transport is handed in, which in tests is a recorded one and in a live run is
 * the real client.
 */
import {
  composeCommitmentVerdict,
  planJevEmailRequest,
  readWaitingAnswers,
  type JevEmailEvidence,
  type JevWaitingReason,
} from "./email";
import {
  composeMeetingItemVerdict,
  planJevMeetingRequest,
  type JevMeetingEvidence,
  type JevMeetingItemKind,
} from "./meeting";
import type { JevAnswer, JevQuestion } from "./client";

export type JevEmailCaseLabels = {
  bucket: "reply" | "action" | "fyi" | "noise";
  urgent: boolean;
  moneyOut: boolean;
  needsReply: boolean;
};

export type JevWaitingCase = {
  id: string;
  title: string;
  detail?: string | null;
  labels: {
    /** Whether the operator still has to wait for this after the email. */
    resolved: boolean;
    reason: JevWaitingReason;
  };
};

export type JevCommitmentCase = {
  kind: "follow_up" | "waiting_on";
  title: string;
  sourceQuote: string;
  labels: { real: boolean; owner: string };
};

export type JevEmailCase = {
  id: string;
  split: "dev" | "heldout";
  accountEmail: string;
  sender: string;
  subject: string;
  text: string;
  labels: JevEmailCaseLabels;
  commitments?: JevCommitmentCase[];
  /** Waiting-on rows Cove already held open against this sender. */
  waiting?: JevWaitingCase[];
};

export type JevPreparedCase = {
  id: string;
  split: "dev" | "heldout";
  state: Record<string, unknown>;
  questions: Record<string, JevQuestion>;
  /** Bytes on the wire, so an oversized case is visible before it is sent. */
  requestBytes: number;
};

export function parseJevEmailCases(value: unknown): JevEmailCase[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The Jev case file is not an object.");
  }
  const rows = (value as Record<string, unknown>).cases;
  if (!Array.isArray(rows)) throw new Error("The Jev case file has no cases array.");
  return rows.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`Case ${index} is not an object.`);
    }
    const item = row as Record<string, unknown>;
    const labels = item.labels as Record<string, unknown> | undefined;
    if (!labels) throw new Error(`Case ${String(item.id)} has no labels.`);
    return {
      id: String(item.id),
      split: item.split === "heldout" ? "heldout" : "dev",
      accountEmail: String(item.accountEmail),
      sender: String(item.sender),
      subject: String(item.subject),
      text: String(item.text),
      labels: {
        bucket: labels.bucket as JevEmailCaseLabels["bucket"],
        urgent: labels.urgent === true,
        moneyOut: labels.moneyOut === true,
        needsReply: labels.needsReply === true,
      },
      commitments: Array.isArray(item.commitments)
        ? item.commitments.map((entry) => {
          const commitment = entry as Record<string, unknown>;
          const commitmentLabels = commitment.labels as Record<string, unknown>;
          return {
            kind: commitment.kind === "follow_up" ? "follow_up" : "waiting_on",
            title: String(commitment.title),
            sourceQuote: String(commitment.sourceQuote),
            labels: {
              real: commitmentLabels?.real === true,
              owner: String(commitmentLabels?.owner ?? "unclear"),
            },
          };
        })
        : undefined,
      waiting: Array.isArray(item.waiting)
        ? item.waiting.map((entry) => {
          const candidate = entry as Record<string, unknown>;
          const candidateLabels = candidate.labels as Record<string, unknown>;
          return {
            id: String(candidate.id),
            title: String(candidate.title),
            detail: candidate.detail === undefined || candidate.detail === null
              ? null
              : String(candidate.detail),
            labels: {
              resolved: candidateLabels?.resolved === true,
              reason: (candidateLabels?.reason ?? "still_coming") as JevWaitingReason,
            },
          };
        })
        : undefined,
    };
  });
}

export function caseEvidence(item: JevEmailCase): JevEmailEvidence {
  return {
    accountEmail: item.accountEmail,
    sender: item.sender,
    subject: item.subject,
    text: item.text,
    commitments: (item.commitments ?? []).map((commitment, index) => ({
      index,
      kind: commitment.kind,
      title: commitment.title,
      sourceQuote: commitment.sourceQuote,
    })),
    waiting: (item.waiting ?? []).map((candidate, index) => ({
      index,
      id: candidate.id,
      title: candidate.title,
      detail: candidate.detail ?? null,
    })),
  };
}

/** Builds every request without a credential and without touching the network. */
export function prepareJevEmailCases(cases: readonly JevEmailCase[]): JevPreparedCase[] {
  return cases.map((item) => {
    const plan = planJevEmailRequest({
      evidence: caseEvidence(item),
      triage: true,
      commitmentAudit: (item.commitments ?? []).length > 0,
      waitingResolution: (item.waiting ?? []).length > 0,
    });
    return {
      id: item.id,
      split: item.split,
      state: plan.state,
      questions: plan.questions,
      requestBytes: plan.requestBytes,
    };
  });
}

export type JevCaseScore = {
  id: string;
  split: "dev" | "heldout";
  results: { question: string; expected: string; got: string; correct: boolean }[];
};

export type JevEvaluationSummary = {
  scored: number;
  byQuestion: Record<string, { correct: number; total: number; rate: number }>;
  /**
   * Counted separately because an overall rate can look healthy while the lane
   * quietly drops the emails that actually needed the operator.
   */
  missedRequests: { id: string; expected: string; got: string }[];
  /**
   * Waiting-on rows the labels say are still owed that Jev read as settled.
   * Counted separately because this is the one answer in the lane that could
   * retire a real obligation, which is the failure Cove cannot afford.
   */
  falseCloses: { id: string; commitmentId: string; title: string }[];
  cases: JevCaseScore[];
};

const NOUL_DECISION_THRESHOLD = 0.5;

export function scoreJevEmailCases(input: {
  cases: readonly JevEmailCase[];
  answersById: Record<string, Record<string, JevAnswer>>;
  /** Only used to turn a probability into a label for scoring. */
  noulThreshold?: number;
}): JevEvaluationSummary {
  const threshold = input.noulThreshold ?? NOUL_DECISION_THRESHOLD;
  const byQuestion: Record<string, { correct: number; total: number; rate: number }> = {};
  const missedRequests: JevEvaluationSummary["missedRequests"] = [];
  const falseCloses: JevEvaluationSummary["falseCloses"] = [];
  const cases: JevCaseScore[] = [];

  const tally = (question: string, correct: boolean): void => {
    const row = byQuestion[question] ?? { correct: 0, total: 0, rate: 0 };
    row.total += 1;
    if (correct) row.correct += 1;
    row.rate = row.correct / row.total;
    byQuestion[question] = row;
  };

  for (const item of input.cases) {
    const answers = input.answersById[item.id];
    if (!answers) continue;
    const results: JevCaseScore["results"] = [];
    const record = (question: string, expected: string, got: string): void => {
      const correct = expected === got;
      results.push({ question, expected, got, correct });
      tally(question, correct);
    };

    const bucket = answers.bucket;
    if (bucket && bucket.type === "choice") {
      record("bucket", item.labels.bucket, bucket.choice);
      // An email that needed the operator and was called noise is the failure
      // that matters, so it is listed by name rather than averaged away.
      const neededOperator = item.labels.bucket === "reply" || item.labels.bucket === "action";
      const dismissed = bucket.choice === "noise" || bucket.choice === "fyi";
      if (neededOperator && dismissed) {
        missedRequests.push({ id: item.id, expected: item.labels.bucket, got: bucket.choice });
      }
    }
    for (const [key, expected] of [
      ["urgent", item.labels.urgent],
      ["money_out", item.labels.moneyOut],
      ["needs_reply", item.labels.needsReply],
    ] as const) {
      const answer = answers[key];
      if (answer && answer.type === "noul") {
        record(key, String(expected), String(answer.noul >= threshold));
      }
    }
    (item.commitments ?? []).forEach((commitment, index) => {
      const real = answers[`commitment_${index}_real`];
      if (real && real.type === "noul") {
        record(
          "commitment_real",
          String(commitment.labels.real),
          String(real.noul >= threshold),
        );
      }
      // Scored beside the direct answer so the two can be compared. If
      // composing the atomic halves in code beats asking the broad question,
      // that is the argument for dropping the broad one.
      const futureAction = answers[`commitment_${index}_future_action`];
      const unconditional = answers[`commitment_${index}_unconditional`];
      const composed = composeCommitmentVerdict({
        futureAction: futureAction && futureAction.type === "noul" ? futureAction.noul : null,
        unconditional: unconditional && unconditional.type === "noul"
          ? unconditional.noul
          : null,
        threshold,
      });
      if (composed !== null) {
        record("commitment_real_composed", String(commitment.labels.real), String(composed));
      }
      const owner = answers[`commitment_${index}_owner`];
      if (owner && owner.type === "choice") {
        record("commitment_owner", commitment.labels.owner, owner.choice);
      }
    });
    (item.waiting ?? []).forEach((candidate, index) => {
      const noul = (key: string): number | null => {
        const answer = answers[`waiting_${index}_${key}`];
        return answer && answer.type === "noul" ? answer.noul : null;
      };
      const reading = readWaitingAnswers({
        delivered: noul("delivered"),
        stillOutstanding: noul("still_outstanding"),
        threshold,
      });
      if (reading.resolved === null) return;
      record("waiting_resolved", String(candidate.labels.resolved), String(reading.resolved));
      record("waiting_reason", candidate.labels.reason, reading.reason ?? "");
      if (!candidate.labels.resolved && reading.resolved) {
        falseCloses.push({
          id: item.id,
          commitmentId: candidate.id,
          title: candidate.title,
        });
      }
    });
    cases.push({ id: item.id, split: item.split, results });
  }

  return { scored: cases.length, byQuestion, missedRequests, falseCloses, cases };
}

export function formatJevEvaluation(summary: JevEvaluationSummary): string {
  const lines: string[] = [];
  lines.push(`Scored ${summary.scored} case(s).`);
  lines.push("");
  for (const [question, row] of Object.entries(summary.byQuestion).sort()) {
    lines.push(
      `${question}: ${row.correct} of ${row.total} (${(row.rate * 100).toFixed(1)}%)`,
    );
  }
  lines.push("");
  if (summary.missedRequests.length === 0) {
    lines.push("No email that needed the operator was dismissed as fyi or noise.");
  } else {
    lines.push("Dismissed an email that needed the operator:");
    for (const missed of summary.missedRequests) {
      lines.push(`  ${missed.id}: expected ${missed.expected}, got ${missed.got}`);
    }
  }
  if (summary.falseCloses.length > 0) {
    lines.push("");
    lines.push("Read a commitment as settled that is still owed:");
    for (const close of summary.falseCloses) {
      lines.push(`  ${close.id}: ${close.title} (${close.commitmentId})`);
    }
  }
  const wrong = summary.cases.flatMap((item) =>
    item.results.filter((result) => !result.correct).map((result) => ({ id: item.id, ...result }))
  );
  if (wrong.length > 0) {
    lines.push("");
    lines.push("Every disagreement with the frozen labels:");
    for (const result of wrong) {
      lines.push(
        `  ${result.id} ${result.question}: expected ${result.expected}, got ${result.got}`,
      );
    }
  }
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* The meeting lane                                                            */
/*                                                                            */
/* Same two obligations, different failure. In email the loss that matters is  */
/* an operator's request dismissed as noise. Here it is the opposite: an item  */
/* the meeting never agreed to, accepted and put on the board, where it costs  */
/* attention every day until somebody deletes it by hand.                      */
/* -------------------------------------------------------------------------- */

export type JevMeetingItemCase = {
  kind: JevMeetingItemKind;
  title: string;
  detail: string;
  counterparty?: string;
  labels: {
    /** Whether the notes really support this item. */
    grounded: boolean;
    /** Whether the action is still outstanding. */
    futureAction: boolean;
    /** Whether it was agreed rather than floated. */
    unconditional: boolean;
    owner: "operator" | "another_person" | "nobody" | "unclear";
    /**
     * Whether this item deserved to exist at all, which is the three above
     * taken together. Written out rather than derived, so the label file says
     * what a human decided instead of what the code would have computed.
     */
    real: boolean;
  };
};

export type JevMeetingCase = {
  id: string;
  split: "dev" | "heldout";
  operator: string;
  title: string;
  attendees: string[];
  notes: string;
  labels: { fragment: boolean };
  items: JevMeetingItemCase[];
};

export function parseJevMeetingCases(value: unknown): JevMeetingCase[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The Jev meeting case file is not an object.");
  }
  const rows = (value as Record<string, unknown>).cases;
  if (!Array.isArray(rows)) throw new Error("The Jev meeting case file has no cases array.");
  return rows.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`Meeting case ${index} is not an object.`);
    }
    const item = row as Record<string, unknown>;
    const labels = item.labels as Record<string, unknown> | undefined;
    if (!labels) throw new Error(`Meeting case ${String(item.id)} has no labels.`);
    if (!Array.isArray(item.items) || item.items.length === 0) {
      throw new Error(`Meeting case ${String(item.id)} proposes no items.`);
    }
    return {
      id: String(item.id),
      split: item.split === "heldout" ? "heldout" : "dev",
      operator: String(item.operator),
      title: String(item.title),
      attendees: Array.isArray(item.attendees) ? item.attendees.map(String) : [],
      notes: String(item.notes),
      labels: { fragment: labels.fragment === true },
      items: item.items.map((entry) => {
        const proposed = entry as Record<string, unknown>;
        const itemLabels = (proposed.labels ?? {}) as Record<string, unknown>;
        return {
          kind: proposed.kind === "waiting_on" ? "waiting_on" : "task",
          title: String(proposed.title),
          detail: String(proposed.detail),
          ...(proposed.counterparty ? { counterparty: String(proposed.counterparty) } : {}),
          labels: {
            grounded: itemLabels.grounded === true,
            futureAction: itemLabels.futureAction === true,
            unconditional: itemLabels.unconditional === true,
            owner: (itemLabels.owner ?? "unclear") as JevMeetingItemCase["labels"]["owner"],
            real: itemLabels.real === true,
          },
        };
      }),
    };
  });
}

export function meetingCaseEvidence(item: JevMeetingCase): JevMeetingEvidence {
  return {
    operator: item.operator,
    title: item.title,
    attendees: item.attendees,
    notes: item.notes,
    items: item.items.map((entry, index) => ({
      index,
      kind: entry.kind,
      title: entry.title,
      detail: entry.detail,
      ...(entry.counterparty ? { counterparty: entry.counterparty } : {}),
    })),
  };
}

export function prepareJevMeetingCases(
  cases: readonly JevMeetingCase[],
): JevPreparedCase[] {
  return cases.map((item) => {
    const plan = planJevMeetingRequest(meetingCaseEvidence(item));
    return {
      id: item.id,
      split: item.split,
      state: plan.state,
      questions: plan.questions,
      requestBytes: plan.requestBytes,
    };
  });
}

export type JevMeetingEvaluationSummary = {
  scored: number;
  byQuestion: Record<string, { correct: number; total: number; rate: number }>;
  /**
   * Items the labels say should never have been created that Jev accepted
   * anyway. This is the failure that matters in this lane, and the mirror of
   * the email lane's dismissed request: a phantom commitment costs the operator
   * attention every day until they delete it by hand.
   */
  acceptedPhantoms: { id: string; title: string }[];
  cases: JevCaseScore[];
};

export function scoreJevMeetingCases(input: {
  cases: readonly JevMeetingCase[];
  answersById: Record<string, Record<string, JevAnswer>>;
  noulThreshold?: number;
}): JevMeetingEvaluationSummary {
  const threshold = input.noulThreshold ?? NOUL_DECISION_THRESHOLD;
  const byQuestion: Record<string, { correct: number; total: number; rate: number }> = {};
  const acceptedPhantoms: JevMeetingEvaluationSummary["acceptedPhantoms"] = [];
  const cases: JevCaseScore[] = [];

  const tally = (question: string, correct: boolean): void => {
    const row = byQuestion[question] ?? { correct: 0, total: 0, rate: 0 };
    row.total += 1;
    if (correct) row.correct += 1;
    row.rate = row.correct / row.total;
    byQuestion[question] = row;
  };

  for (const item of input.cases) {
    const answers = input.answersById[item.id];
    if (!answers) continue;
    const results: JevCaseScore["results"] = [];
    const record = (question: string, expected: string, got: string): void => {
      const correct = expected === got;
      results.push({ question, expected, got, correct });
      tally(question, correct);
    };

    const fragment = answers.notes_fragment;
    if (fragment && fragment.type === "noul") {
      record(
        "notes_fragment",
        String(item.labels.fragment),
        String(fragment.noul >= threshold),
      );
    }

    item.items.forEach((proposed, index) => {
      const noul = (key: string): number | null => {
        const answer = answers[`item_${index}_${key}`];
        return answer && answer.type === "noul" ? answer.noul : null;
      };
      for (const [key, question, expected] of [
        ["grounded", "item_grounded", proposed.labels.grounded],
        ["future_action", "item_future_action", proposed.labels.futureAction],
        ["unconditional", "item_unconditional", proposed.labels.unconditional],
      ] as const) {
        const value = noul(key);
        if (value === null) continue;
        record(question, String(expected), String(value >= threshold));
      }
      // The verdict Cove would actually act on, composed in code from the three
      // atomic halves. Scored against whether the item deserved to exist.
      const composed = composeMeetingItemVerdict({
        grounded: noul("grounded"),
        futureAction: noul("future_action"),
        unconditional: noul("unconditional"),
        threshold,
      });
      if (composed !== null) {
        record("item_real_composed", String(proposed.labels.real), String(composed));
        if (!proposed.labels.real && composed) {
          acceptedPhantoms.push({ id: item.id, title: proposed.title });
        }
      }
      const owner = answers[`item_${index}_owner`];
      if (owner && owner.type === "choice") {
        record("item_owner", proposed.labels.owner, owner.choice);
      }
    });
    cases.push({ id: item.id, split: item.split, results });
  }

  return { scored: cases.length, byQuestion, acceptedPhantoms, cases };
}

export function formatJevMeetingEvaluation(summary: JevMeetingEvaluationSummary): string {
  const lines: string[] = [];
  lines.push(`Scored ${summary.scored} meeting(s).`);
  lines.push("");
  for (const [question, row] of Object.entries(summary.byQuestion).sort()) {
    lines.push(`${question}: ${row.correct} of ${row.total} (${(row.rate * 100).toFixed(1)}%)`);
  }
  lines.push("");
  if (summary.acceptedPhantoms.length === 0) {
    lines.push("No item the meeting never agreed to was accepted.");
  } else {
    lines.push("Accepted an item the meeting never agreed to:");
    for (const phantom of summary.acceptedPhantoms) {
      lines.push(`  ${phantom.id}: ${phantom.title}`);
    }
  }
  const wrong = summary.cases.flatMap((item) =>
    item.results.filter((result) => !result.correct).map((result) => ({ id: item.id, ...result }))
  );
  if (wrong.length > 0) {
    lines.push("");
    lines.push("Every disagreement with the frozen labels:");
    for (const result of wrong) {
      lines.push(
        `  ${result.id} ${result.question}: expected ${result.expected}, got ${result.got}`,
      );
    }
  }
  return lines.join("\n");
}
