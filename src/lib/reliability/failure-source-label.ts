/**
 * What to call the part of Cove a failure came from, on a screen a person reads.
 *
 * The inbox's rows are keyed by internal source names. Title-casing an unmapped
 * one turned `meeting-analysis-degraded` into "Meeting Analysis Degraded" on the
 * Issues page, which is an internal identifier wearing a hat. An unrecognised
 * source is, from where the reader sits, something Cove was doing in the
 * background, so say that instead and let the row's own sentence carry the
 * detail.
 */
const FAILURE_SOURCE_LABELS: Record<string, string> = {
  receipt: "Recent activity",
  job: "Background work",
  scheduler: "Background work",
  "meeting-intake": "Meeting notes",
  "meeting-watch": "Meeting notes",
  "meeting-analysis-degraded": "Meeting notes",
  "email-triage": "Inbox check",
  "email-triage-contact-resolution": "Inbox check",
  "reminder-delivery": "Reminder delivery",
  "stale-task-watchdog": "Old task check",
};

export const UNKNOWN_FAILURE_SOURCE_LABEL = "Background work";

export function failureSourceLabel(value: string): string {
  return FAILURE_SOURCE_LABELS[value] ?? UNKNOWN_FAILURE_SOURCE_LABEL;
}
