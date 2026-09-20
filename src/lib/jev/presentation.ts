/**
 * What the settings screen says about Jev, and the shape it says it about.
 *
 * The wording lives here rather than in the markup so it can be read and tested
 * on its own, and the wire types live here so the browser can hold them without
 * importing a module that opens files. Every import in this file is a type and
 * erases at build time; nothing here touches disk, the database or the network.
 *
 * Every sentence is written for the person who owns the install, not for
 * whoever wrote the lane: no feature keys, no outcome codes, and no environment
 * variable names except where the answer is literally "the key is in that
 * file". A lane that is switched on but cannot call says so plainly, because a
 * switch that looks on while nothing happens is the failure this screen exists
 * to prevent.
 */
import type { JevCredentialStatus } from "./credential";
import type { JevFeature, JevLimits, JevMode } from "./settings";

export type JevBreakerReport = { state: "closed" | "open" | "probe"; until?: string };

export type JevAttemptReport = {
  outcome: string;
  occurredAt: string;
};

export type JevLaneState = {
  feature: JevFeature;
  enabled: boolean;
  /** Switched on, allowed by the mode, and holding a key: it will call. */
  running: boolean;
  breaker?: JevBreakerReport;
  lastAttempt?: JevAttemptReport;
};

export type JevSettingsState = {
  mode: JevMode;
  model: string;
  credential: JevCredentialStatus;
  lanes: JevLaneState[];
  limits: JevLimits;
  /** Absent when the ledger could not be read, which is not an error here. */
  last24h?: { attempts: number; estimatedCostUsd: number };
  csrfToken: string;
};

export const JEV_LANE_COPY: Record<JevFeature, { title: string; description: string }> = {
  emailTriage: {
    title: "Email triage",
    description:
      "A second opinion on each email's bucket, how urgent it is, and whether it needs a reply.",
  },
  commitmentAudit: {
    title: "Commitment audit",
    description:
      "Whether a line Cove pulled out of an email really states an obligation, and whose it is.",
  },
  meetingAudit: {
    title: "Meeting audit",
    description:
      "Whether the tasks and waiting-on rows from a meeting are supported by the notes, and still outstanding.",
  },
  waitingResolution: {
    title: "Waiting-on resolution",
    description:
      "Whether an incoming email delivers something you have been waiting for, or calls it off.",
  },
};

export function credentialMessage(status: JevCredentialStatus): string {
  if (!status.configured) return "No key yet. Nothing calls TypeSafe without one.";
  if (status.source === "environment") {
    return `A key ending ${status.hint} is set in this Mac's .env.local file, and that one wins over anything saved here.`;
  }
  return `A key ending ${status.hint} is saved on this Mac.`;
}

/**
 * One line per lane, in the order that matters: what is stopping it first, then
 * what it last did. The switch itself is not described, because it is drawn
 * next to the sentence.
 */
export function laneStatusMessage(
  lane: JevLaneState,
  context: { mode: JevMode; credentialConfigured: boolean },
): string {
  if (!lane.enabled) return "Off.";
  if (context.mode === "off") return "Switched on, but Jev is stopped, so nothing runs.";
  if (!context.credentialConfigured) {
    return "Switched on, but there is no key yet, so nothing runs.";
  }
  if (lane.breaker?.state === "open") {
    return `Paused after repeated failures. It tries again ${
      lane.breaker.until ? readableClock(lane.breaker.until) : "shortly"
    }.`;
  }
  if (lane.lastAttempt) return `Recording. ${lastAttemptMessage(lane.lastAttempt)}`;
  return "Recording. Nothing has come through it yet.";
}

/**
 * Failure codes are the transport's vocabulary. This is the operator's: what
 * went wrong, and whether it is theirs to fix.
 */
export function lastAttemptMessage(attempt: JevAttemptReport): string {
  const when = readableClock(attempt.occurredAt);
  switch (attempt.outcome) {
    case "ok":
      return `Last call went through ${when}.`;
    case "jev_unauthorized":
      return `TypeSafe rejected the key ${when}. Paste it again below.`;
    case "jev_rate_limited":
      return `TypeSafe was rate limiting ${when}.`;
    case "jev_overloaded":
      return `TypeSafe was overloaded ${when}.`;
    case "jev_timeout":
      return `The last call timed out ${when}.`;
    case "jev_contract":
    case "jev_invalid_response":
    case "jev_request_too_large":
    case "jev_response_too_large":
      return `TypeSafe refused the last request ${when}. That is a bug in Cove, not a setting.`;
    default:
      return `The last call did not go through ${when}.`;
  }
}

function readableClock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return `at ${
    new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date)
  }`;
}
