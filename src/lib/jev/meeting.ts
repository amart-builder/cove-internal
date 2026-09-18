/**
 * Jev's shadow reading of what a meeting produced.
 *
 * Cove's meeting analyst is a frontier call that reads a transcript and writes
 * the meeting summary, the per-contact notes, the tasks and the waiting-on
 * commitments in one pass. The summary and the notes are prose and stay with
 * that model; Jev cannot write and is not being asked to. The tasks and the
 * waiting-on rows are different. Each one is a claim that somebody now owes
 * something, and a claim is a closed judgment.
 *
 * That matters more here than in email. Cove's rule is that every accepted
 * commitment has a reliable path to its next decision, which is a promise about
 * the commitments that exist. A task the meeting never agreed to still gets a
 * due date, a reminder and a place on the board, and the operator pays for it
 * in attention every day until they delete it by hand. The cheapest way to keep
 * that promise is to stop believing commitments that were never made.
 *
 * So this lane asks, of each proposed item, whether the notes actually support
 * it, whether the action is still outstanding, whether it was agreed rather
 * than floated, and who owes it. Nothing here acts. The answers go to the
 * ledger beside what the analyst decided, and the operator sees exactly what
 * they saw before.
 *
 * The same two rules from the vendor's jaggedness page apply as in the email
 * lane: instructions are read literally, so every boundary is written out; and
 * dates and intervals are unreliable, so nothing here asks when an item is due.
 */
import type Database from "better-sqlite3";
import {
  askJev,
  JEV_MAX_REQUEST_BYTES,
  type JevAnswer,
  type JevFetch,
  type JevQuestion,
  type JevResult,
} from "./client";
import { acquireJevLease, releaseJevLease } from "./policy";
import { recordJevAssessments, recordJevAttempt, type JevAssessmentRecord } from "./ledger";
import { JEV_COMPARISON_NOUL_THRESHOLD } from "./email";
import { jevFeatureEnabled, type JevSettings } from "./settings";
import type { CoveEnvironment } from "../env";

/**
 * A transcript is far longer than an email, and Jev's accuracy falls as state
 * grows with material the question does not need. This is a ceiling, not a
 * target: the notes are truncated rather than summarised, because summarising
 * them would mean asking a model to decide what the auditor gets to see.
 */
export const JEV_MEETING_NOTES_LIMIT = 6_000;
export const JEV_MEETING_TITLE_LIMIT = 200;
export const JEV_MEETING_ITEM_LIMIT = 400;
export const JEV_MEETING_NAME_LIMIT = 120;
export const JEV_MAX_MEETING_ATTENDEES = 12;
/** Four questions each, plus the fragment question, inside the 32-question cap. */
export const JEV_MAX_AUDITED_MEETING_ITEMS = 6;

/** Generous on purpose: an unknown call must never look cheaper than it was. */
export const JEV_MEETING_RESERVED_INPUT_TOKENS = 8_000;

export type JevMeetingItemKind = "task" | "waiting_on";

export type JevMeetingItem = {
  /** Stable within this meeting, so an assessment row traces back to an item. */
  index: number;
  kind: JevMeetingItemKind;
  title: string;
  /** The analyst's own description, which is what the operator will read. */
  detail: string;
  /** Present on waiting-on rows: who the analyst says owes it. */
  counterparty?: string;
};

export type JevMeetingEvidence = {
  /** How the operator appears in the notes, so "who owes this" is answerable. */
  operator: string;
  title: string;
  attendees: readonly string[];
  notes: string;
  items: readonly JevMeetingItem[];
};

/**
 * What Cove already decided. The analyst proposed every item, so its baseline
 * for "is this real" is simply yes; the fragment flag is the envelope's own
 * deterministic verdict on whether these notes are a whole meeting.
 */
export type JevMeetingBaseline = {
  fragment: boolean;
};

export function buildJevMeetingState(evidence: JevMeetingEvidence): Record<string, unknown> {
  return {
    operator: evidence.operator.slice(0, JEV_MEETING_NAME_LIMIT),
    meeting_title: evidence.title.slice(0, JEV_MEETING_TITLE_LIMIT),
    attendees: evidence.attendees
      .slice(0, JEV_MAX_MEETING_ATTENDEES)
      .map((name) => name.slice(0, JEV_MEETING_NAME_LIMIT)),
    // Fenced for the same reason as the email body: it marks the untrusted span
    // for readers and for the deterministic guards. Jev is not a security
    // boundary, which is why nothing it says is allowed to act in this mode.
    untrusted_meeting_notes: evidence.notes.slice(0, JEV_MEETING_NOTES_LIMIT),
  };
}

function participants(evidence: JevMeetingEvidence): Record<string, unknown> {
  return {
    operator: evidence.operator.slice(0, JEV_MEETING_NAME_LIMIT),
    attendees: evidence.attendees
      .slice(0, JEV_MAX_MEETING_ATTENDEES)
      .map((name) => name.slice(0, JEV_MEETING_NAME_LIMIT)),
  };
}

const OWNER_CRITERIA: Record<string, Record<string, unknown>> = {
  operator: {
    what: "The operator named in the state owes this. They are the person "
      + "whose assistant is reading these notes.",
    examples: ["The operator said they would send the revised numbers."],
  },
  another_person: {
    what: "Somebody other than the operator owes it, whether or not the notes "
      + "name them clearly.",
    examples: ["A client said they would come back with a decision."],
  },
  nobody: {
    what: "The described thing is not owed by anyone: it is background, an "
      + "observation, or something already finished.",
    not_for: "Work that is owed but whose owner the notes leave open, which is "
      + "unclear.",
  },
  unclear: {
    what: "Something is owed but the notes do not say by whom.",
    not_for: "A case where the owner is obvious from who was speaking.",
  },
};

/**
 * The one question that is asked of the meeting rather than of an item, so it
 * is always present even when no item fits the budget below.
 */
function fragmentQuestion(): JevQuestion {
  // Comparable to the envelope's own fragment heuristic, which today is a
  // length threshold and nothing else. A short but complete set of notes and a
  // long transcript that was cut off both defeat it.
  return {
    type: "noul",
    instructions: {
      question: "Are these notes an incomplete piece of a meeting record rather "
        + "than a whole one?",
      inspect: "untrusted_meeting_notes",
      focus: "Judge completeness, not length. Short notes of a short meeting "
        + "are complete.",
    },
    criteria: {
      true: {
        what: "The notes start or stop mid-thought, cover only part of what "
          + "they say was discussed, or are plainly a continuation of "
          + "something not included.",
        examples: ["The notes end mid-sentence.", "The text begins with a continuation marker."],
      },
      false: {
        what: "The notes read as a complete record of a meeting, however brief.",
        not_for: "Notes that are merely terse.",
      },
    },
  };
}

function itemQuestions(
  item: JevMeetingItem,
  who: Record<string, unknown>,
): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {};
  const proposal = {
    kind: item.kind === "task"
      ? "work the operator would be given"
      : "something the operator is waiting on from somebody else",
    title: item.title.slice(0, JEV_MEETING_ITEM_LIMIT),
    detail: item.detail.slice(0, JEV_MEETING_ITEM_LIMIT),
    ...(item.counterparty
      ? { named_counterparty: item.counterparty.slice(0, JEV_MEETING_NAME_LIMIT) }
      : {}),
  };

  // The one question with no counterpart in the email lane. There, Cove had
  // already proved the quote appears in the source. Here the analyst wrote
  // the item in its own words, so whether the meeting supports it at all is
  // the first thing worth asking.
  questions[`item_${item.index}_grounded`] = {
    type: "noul",
    instructions: {
      question: "Do the meeting notes support this proposed item?",
      proposal,
      inspect: "untrusted_meeting_notes",
      focus: "The wording does not have to match. Ask whether the notes "
        + "contain the thing being described.",
      participants: who,
    },
    criteria: {
      true: {
        what: "The notes describe this thing, in any wording.",
        examples: ["The item says to send a revised quote and the notes say a revised quote was asked for."],
      },
      false: {
        what: "The notes do not contain it, or contain something materially "
          + "different from what the item describes.",
        not_for: "An item that says the same thing in different words.",
        examples: ["The item names a deliverable the notes never mention."],
      },
    },
  };
  questions[`item_${item.index}_future_action`] = {
    type: "noul",
    instructions: {
      question: "Does this item describe an action that still has to happen, "
        + "rather than one the notes say already happened?",
      proposal,
      inspect: "untrusted_meeting_notes",
      focus: "Judge only whether the action remains outstanding. Do not judge "
        + "when it is due.",
    },
    criteria: {
      true: { what: "The action has not happened yet." },
      false: {
        what: "The notes describe the action as already done, including done "
          + "during the meeting itself, or there is no action in the item.",
        examples: ["The notes say the file was shared on the call."],
      },
    },
  };
  questions[`item_${item.index}_unconditional`] = {
    type: "noul",
    instructions: {
      question: "Was this actually agreed to, rather than raised as an option "
        + "or left to somebody's discretion?",
      proposal,
      inspect: "untrusted_meeting_notes",
    },
    criteria: {
      true: {
        what: "Somebody in the notes committed to it plainly.",
        examples: ["We will have the draft to you next week."],
      },
      false: {
        what: "It was floated, offered subject to a condition, deferred to a "
          + "later decision, or softened into an intention.",
        examples: [
          "We could put together a proposal if that would help.",
          "We should probably revisit the pricing at some point.",
        ],
      },
    },
  };
  questions[`item_${item.index}_owner`] = {
    type: "choice",
    instructions: {
      question: "Who owes the thing this item describes?",
      proposal,
      inspect: "untrusted_meeting_notes",
      participants: who,
    },
    criteria: OWNER_CRITERIA,
  };

  return questions;
}

/**
 * What Cove would actually send, and which items it covers.
 *
 * Two ceilings bind here. The question cap is the API's, and the byte cap is
 * the client's. Rather than pick item and field limits that happen to stay
 * under both and hope no real meeting ever exceeds them, this adds items one at
 * a time and stops when the next one would not fit. A meeting that proposes
 * more than fits is audited as far as the budget goes and the rest are named in
 * `dropped`, because an item nobody looked at should be visible as such rather
 * than silently absent. The alternative, a request that is built and then
 * rejected whole for being too large, would audit nothing at all.
 */
export type JevMeetingPlan = {
  state: Record<string, unknown>;
  questions: Record<string, JevQuestion>;
  audited: JevMeetingItem[];
  dropped: JevMeetingItem[];
  requestBytes: number;
};

export function planJevMeetingRequest(
  evidence: JevMeetingEvidence,
  options: { model?: string; maxRequestBytes?: number } = {},
): JevMeetingPlan {
  const model = options.model ?? "jev-1.13.0";
  const budget = options.maxRequestBytes ?? JEV_MAX_REQUEST_BYTES;
  const state = buildJevMeetingState(evidence);
  const who = participants(evidence);
  const questions: Record<string, JevQuestion> = { notes_fragment: fragmentQuestion() };
  const audited: JevMeetingItem[] = [];
  const dropped: JevMeetingItem[] = [];
  const size = (): number =>
    Buffer.byteLength(JSON.stringify({ model, state, questions }), "utf8");

  for (const item of evidence.items) {
    if (audited.length >= JEV_MAX_AUDITED_MEETING_ITEMS) {
      dropped.push(item);
      continue;
    }
    const candidate = itemQuestions(item, who);
    for (const [key, question] of Object.entries(candidate)) questions[key] = question;
    if (size() > budget) {
      for (const key of Object.keys(candidate)) delete questions[key];
      dropped.push(item);
      continue;
    }
    audited.push(item);
  }

  return { state, questions, audited, dropped, requestBytes: size() };
}

/** The questions alone, for callers that only want to read them. */
export function buildJevMeetingQuestions(
  evidence: JevMeetingEvidence,
): Record<string, JevQuestion> {
  return planJevMeetingRequest(evidence).questions;
}

/**
 * Composition lives in code, never in the model. An item is worth accepting
 * only if the notes support it, the action is still outstanding, and it was
 * actually agreed. Any missing half means no verdict rather than a guess.
 */
export function composeMeetingItemVerdict(input: {
  grounded: number | null;
  futureAction: number | null;
  unconditional: number | null;
  threshold?: number;
}): boolean | null {
  const threshold = input.threshold ?? JEV_COMPARISON_NOUL_THRESHOLD;
  const parts = [input.grounded, input.futureAction, input.unconditional];
  if (parts.some((value) => value === null)) return null;
  return parts.every((value) => (value as number) >= threshold);
}

export type JevMeetingAssessment = {
  ran: true;
  model: string;
  latencyMs: number;
  answers: Record<string, JevAnswer>;
  recorded: number;
  /** Items the request could not cover, so a gap is visible rather than quiet. */
  dropped: number;
} | {
  ran: false;
  reason: string;
};

function assessmentRows(input: {
  answers: Record<string, JevAnswer>;
  baseline: JevMeetingBaseline;
  /** Only the items the request actually covered. */
  audited: readonly JevMeetingItem[];
  mode: JevSettings["mode"];
  model: string;
  refId: string;
  occurredAt: string;
}): JevAssessmentRecord[] {
  const rows: JevAssessmentRecord[] = [];
  const push = (
    questionKey: string,
    baseline: string | null,
    agreed: boolean | null,
    detail: Record<string, unknown> = {},
  ): void => {
    const answer = input.answers[questionKey];
    if (!answer) return;
    rows.push({
      feature: "meetingAudit",
      mode: input.mode,
      refKind: "meeting",
      refId: input.refId,
      questionKey,
      answer,
      baseline,
      agreed,
      detail,
      model: input.model,
      occurredAt: input.occurredAt,
    });
  };

  const fragment = input.answers.notes_fragment;
  if (fragment && fragment.type === "noul") {
    push(
      "notes_fragment",
      input.baseline.fragment ? "true" : "false",
      (fragment.noul >= JEV_COMPARISON_NOUL_THRESHOLD) === input.baseline.fragment,
      {
        comparisonThreshold: JEV_COMPARISON_NOUL_THRESHOLD,
        baselineSource: "envelope.fragment",
      },
    );
  }

  for (const item of input.audited) {
    const noul = (key: string): number | null => {
      const answer = input.answers[`item_${item.index}_${key}`];
      return answer && answer.type === "noul" ? answer.noul : null;
    };
    const grounded = noul("grounded");
    const futureAction = noul("future_action");
    const unconditional = noul("unconditional");
    const composed = composeMeetingItemVerdict({ grounded, futureAction, unconditional });
    const shared = {
      kind: item.kind,
      title: item.title.slice(0, 240),
    };
    // The analyst proposed this item, so its baseline is that the item is
    // real. Agreement is whether the notes, read again, still support it.
    push(
      `item_${item.index}_grounded`,
      "true",
      grounded === null ? null : grounded >= JEV_COMPARISON_NOUL_THRESHOLD,
      {
        ...shared,
        comparisonThreshold: JEV_COMPARISON_NOUL_THRESHOLD,
        composedVerdict: composed,
        futureAction,
        unconditional,
      },
    );
    // Diagnostics, recorded with no baseline: the analyst never answered them,
    // so there is nothing honest to score them against. Their job is to explain
    // the headline answer.
    for (const key of ["future_action", "unconditional"] as const) {
      if (noul(key) === null) continue;
      push(`item_${item.index}_${key}`, null, null, shared);
    }
    // A task is work the operator owes; a waiting-on row is work somebody else
    // owes. That is the same distinction the Choice makes, so the two compare.
    const expectedOwner = item.kind === "task" ? "operator" : "another_person";
    const owner = input.answers[`item_${item.index}_owner`];
    push(
      `item_${item.index}_owner`,
      expectedOwner,
      owner && owner.type === "choice" ? owner.choice === expectedOwner : null,
      { ...shared, ...(item.counterparty ? { counterparty: item.counterparty } : {}) },
    );
  }

  return rows;
}

/**
 * Asks Jev about one analysed meeting and records what came back.
 *
 * Called from the meeting analysis sweep, which is a durable job with a lease,
 * a retry count and a visible failure inbox. Every path returns a reason rather
 * than throwing, and the lease is released whatever happens.
 */
export async function assessMeetingWithJev(input: {
  db: Database.Database;
  settings: JevSettings;
  evidence: JevMeetingEvidence;
  baseline: JevMeetingBaseline;
  /** The analysis job id, so an assessment traces back to its meeting. */
  refId: string;
  apiKey: string;
  env?: CoveEnvironment;
  now?: () => Date;
  fetchImpl?: JevFetch;
  askImpl?: typeof askJev;
}): Promise<JevMeetingAssessment> {
  const env = input.env ?? process.env;
  const now = input.now ?? (() => new Date());
  if (!jevFeatureEnabled(input.settings, "meetingAudit", env)) {
    return { ran: false, reason: "Jev is not enabled for meetings." };
  }
  if (input.evidence.items.length === 0) {
    return { ran: false, reason: "The meeting proposed nothing to audit." };
  }

  const plan = planJevMeetingRequest(input.evidence, { model: input.settings.model });
  if (plan.audited.length === 0) {
    return { ran: false, reason: "No meeting item fit inside one Jev request." };
  }
  const lease = acquireJevLease({
    db: input.db,
    feature: "meetingAudit",
    limits: input.settings.limits,
    now: now(),
    reservedInputTokens: JEV_MEETING_RESERVED_INPUT_TOKENS,
  });
  if (!lease.allowed) return { ran: false, reason: lease.detail };

  let result: JevResult;
  try {
    result = await (input.askImpl ?? askJev)({
      state: plan.state,
      questions: plan.questions,
      model: input.settings.model,
    }, { apiKey: input.apiKey, fetchImpl: input.fetchImpl });
  } catch (error) {
    releaseJevLease();
    const detail = error instanceof Error ? error.message : String(error);
    recordJevAttempt({
      db: input.db,
      feature: "meetingAudit",
      outcome: "jev_transient",
      reservedInputTokens: JEV_MEETING_RESERVED_INPUT_TOKENS,
      latencyMs: 0,
      occurredAt: now().toISOString(),
    });
    return { ran: false, reason: `The Jev call failed: ${detail.slice(0, 200)}` };
  }
  releaseJevLease();

  const occurredAt = now().toISOString();
  recordJevAttempt({
    db: input.db,
    feature: "meetingAudit",
    outcome: result.ok ? "ok" : result.error.code,
    status: result.ok ? undefined : result.error.status,
    usage: result.ok ? result.usage : undefined,
    reservedInputTokens: JEV_MEETING_RESERVED_INPUT_TOKENS,
    latencyMs: result.latencyMs,
    model: result.ok ? result.model : undefined,
    occurredAt,
  });
  if (!result.ok) return { ran: false, reason: result.error.message };

  const rows = assessmentRows({
    answers: result.answers,
    baseline: input.baseline,
    audited: plan.audited,
    mode: input.settings.mode,
    model: result.model,
    refId: input.refId,
    occurredAt,
  });
  const recorded = recordJevAssessments({ assessments: rows, db: input.db });
  return {
    ran: true,
    model: result.model,
    latencyMs: result.latencyMs,
    answers: result.answers,
    recorded,
    dropped: plan.dropped.length,
  };
}
