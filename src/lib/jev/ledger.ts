/**
 * Jev attempt ledger in the main Cove database (migration 37).
 *
 * Every attempt is a row, including crashes: a row is reserved inside an
 * immediate transaction before any network call, and settled afterwards. A
 * reservation whose lease expires without a settlement is counted as
 * unavailable when it is next seen, so a crash never leaks a concurrency slot
 * or hides a failure. Budgets (per hour, per day) and the concurrency cap are
 * enforced from the rows themselves, so several Cove processes share them.
 *
 * Control rows (`kind = 'probe'`) exist for the breaker and are excluded from
 * assessment-quality counts. Two small state keys live in cove_jev_state:
 * `cooldown_until` (breaker) and `auth_blocked` (401/403 until the credential
 * revision changes). Neither the key nor any evidence text is stored here:
 * only hashes, references, answers and usage.
 */
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type { JevAnswer } from "./client";
import type { JevFeature, JevFeatureMode, JevLimits } from "./settings";

export const JEV_LEDGER_SCHEMA = `
  CREATE TABLE cove_jev_attempts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('assessment','probe')),
    feature TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('shadow','assist')),
    lane TEXT NOT NULL,
    parent_ref TEXT,
    subject_kind TEXT,
    subject_id TEXT,
    subject_version TEXT,
    evidence_hash TEXT NOT NULL,
    question_hash TEXT NOT NULL,
    reuse_key TEXT,
    policy_version INTEGER NOT NULL,
    requested_model TEXT NOT NULL,
    resolved_model TEXT,
    request_bytes INTEGER NOT NULL,
    response_bytes INTEGER,
    status TEXT NOT NULL CHECK(status IN ('reserved','answered','unavailable','invalid','budget_deferred','superseded')),
    reason TEXT,
    http_status INTEGER,
    request_id TEXT,
    answers_json TEXT,
    started_at INTEGER NOT NULL,
    lease_until INTEGER NOT NULL,
    finished_at INTEGER,
    latency_ms INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER
  );
  CREATE INDEX cove_jev_attempts_started ON cove_jev_attempts(started_at);
  CREATE INDEX cove_jev_attempts_reuse ON cove_jev_attempts(reuse_key, started_at) WHERE reuse_key IS NOT NULL;
  CREATE TABLE cove_jev_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

export type JevAttemptStatus = "reserved" | "answered" | "unavailable" | "invalid" | "budget_deferred" | "superseded";
export const JEV_POLICY_VERSION = 1;
const HOUR = 3_600_000, DAY = 86_400_000;
const BREAKER_WINDOW_MS = 10 * 60_000, BREAKER_FAILURES = 5, BREAKER_COOLDOWN_MS = 5 * 60_000;
// Retention from the agreed plan: answer detail 30 days, usage metadata 90 days.
export const JEV_ANSWER_RETENTION_MS = 30 * DAY;
export const JEV_ATTEMPT_RETENTION_MS = 90 * DAY;

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Stable JSON so the same evidence and questions always hash the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export type JevReservation = {
  kind?: "assessment" | "probe";
  feature: JevFeature;
  mode: Exclude<JevFeatureMode, "off">;
  lane: string;
  parentRef?: string;
  subject?: { kind: string; id: string; version?: string };
  evidenceHash: string;
  questionHash: string;
  reuseKey?: string;
  requestBytes: number;
  requestedModel: string;
  limits: JevLimits;
  credentialRevision: string;
  now: number;
};

export type JevReserveOutcome =
  | { ok: true; id: string }
  | { ok: false; status: "budget_deferred"; retryAt: number }
  | { ok: false; status: "unavailable"; reason: "busy" | "cooldown" | "auth_blocked"; retryAt?: number };

function readState(db: Database.Database, key: string): string | undefined {
  return db.prepare("SELECT value FROM cove_jev_state WHERE key = ?").pluck().get(key) as string | undefined;
}

function writeState(db: Database.Database, key: string, value: string | null, now: number): void {
  if (value === null) db.prepare("DELETE FROM cove_jev_state WHERE key = ?").run(key);
  else db.prepare("INSERT INTO cove_jev_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(key, value, now);
}

/** Reservations whose lease lapsed without a settlement: the process died. */
export function expireJevLeases(db: Database.Database, now: number): number {
  return db.prepare("UPDATE cove_jev_attempts SET status = 'unavailable', reason = 'lease_expired', finished_at = ? WHERE status = 'reserved' AND lease_until < ?").run(now, now).changes;
}

/** Reserve budget and a concurrency slot atomically. No network in here. */
export function reserveJevAttempt(db: Database.Database, input: JevReservation): JevReserveOutcome {
  const { now, limits } = input;
  return db.transaction((): JevReserveOutcome => {
    expireJevLeases(db, now);
    const blocked = readState(db, "auth_blocked");
    if (blocked && blocked === input.credentialRevision) return { ok: false, status: "unavailable", reason: "auth_blocked" };
    if (blocked) writeState(db, "auth_blocked", null, now); // The key changed; try again.
    const cooldown = Number(readState(db, "cooldown_until") ?? 0);
    if (cooldown > now) return { ok: false, status: "unavailable", reason: "cooldown", retryAt: cooldown };
    const active = db.prepare("SELECT COUNT(*) FROM cove_jev_attempts WHERE status = 'reserved'").pluck().get() as number;
    if (active >= limits.concurrency) return { ok: false, status: "unavailable", reason: "busy", retryAt: now + limits.totalTimeoutMs };
    const starts = db.prepare("SELECT started_at FROM cove_jev_attempts WHERE started_at > ? AND status <> 'budget_deferred' ORDER BY started_at").pluck().all(now - DAY) as number[];
    const retryAts: number[] = [];
    for (const [limit, window] of [[limits.callsPerHour, HOUR], [limits.callsPerDay, DAY]] as const) {
      const recent = starts.filter((t) => t > now - window);
      if (recent.length >= limit) retryAts.push(recent[recent.length - limit] + window + 1);
    }
    const id = randomUUID();
    if (retryAts.length) {
      const retryAt = Math.max(...retryAts);
      insert(db, input, id, "budget_deferred", now, `retry_at=${retryAt}`);
      return { ok: false, status: "budget_deferred", retryAt };
    }
    insert(db, input, id, "reserved", now + limits.totalTimeoutMs + 5_000, null);
    return { ok: true, id };
  }).immediate();
}

function insert(db: Database.Database, input: JevReservation, id: string, status: JevAttemptStatus, leaseUntil: number, reason: string | null): void {
  db.prepare(`INSERT INTO cove_jev_attempts (id, kind, feature, mode, lane, parent_ref, subject_kind, subject_id, subject_version, evidence_hash, question_hash,
    reuse_key, policy_version, requested_model, request_bytes, status, reason, started_at, lease_until, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, input.kind ?? "assessment", input.feature, input.mode, input.lane, input.parentRef ?? null,
    input.subject?.kind ?? null, input.subject?.id ?? null, input.subject?.version ?? null,
    input.evidenceHash, input.questionHash, input.reuseKey ?? null, JEV_POLICY_VERSION, input.requestedModel, input.requestBytes,
    status, reason, input.now, leaseUntil, status === "reserved" ? null : input.now,
  );
}

export type JevSettlement =
  | { status: "answered"; answers: Record<string, JevAnswer>; resolvedModel: string; latencyMs: number; responseBytes: number; requestId?: string; inputTokens: number; outputTokens: number }
  | { status: "unavailable" | "invalid"; reason: string; httpStatus?: number; requestId?: string; latencyMs?: number; retryAfterMs?: number; credentialRevision?: string };

/** Settle exactly once. A settlement for a row that is no longer reserved
 * (lease expired and reclaimed) is ignored rather than double-counted. */
export function settleJevAttempt(db: Database.Database, id: string, outcome: JevSettlement, now: number): boolean {
  return db.transaction((): boolean => {
    const row = db.prepare("SELECT status, kind FROM cove_jev_attempts WHERE id = ?").get(id) as { status: string; kind: string } | undefined;
    if (!row || row.status !== "reserved") return false;
    if (outcome.status === "answered") {
      db.prepare(`UPDATE cove_jev_attempts SET status = 'answered', resolved_model = ?, answers_json = ?, finished_at = ?, latency_ms = ?, response_bytes = ?, request_id = ?, input_tokens = ?, output_tokens = ?, http_status = 200 WHERE id = ?`)
        .run(outcome.resolvedModel, JSON.stringify(outcome.answers), now, outcome.latencyMs, outcome.responseBytes, outcome.requestId ?? null, outcome.inputTokens, outcome.outputTokens, id);
      return true;
    }
    db.prepare(`UPDATE cove_jev_attempts SET status = ?, reason = ?, finished_at = ?, latency_ms = ?, http_status = ?, request_id = ? WHERE id = ?`)
      .run(outcome.status, outcome.reason, now, outcome.latencyMs ?? null, outcome.httpStatus ?? null, outcome.requestId ?? null, id);
    if (outcome.reason === "auth" && outcome.credentialRevision) writeState(db, "auth_blocked", outcome.credentialRevision, now);
    if (outcome.reason === "rate_limited" || outcome.reason === "transient") {
      const longer = outcome.retryAfterMs && outcome.retryAfterMs > BREAKER_COOLDOWN_MS ? now + outcome.retryAfterMs : undefined;
      const failures = db.prepare("SELECT COUNT(*) FROM cove_jev_attempts WHERE status = 'unavailable' AND reason IN ('rate_limited','transient','lease_expired') AND finished_at > ?").pluck().get(now - BREAKER_WINDOW_MS) as number;
      if (longer || failures >= BREAKER_FAILURES) {
        const until = Math.max(longer ?? 0, failures >= BREAKER_FAILURES ? now + BREAKER_COOLDOWN_MS : 0, Number(readState(db, "cooldown_until") ?? 0));
        writeState(db, "cooldown_until", String(until), now);
      }
    }
    return true;
  }).immediate();
}

/** Exact-key reuse: same subject, evidence, questions, model, policy and scope.
 * Time-relative judgments must not pass a reuse key (plan: no urgency caching). */
export function findReusableJevAnswer(db: Database.Database, reuseKey: string, now: number, freshnessMs?: number): { id: string; answers: Record<string, JevAnswer> } | undefined {
  const row = db.prepare("SELECT id, answers_json, finished_at FROM cove_jev_attempts WHERE reuse_key = ? AND status = 'answered' AND answers_json IS NOT NULL AND policy_version = ? ORDER BY finished_at DESC LIMIT 1")
    .get(reuseKey, JEV_POLICY_VERSION) as { id: string; answers_json: string; finished_at: number } | undefined;
  if (!row) return undefined;
  if (freshnessMs !== undefined && row.finished_at < now - freshnessMs) return undefined;
  return { id: row.id, answers: JSON.parse(row.answers_json) as Record<string, JevAnswer> };
}

/** Retention: drop answer detail after 30 days and whole rows after 90. */
export function pruneJevLedger(db: Database.Database, now: number): { answersCleared: number; rowsDeleted: number } {
  const answersCleared = db.prepare("UPDATE cove_jev_attempts SET answers_json = NULL WHERE answers_json IS NOT NULL AND started_at < ?").run(now - JEV_ANSWER_RETENTION_MS).changes;
  const rowsDeleted = db.prepare("DELETE FROM cove_jev_attempts WHERE started_at < ? AND status <> 'reserved'").run(now - JEV_ATTEMPT_RETENTION_MS).changes;
  return { answersCleared, rowsDeleted };
}

/** Operator-facing summary. Contains counts and reasons only. */
export function readJevLedgerSummary(db: Database.Database, now: number): {
  hour: { attempts: number; answered: number }; day: { attempts: number; answered: number };
  authBlocked: boolean; cooldownUntil: number | null; recent: Array<{ feature: string; mode: string; lane: string; status: string; reason: string | null; startedAt: number; latencyMs: number | null }>;
} {
  const window = (since: number) => db.prepare("SELECT COUNT(*) AS attempts, SUM(CASE WHEN status = 'answered' THEN 1 ELSE 0 END) AS answered FROM cove_jev_attempts WHERE kind = 'assessment' AND started_at > ?").get(since) as { attempts: number; answered: number | null };
  const h = window(now - HOUR), d = window(now - DAY);
  const cooldown = Number(readState(db, "cooldown_until") ?? 0);
  return {
    hour: { attempts: h.attempts, answered: h.answered ?? 0 }, day: { attempts: d.attempts, answered: d.answered ?? 0 },
    authBlocked: readState(db, "auth_blocked") !== undefined, cooldownUntil: cooldown > now ? cooldown : null,
    recent: db.prepare("SELECT feature, mode, lane, status, reason, started_at AS startedAt, latency_ms AS latencyMs FROM cove_jev_attempts ORDER BY started_at DESC LIMIT 20").all() as ReturnType<typeof readJevLedgerSummary>["recent"],
  };
}
