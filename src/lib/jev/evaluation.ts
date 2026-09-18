/**
 * Offline evaluation for the Jev email lane.
 *
 * Two things have to be possible before Jev touches real mail. Someone has to
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
  buildJevEmailQuestions,
  buildJevEmailState,
  composeCommitmentVerdict,
  type JevEmailEvidence,
} from "./email";
import type { JevAnswer, JevQuestion } from "./client";

export type JevEmailCaseLabels = {
  bucket: "reply" | "action" | "fyi" | "noise";
  urgent: boolean;
  moneyOut: boolean;
  needsReply: boolean;
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
  };
}

/** Builds every request without a credential and without touching the network. */
export function prepareJevEmailCases(cases: readonly JevEmailCase[]): JevPreparedCase[] {
  return cases.map((item) => {
    const evidence = caseEvidence(item);
    const state = buildJevEmailState(evidence);
    const questions = buildJevEmailQuestions({
      evidence,
      triage: true,
      commitmentAudit: (item.commitments ?? []).length > 0,
    });
    return {
      id: item.id,
      split: item.split,
      state,
      questions,
      requestBytes: Buffer.byteLength(
        JSON.stringify({ model: "jev-1.13.0", state, questions }),
        "utf8",
      ),
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
    cases.push({ id: item.id, split: item.split, results });
  }

  return { scored: cases.length, byQuestion, missedRequests, cases };
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
