/**
 * The one place a model- or pipeline-written card title is made readable.
 *
 * Every lane that writes a card (planner, meeting analyst, intake triage, the
 * meeting follow-up bundle, the triage fallback, accepted suggestions) is told
 * how a title should read. On 2026-09-25 the board still carried titles like
 * "Use Monday's existing reminder to review Kia's booking status ...",
 * "Prepare Porter Grieve's proposal for Alex's approval" and
 * "Follow ups: Notes: “Zac Bright and Edge AI” Aug 5, 2026". The prompts say
 * what a title is; this is the guarantee for the shapes that kept coming back.
 *
 * The convention: the move the operator makes, verb first, the object and the
 * person, short enough to read at a glance. Nothing about Cove's own records,
 * reminders or approvals, no date (the card shows it), no trailing period.
 *
 * Only machine-written titles pass through here. A title the operator typed
 * is theirs and is never rewritten.
 */

export const CARD_TITLE_MAX = 80;
/** Above this length a trailing explanatory clause is dropped. */
const CLAUSE_CUT_AT = 60;

const MONTH_DATE = /\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? \d{1,2}(?:, \d{4})?$/;

function meetingBundleTitle(label: string): string {
  const meeting = label
    .replace(/^Notes:\s*/i, "")
    .replace(/[“”"]/g, "")
    .replace(MONTH_DATE, "")
    .trim();
  return meeting ? `Work through follow-ups from ${meeting}` : "Work through meeting follow-ups";
}

/** Phrases that describe Cove's bookkeeping, not the operator's move. */
function stripBookkeeping(title: string): string {
  return title
    .replace(/[\s.;:,]+$/, "")
    // "Alex, first verify ..." -> "verify ...": the card is already theirs.
    .replace(/^[A-Z][\w’'-]*,\s+(?:first\s+|now\s+|please\s+)?(?=[a-z])/, "")
    // "Use Monday's existing reminder to review Kia's ..." -> "review Kia's ..."
    .replace(/^(?:use|reuse)\s+(?:the\s+|[\w’']+['’]s\s+)?(?:existing|saved|current|recorded)\s+(?:\w+\s+)?(?:reminder|task|check|record|card)\s+to\s+/i, "")
    // "... alongside Kia's existing Monday reminder", "..., using the current booking"
    .replace(/,?\s+(?:alongside|using|reusing|via|against)\s+(?:the\s+|[\w’']+['’]s\s+)?(?:existing|saved|current|recorded)\b.*$/i, "")
    .replace(/\s+for\s+(?:your\s+)?own\s+send$/i, "")
    // "Prepare X for Alex's approval" -> "Approve X": the operator's move is the approval.
    .replace(
      /^(?:prepare|draft)\s+(.+?)\s+for\s+(?:[A-Z][\w’']*['’]s\s+|your\s+|the\s+operator['’]s\s+)?approval$/i,
      "Approve $1",
    );
}

/** Drop a trailing explanatory clause from a long title. */
function firstClause(title: string): string {
  if (title.length <= CLAUSE_CUT_AT) return title;
  const match = title.match(
    /^(.+?),\s+(?:\w+ing|then|so|because|since|before|after|while|with|which|starting|alongside)\b/,
  );
  const head = match?.[1];
  return head && head.split(/\s+/).length >= 3 ? head : title;
}

/** Keep only the first sentence of pasted prose ("X. Due today, ... Alex wants thi"). */
function firstSentence(title: string): string {
  const match = title.match(/^(.+?[a-z0-9)])[.!?]\s+[A-Z]/);
  const head = match?.[1];
  return head && head.split(/\s+/).length >= 3 ? head : title;
}

function capWords(title: string): string {
  if (title.length <= CARD_TITLE_MAX) return title;
  const cut = title.slice(0, CARD_TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 20 ? cut.slice(0, space) : cut).replace(/[\s,;:–—-]+$/, "")}…`;
}

export function cardTitle(raw: string): string {
  let title = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!title) return title;
  const bundle = title.match(/^Follow ups:\s*(.*)$/i);
  if (bundle) return capWords(meetingBundleTitle(bundle[1]));
  title = firstSentence(title);
  title = stripBookkeeping(title);
  title = firstClause(title);
  title = title.replace(/[\s.;:,]+$/, "").trim();
  if (!title) return String(raw).trim();
  return capWords(title.charAt(0).toUpperCase() + title.slice(1));
}
