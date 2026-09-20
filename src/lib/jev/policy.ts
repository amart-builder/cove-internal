/**
 * Whether a Jev call is allowed to happen at all.
 *
 * Cove's model lanes are background work on someone's laptop. A service that
 * starts failing, or a loop that starts calling, must cost a bounded amount and
 * then stop on its own. Every ceiling here is read from the attempt ledger, so
 * a restart does not hand the day a fresh budget.
 *
 * The gate runs before the call and never inside a database transaction, which
 * is what keeps a slow network from holding a SQLite write lock.
 */
import type Database from "better-sqlite3";
import { readJevSpendSince } from "./ledger";
import { estimateJevCostUsd, type JevFeature, type JevLimits } from "./settings";

/** Five transient failures inside this window trip the breaker. */
export const JEV_BREAKER_WINDOW_MS = 10 * 60 * 1000;
export const JEV_BREAKER_FAILURE_THRESHOLD = 5;
/** After tripping, nothing calls for this long, then exactly one probe goes. */
export const JEV_BREAKER_COOLDOWN_MS = 5 * 60 * 1000;
/**
 * After a rejected credential, nothing calls for this long, then one probe
 * goes. The probe is what notices that the key was fixed: the gate cannot see
 * the environment change on its own, and a lock with no probe would hold until
 * the attempt row aged out of the ledger months later.
 */
export const JEV_CREDENTIAL_COOLDOWN_MS = 60 * 60 * 1000;

export type JevPolicyDecision =
  | { allowed: true; reservedInputTokens: number }
  | { allowed: false; reason: JevPolicyBlock; detail: string };

export type JevPolicyBlock =
  | "credential_rejected"
  | "breaker_open"
  | "hourly_limit"
  | "daily_limit"
  | "spend_limit"
  | "concurrency";

type AttemptRow = { outcome: string; created_at: string };

/**
 * Failures a retry cannot fix. A rejected credential is configuration, so the
 * lane stays down for a cooldown rather than re-testing a key that is still
 * wrong on every email, and then probes once an hour so a corrected key is
 * picked up without anyone clearing the ledger by hand.
 */
function isCredentialFault(outcome: string): boolean {
  return outcome === "jev_unauthorized";
}

function isTransientFault(outcome: string): boolean {
  return outcome === "jev_transient" || outcome === "jev_timeout" ||
    outcome === "jev_overloaded" || outcome === "jev_rate_limited";
}

export type JevBreakerState =
  | { state: "closed" }
  | { state: "open"; until: string }
  | { state: "probe" };

/**
 * Reads the breaker from recent attempts rather than a separate state row, so
 * there is one source of truth and nothing to leave stale after a crash.
 */
export function readJevBreaker(input: {
  db: Database.Database;
  feature: JevFeature;
  now: Date;
}): JevBreakerState {
  const since = new Date(input.now.getTime() - JEV_BREAKER_WINDOW_MS).toISOString();
  const rows = input.db.prepare(
    `SELECT outcome, created_at FROM cove_jev_attempts
      WHERE feature = ? AND created_at >= ?
      ORDER BY created_at DESC, id DESC LIMIT 40`,
  ).all(input.feature, since) as AttemptRow[];
  if (rows.length === 0) return { state: "closed" };

  // A success inside the window clears the count: the service is answering.
  const failures: AttemptRow[] = [];
  for (const row of rows) {
    if (row.outcome === "ok") break;
    if (isTransientFault(row.outcome)) failures.push(row);
    else break;
  }
  if (failures.length < JEV_BREAKER_FAILURE_THRESHOLD) return { state: "closed" };

  const trippedAt = new Date(failures[0].created_at).getTime();
  const reopenAt = trippedAt + JEV_BREAKER_COOLDOWN_MS;
  if (input.now.getTime() < reopenAt) {
    return { state: "open", until: new Date(reopenAt).toISOString() };
  }
  return { state: "probe" };
}

/** In-process lease count, so two background jobs cannot both fan out at once. */
let inFlight = 0;

export function jevInFlight(): number {
  return inFlight;
}

export function releaseJevLease(): void {
  inFlight = Math.max(0, inFlight - 1);
}

/** Only for tests, which must not inherit a leaked lease from a prior case. */
export function resetJevLeases(): void {
  inFlight = 0;
}

/**
 * Decides, and on a yes takes the lease. The caller must always release it,
 * including on failure, or the next call will be refused for concurrency.
 */
export function acquireJevLease(input: {
  db: Database.Database;
  feature: JevFeature;
  limits: JevLimits;
  now: Date;
  /** Tokens to reserve when usage does not come back. */
  reservedInputTokens: number;
}): JevPolicyDecision {
  const latest = input.db.prepare(
    `SELECT outcome, created_at FROM cove_jev_attempts
      WHERE feature = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(input.feature) as AttemptRow | undefined;
  let credentialProbe = false;
  if (latest && isCredentialFault(latest.outcome)) {
    const retryAt = new Date(latest.created_at).getTime() + JEV_CREDENTIAL_COOLDOWN_MS;
    if (input.now.getTime() < retryAt) {
      return {
        allowed: false,
        reason: "credential_rejected",
        detail: "TypeSafe rejected the credential. Fix the key; Jev retries it once " +
          `an hour, next at ${new Date(retryAt).toISOString()}.`,
      };
    }
    credentialProbe = true;
  }

  const breaker = readJevBreaker({ db: input.db, feature: input.feature, now: input.now });
  if (breaker.state === "open") {
    return {
      allowed: false,
      reason: "breaker_open",
      detail: `Jev is paused after repeated failures until ${breaker.until}.`,
    };
  }
  // A probe is one call, so it must not share the window with anything else.
  const probing = breaker.state === "probe" || credentialProbe;
  const concurrencyCeiling = probing ? 1 : input.limits.maxConcurrent;
  if (inFlight >= concurrencyCeiling) {
    return {
      allowed: false,
      reason: "concurrency",
      detail: `Jev already has ${inFlight} call(s) in flight.`,
    };
  }

  const hourAgo = new Date(input.now.getTime() - 60 * 60 * 1000).toISOString();
  const hour = readJevSpendSince({ since: hourAgo, db: input.db });
  if (hour.attempts >= input.limits.attemptsPerHour) {
    return {
      allowed: false,
      reason: "hourly_limit",
      detail: `Jev reached its hourly ceiling of ${input.limits.attemptsPerHour} attempts.`,
    };
  }

  const dayAgo = new Date(input.now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const day = readJevSpendSince({ since: dayAgo, db: input.db });
  if (day.attempts >= input.limits.attemptsPerDay) {
    return {
      allowed: false,
      reason: "daily_limit",
      detail: `Jev reached its daily ceiling of ${input.limits.attemptsPerDay} attempts.`,
    };
  }

  // Reserve before calling. The estimate is Cove's own ceiling on its own
  // spend and is not a claim about what TypeSafe will invoice.
  const projected = day.estimatedCostUsd + estimateJevCostUsd(input.reservedInputTokens);
  if (projected > input.limits.dailySpendUsd) {
    return {
      allowed: false,
      reason: "spend_limit",
      detail: `Jev reached its daily reservation ceiling of $${input.limits.dailySpendUsd}.`,
    };
  }

  inFlight += 1;
  return { allowed: true, reservedInputTokens: input.reservedInputTokens };
}
