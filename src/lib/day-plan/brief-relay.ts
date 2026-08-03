import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import {
  MORNING_BRIEF_PROMPT_VERSION,
  MORNING_BRIEF_SCHEMA_VERSION,
  localDateInTimezone,
  morningBriefFromArtifact,
  morningBriefWriterFromJson,
  type MorningBriefArtifact,
} from "./brief";
import type { DaySnapshot } from "./types";
import type { DayPlanStore } from "./store";
import { coveDataDir } from "../operator";
import { coveEnv } from "../env";

export { coveDataDir } from "../operator";

// The cross-machine relay moves immutable brief artifacts and a bounded
// settlement summary as write-once JSON files inside the operator's Syncthing mesh. No
// SQLite file is ever shared. Every path here is fail-open: a filesystem defect
// logs one line and degrades to the deterministic arrival, never a throw that
// blocks generation or the ritual.

export const BRIEF_RELAY_VERSION = 1;
// A relay file larger than this is rejected before it is read: a well-formed
// artifact is a few KB, so a megabyte is already pathological.
export const MAX_RELAY_FILE_BYTES = 1024 * 1024;
// A remote running attempt older than this is treated as dead (the generating
// machine likely slept or crashed), so the MBP backfill stops waiting on it.
export const REMOTE_ATTEMPT_TTL_MS = 15 * 60 * 1000;
// How stale a source checkpoint may be before the Mini refuses to generate.
export const SOURCE_CHECKPOINT_MAX_AGE_MS = 26 * 60 * 60 * 1000;
// Cross-machine timestamps are only trusted within this future-skew allowance.
// A peer whose clock runs fast must not extend attempt liveness, keep a source
// checkpoint "fresh" past its window, or land an artifact that outranks every
// honest one on a future finished_at.
export const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;

// Only these exact filenames are considered; anything else (including any
// Syncthing sync-conflict copy) is skipped without a read.
const RELAY_FILE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}-[A-Za-z0-9._-]+\.json$/;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function logLine(log: ((message: string) => void) | undefined, message: string): void {
  (log ?? ((line: string) => console.error(line)))(message);
}

function briefRelayDir(dataDir?: string): string {
  return path.join(coveDataDir(dataDir), "brief-relay");
}

function statusRelayDir(dataDir?: string): string {
  return path.join(briefRelayDir(dataDir), "status");
}

function settlementRelayPath(dataDir?: string): string {
  return path.join(coveDataDir(dataDir), "settlement-relay", "latest.json");
}

function sourceCheckpointPath(dataDir?: string): string {
  return path.join(coveDataDir(dataDir), "source-checkpoint.json");
}

// Atomic write via a same-directory temp file + rename. Optional write-once:
// when the final path already exists it is left untouched (artifact + status
// files are immutable; the settlement/checkpoint files overwrite).
function atomicWrite(
  finalPath: string,
  payload: string,
  options: { writeOnce: boolean; log?: (message: string) => void },
): boolean {
  const dir = path.dirname(finalPath);
  if (options.writeOnce && existsSync(finalPath)) return false;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(dir, `.${path.basename(finalPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmpPath, payload, { mode: 0o600 });
    // Re-check under write-once just before commit to narrow the race; identical
    // content makes an accidental double-write harmless regardless.
    if (options.writeOnce && existsSync(finalPath)) {
      rmSync(tmpPath, { force: true });
      return false;
    }
    renameSync(tmpPath, finalPath);
    return true;
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Artifact relay envelope.
// ---------------------------------------------------------------------------

export type BriefRelayEnvelope = {
  id: string;
  target_local_date: string;
  status: "succeeded";
  input_hash: string;
  prompt_version: number;
  schema_version: number;
  source_manifest_json: string | null;
  model_alias: string;
  effort: string;
  budget_usd: number;
  brief_json: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  relay_version: number;
  origin_host: string;
  checksum: string;
};

// The checksum covers exactly the immutable artifact content — never the
// transport fields (relay_version, origin_host, checksum). Two machines that
// materialize the same artifact produce the same canonical string and hash.
function canonicalArtifactString(fields: {
  id: string;
  target_local_date: string;
  input_hash: string;
  prompt_version: number;
  schema_version: number;
  source_manifest_json: string | null;
  model_alias: string;
  effort: string;
  budget_usd: number;
  brief_json: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}): string {
  return JSON.stringify([
    fields.id,
    fields.target_local_date,
    "succeeded",
    fields.input_hash,
    fields.prompt_version,
    fields.schema_version,
    fields.source_manifest_json,
    fields.model_alias,
    fields.effort,
    fields.budget_usd,
    fields.brief_json,
    fields.created_at,
    fields.started_at,
    fields.finished_at,
  ]);
}

function envelopeFromArtifact(
  artifact: MorningBriefArtifact,
  originHost: string,
): BriefRelayEnvelope | undefined {
  if (
    artifact.status !== "succeeded" ||
    !artifact.briefJson ||
    !artifact.inputHash ||
    // Import validation requires a real finish time (a succeeded artifact
    // always has one); refuse to mint a file the peer would reject.
    !artifact.finishedAt
  ) {
    return undefined;
  }
  const base = {
    id: artifact.id,
    target_local_date: artifact.targetLocalDate,
    input_hash: artifact.inputHash,
    prompt_version: artifact.promptVersion,
    schema_version: artifact.schemaVersion,
    source_manifest_json: artifact.sourceManifest
      ? JSON.stringify(artifact.sourceManifest)
      : null,
    model_alias: artifact.modelAlias,
    effort: artifact.effort,
    budget_usd: artifact.budgetUsd,
    brief_json: artifact.briefJson,
    created_at: artifact.createdAt,
    started_at: artifact.startedAt ?? null,
    finished_at: artifact.finishedAt ?? null,
  };
  return {
    ...base,
    status: "succeeded",
    relay_version: BRIEF_RELAY_VERSION,
    origin_host: originHost,
    checksum: sha256(canonicalArtifactString(base)),
  };
}

function relayFileName(envelope: BriefRelayEnvelope): string {
  return `${envelope.target_local_date}-${envelope.origin_host}-${envelope.id}.json`;
}

function sanitizeHostForFilename(host: string): string {
  const cleaned = host.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40);
  return cleaned.length > 0 ? cleaned : "host";
}

export function originHost(): string {
  try {
    return sanitizeHostForFilename(hostname());
  } catch {
    return "host";
  }
}

// Writes one artifact to the relay, write-once by its UUID-bearing filename. A
// filesystem failure logs and returns false; it never propagates (the outbox
// sweep retries).
export function exportBriefArtifact(
  artifact: MorningBriefArtifact,
  options: { dataDir?: string; host?: string; log?: (message: string) => void } = {},
): boolean {
  try {
    const envelope = envelopeFromArtifact(artifact, options.host ?? originHost());
    if (!envelope) return false;
    const finalPath = path.join(briefRelayDir(options.dataDir), relayFileName(envelope));
    return atomicWrite(finalPath, JSON.stringify(envelope), {
      writeOnce: true,
      log: options.log,
    });
  } catch (error) {
    logLine(
      options.log,
      `brief-relay export failed for ${artifact.id}: ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
    return false;
  }
}

// The outbox sweep: any succeeded artifact from the last two days whose relay
// file is missing gets re-exported. This is what makes export durable — a write
// that lost to a filesystem hiccup is picked back up on the next worker tick.
export function sweepBriefRelayOutbox(
  options: {
    store: Pick<DayPlanStore, "listMorningBriefs">;
    now?: Date;
    dataDir?: string;
    host?: string;
    log?: (message: string) => void;
  },
): number {
  try {
    const now = options.now ?? new Date();
    const host = options.host ?? originHost();
    let exported = 0;
    for (const date of recentDates(now, 2)) {
      let artifacts: MorningBriefArtifact[];
      try {
        artifacts = options.store.listMorningBriefs(date);
      } catch {
        continue;
      }
      for (const artifact of artifacts) {
        if (artifact.status !== "succeeded" || !artifact.briefJson || !artifact.inputHash) {
          continue;
        }
        const envelope = envelopeFromArtifact(artifact, host);
        if (!envelope) continue;
        const finalPath = path.join(briefRelayDir(options.dataDir), relayFileName(envelope));
        if (existsSync(finalPath)) continue;
        if (exportBriefArtifact(artifact, { dataDir: options.dataDir, host, log: options.log })) {
          exported += 1;
        }
      }
    }
    return exported;
  } catch (error) {
    logLine(
      options.log,
      `brief-relay outbox sweep failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return 0;
  }
}

// The target date and the day before it, in local order (today first). The
// UTC-noon anchor sidesteps DST edges when subtracting a day.
function recentDates(now: Date, days: number): string[] {
  const anchor = localDateInTimezone(
    now,
    coveEnv("BRIEF_TIMEZONE") ??
      Intl.DateTimeFormat().resolvedOptions().timeZone ??
      "UTC",
  );
  const dates = [anchor];
  for (let offset = 1; offset < days; offset += 1) {
    const previous = new Date(`${dates[dates.length - 1]}T12:00:00.000Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    dates.push(previous.toISOString().slice(0, 10));
  }
  return dates;
}

// ---------------------------------------------------------------------------
// Import: deep validation then a single transactional store call.
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Strict UTC ISO-8601 as produced by Date#toISOString (fractional seconds
// optional). Date.parse alone is far too lax for cross-machine input.
const STRICT_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const HOST_RE = /^[A-Za-z0-9._-]+$/;

function strictIsoMs(value: unknown): number | undefined {
  if (typeof value !== "string" || !STRICT_ISO_RE.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

// Parses and deeply validates one relay file's raw text into an importable
// artifact, or returns undefined (with a single log line) for anything corrupt,
// oversized, foreign-versioned, checksum-mismatched, schema-invalid,
// non-UUID-identified, timestamp-implausible, or (when fileName is supplied)
// misnamed. Never throws, never deletes the file.
export function parseRelayFile(
  raw: string,
  options: { log?: (message: string) => void; fileName?: string; now?: Date } = {},
): MorningBriefArtifact | undefined {
  const label = options.fileName ?? "relay file";
  try {
    if (Buffer.byteLength(raw, "utf8") > MAX_RELAY_FILE_BYTES) {
      logLine(options.log, `brief-relay skip ${label}: oversize`);
      return undefined;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      logLine(options.log, `brief-relay skip ${label}: not_an_object`);
      return undefined;
    }
    const envelope = parsed as Record<string, unknown>;
    if (envelope.relay_version !== BRIEF_RELAY_VERSION) {
      logLine(options.log, `brief-relay skip ${label}: foreign relay_version`);
      return undefined;
    }
    if (
      envelope.prompt_version !== MORNING_BRIEF_PROMPT_VERSION ||
      envelope.schema_version !== MORNING_BRIEF_SCHEMA_VERSION
    ) {
      logLine(options.log, `brief-relay skip ${label}: foreign prompt/schema version`);
      return undefined;
    }
    if (
      envelope.status !== "succeeded" ||
      !isNonEmptyString(envelope.id) ||
      !UUID_RE.test(envelope.id) ||
      !isNonEmptyString(envelope.target_local_date) ||
      !isNonEmptyString(envelope.input_hash) ||
      !isNonEmptyString(envelope.model_alias) ||
      !isNonEmptyString(envelope.effort) ||
      typeof envelope.budget_usd !== "number" ||
      !Number.isFinite(envelope.budget_usd) ||
      !isNonEmptyString(envelope.brief_json) ||
      !isNonEmptyString(envelope.checksum) ||
      !isNonEmptyString(envelope.origin_host) ||
      !HOST_RE.test(envelope.origin_host) ||
      (envelope.source_manifest_json !== null &&
        typeof envelope.source_manifest_json !== "string") ||
      (envelope.started_at !== null && typeof envelope.started_at !== "string")
    ) {
      logLine(options.log, `brief-relay skip ${label}: envelope shape`);
      return undefined;
    }
    // Timestamp sanity: strict ISO, finished_at required, causal ordering, and
    // nothing meaningfully in the future (a fast peer clock must never mint an
    // artifact that outranks every honest one on finished_at).
    const createdMs = strictIsoMs(envelope.created_at);
    const finishedMs = strictIsoMs(envelope.finished_at);
    const startedMs =
      envelope.started_at === null ? undefined : strictIsoMs(envelope.started_at);
    const nowMs = (options.now ?? new Date()).getTime();
    if (
      createdMs === undefined ||
      finishedMs === undefined ||
      (envelope.started_at !== null && startedMs === undefined) ||
      createdMs > (startedMs ?? finishedMs) ||
      (startedMs ?? createdMs) > finishedMs ||
      finishedMs > nowMs + MAX_FUTURE_SKEW_MS ||
      createdMs > nowMs + MAX_FUTURE_SKEW_MS
    ) {
      logLine(options.log, `brief-relay skip ${label}: implausible timestamps`);
      return undefined;
    }
    // The filename must agree with the envelope's own identity; a renamed or
    // cross-copied file is not trusted.
    if (
      options.fileName !== undefined &&
      options.fileName !==
        `${envelope.target_local_date}-${envelope.origin_host}-${envelope.id}.json`
    ) {
      logLine(options.log, `brief-relay skip ${label}: filename/envelope identity mismatch`);
      return undefined;
    }
    const canonical = canonicalArtifactString({
      id: envelope.id,
      target_local_date: envelope.target_local_date,
      input_hash: envelope.input_hash,
      prompt_version: MORNING_BRIEF_PROMPT_VERSION,
      schema_version: MORNING_BRIEF_SCHEMA_VERSION,
      source_manifest_json: (envelope.source_manifest_json as string | null) ?? null,
      model_alias: envelope.model_alias,
      effort: envelope.effort,
      budget_usd: envelope.budget_usd,
      brief_json: envelope.brief_json,
      created_at: envelope.created_at as string,
      started_at: (envelope.started_at as string | null) ?? null,
      finished_at: envelope.finished_at as string,
    });
    if (sha256(canonical) !== envelope.checksum) {
      logLine(options.log, `brief-relay skip ${label}: checksum mismatch`);
      return undefined;
    }
    const artifact: MorningBriefArtifact = {
      id: envelope.id,
      targetLocalDate: envelope.target_local_date,
      status: "succeeded",
      inputHash: envelope.input_hash,
      promptVersion: MORNING_BRIEF_PROMPT_VERSION,
      schemaVersion: MORNING_BRIEF_SCHEMA_VERSION,
      sourceManifest:
        typeof envelope.source_manifest_json === "string"
          ? JSON.parse(envelope.source_manifest_json)
          : undefined,
      modelAlias: envelope.model_alias,
      effort: envelope.effort,
      budgetUsd: envelope.budget_usd,
      writer: morningBriefWriterFromJson(envelope.brief_json),
      briefJson: envelope.brief_json,
      createdAt: envelope.created_at as string,
      updatedAt: envelope.finished_at as string,
      startedAt: (envelope.started_at as string | null) ?? undefined,
      finishedAt: envelope.finished_at as string,
    };
    // The shared output-contract validation: a stored brief_json that would not
    // rehydrate is not importable. This is the same deep parse the arrival uses.
    if (!morningBriefFromArtifact(artifact)) {
      logLine(options.log, `brief-relay skip ${label}: brief contract invalid`);
      return undefined;
    }
    return artifact;
  } catch (error) {
    logLine(
      options.log,
      `brief-relay skip ${label}: ${error instanceof Error ? error.message : "parse error"}`,
    );
    return undefined;
  }
}

// Scans the relay directory for artifacts targeting the given date (and, when
// asked, the day before), importing each new, valid file through the store's
// single transactional importer. Cheap and idempotent: already-seen filenames
// are skipped via the caller-owned set, and the DB dedupes on the composite key
// regardless. Fully fail-open; returns the number of rows imported/adopted.
export function scanAndImportBriefRelay(options: {
  store: Pick<DayPlanStore, "importMorningBrief"> &
    Partial<Pick<DayPlanStore, "stageMorningBriefBoardActions">>;
  targetLocalDate: string;
  includeYesterday?: boolean;
  dataDir?: string;
  imported?: Set<string>;
  now?: Date;
  log?: (message: string) => void;
}): number {
  try {
    const dir = briefRelayDir(options.dataDir);
    if (!existsSync(dir)) return 0;
    const dates = new Set<string>([options.targetLocalDate]);
    if (options.includeYesterday !== false) {
      const previous = new Date(`${options.targetLocalDate}T12:00:00.000Z`);
      previous.setUTCDate(previous.getUTCDate() - 1);
      dates.add(previous.toISOString().slice(0, 10));
    }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return 0;
    }
    let imported = 0;
    for (const fileName of entries) {
      if (options.imported?.has(fileName)) continue;
      if (fileName.includes("sync-conflict")) continue;
      if (!RELAY_FILE_RE.test(fileName)) continue;
      // The filename date prefix bounds the scan to today/yesterday cheaply.
      const datePrefix = fileName.slice(0, 10);
      if (!dates.has(datePrefix)) continue;
      // Mark seen up front so a corrupt file is not re-read every cycle.
      options.imported?.add(fileName);
      const filePath = path.join(dir, fileName);
      let raw: string;
      try {
        if (statSync(filePath).size > MAX_RELAY_FILE_BYTES) {
          logLine(options.log, `brief-relay skip ${fileName}: oversize`);
          continue;
        }
        raw = readFileSync(filePath, "utf8");
      } catch {
        // A file that vanished mid-scan (Syncthing rename) is retried next cycle.
        options.imported?.delete(fileName);
        continue;
      }
      const artifact = parseRelayFile(raw, {
        log: options.log,
        fileName,
        now: options.now,
      });
      if (!artifact) continue;
      try {
        const result = options.store.importMorningBrief(artifact);
        if (result.imported) {
          imported += 1;
          if (result.briefId) options.store.stageMorningBriefBoardActions?.(result.briefId);
        }
      } catch (error) {
        logLine(
          options.log,
          `brief-relay import failed for ${fileName}: ${
            error instanceof Error ? error.message : "unknown"
          }`,
        );
      }
    }
    return imported;
  } catch (error) {
    logLine(
      options.log,
      `brief-relay scan failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Attempt-status relay: the generating machine announces in-flight work so the
// MBP backfill can wait instead of racing a second generation.
// ---------------------------------------------------------------------------

export type BriefAttemptState = "queued" | "running" | "failed";

export type BriefAttemptStatus = {
  relay_version: number;
  target_local_date: string;
  origin_host: string;
  attempt_id: string;
  state: BriefAttemptState;
  started_at?: string;
  expires_at?: string;
  error_code?: string;
  written_at: string;
};

// Writes one write-once status file. running carries started_at + a 15-minute
// expiry; failed carries the error code. Fail-open.
export function writeBriefAttemptStatus(
  input: {
    targetLocalDate: string;
    attemptId: string;
    state: BriefAttemptState;
    startedAt?: string;
    errorCode?: string;
  },
  options: { dataDir?: string; host?: string; now?: Date; log?: (message: string) => void } = {},
): boolean {
  try {
    const host = options.host ?? originHost();
    const now = options.now ?? new Date();
    const startedAt =
      input.state === "running" ? input.startedAt ?? now.toISOString() : input.startedAt;
    const status: BriefAttemptStatus = {
      relay_version: BRIEF_RELAY_VERSION,
      target_local_date: input.targetLocalDate,
      origin_host: host,
      attempt_id: input.attemptId,
      state: input.state,
      ...(startedAt ? { started_at: startedAt } : {}),
      ...(input.state === "running"
        ? {
            expires_at: new Date(
              new Date(startedAt ?? now.toISOString()).getTime() + REMOTE_ATTEMPT_TTL_MS,
            ).toISOString(),
          }
        : {}),
      ...(input.errorCode ? { error_code: input.errorCode.slice(0, 200) } : {}),
      written_at: now.toISOString(),
    };
    const fileName = `${input.targetLocalDate}-${host}-${input.attemptId}-${input.state}.json`;
    const finalPath = path.join(statusRelayDir(options.dataDir), fileName);
    return atomicWrite(finalPath, JSON.stringify(status), {
      writeOnce: true,
      log: options.log,
    });
  } catch (error) {
    logLine(
      options.log,
      `brief-relay status write failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return false;
  }
}

export type LiveRemoteAttempt = { state: "queued" | "running"; startedAt?: string };

// Reports a live (unexpired, not-failed) remote attempt for the date from a host
// other than this one, if any. A running attempt (with a real start time) is
// preferred. Fail-open: any read error means "no known remote attempt".
export function liveRemoteBriefAttempt(options: {
  targetLocalDate: string;
  selfHost?: string;
  dataDir?: string;
  now?: Date;
  log?: (message: string) => void;
}): LiveRemoteAttempt | undefined {
  try {
    const dir = statusRelayDir(options.dataDir);
    if (!existsSync(dir)) return undefined;
    const selfHost = options.selfHost ?? originHost();
    const now = (options.now ?? new Date()).getTime();
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return undefined;
    }
    // Collapse per-attempt states: a failed file kills the attempt regardless of
    // an earlier running/queued file.
    const attempts = new Map<
      string,
      { running?: BriefAttemptStatus; queued?: BriefAttemptStatus; failed: boolean }
    >();
    for (const fileName of entries) {
      if (fileName.includes("sync-conflict")) continue;
      if (!fileName.endsWith(".json")) continue;
      if (fileName.slice(0, 10) !== options.targetLocalDate) continue;
      let status: BriefAttemptStatus;
      try {
        const raw = readFileSync(path.join(dir, fileName), "utf8");
        if (Buffer.byteLength(raw, "utf8") > MAX_RELAY_FILE_BYTES) continue;
        status = JSON.parse(raw) as BriefAttemptStatus;
      } catch {
        continue;
      }
      if (status.relay_version !== BRIEF_RELAY_VERSION) continue;
      if (status.target_local_date !== options.targetLocalDate) continue;
      if (!isNonEmptyString(status.origin_host) || !isNonEmptyString(status.attempt_id)) continue;
      if (status.origin_host === selfHost) continue;
      const entry = attempts.get(status.attempt_id) ?? { failed: false };
      if (status.state === "failed") entry.failed = true;
      else if (status.state === "running") entry.running = status;
      else if (status.state === "queued") entry.queued = status;
      attempts.set(status.attempt_id, entry);
    }
    let liveQueued: LiveRemoteAttempt | undefined;
    for (const entry of attempts.values()) {
      if (entry.failed) continue;
      if (entry.running) {
        // Never trust the peer clock beyond a small skew: a start (or write)
        // time meaningfully in the future is rejected outright, and expiry is
        // capped at start + TTL so a fabricated far-future expires_at cannot
        // extend the wait. A moderately slow peer clock (within the TTL) still
        // reads as live, since liveness keys off start + TTL against our now.
        const startMs =
          Date.parse(entry.running.started_at ?? "") ||
          Date.parse(entry.running.written_at);
        if (!Number.isFinite(startMs) || startMs > now + MAX_FUTURE_SKEW_MS) continue;
        const declaredExpires = entry.running.expires_at
          ? Date.parse(entry.running.expires_at)
          : Number.POSITIVE_INFINITY;
        const expires = Math.min(
          Number.isFinite(declaredExpires) ? declaredExpires : Number.POSITIVE_INFINITY,
          startMs + REMOTE_ATTEMPT_TTL_MS,
        );
        if (expires > now) {
          return { state: "running", startedAt: entry.running.started_at };
        }
        continue;
      }
      if (entry.queued) {
        const writtenAt = Date.parse(entry.queued.written_at);
        if (
          Number.isFinite(writtenAt) &&
          writtenAt <= now + MAX_FUTURE_SKEW_MS &&
          writtenAt + REMOTE_ATTEMPT_TTL_MS > now
        ) {
          liveQueued = { state: "queued" };
        }
      }
    }
    return liveQueued;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Settlement summary: one canonical builder + a relay file the Mini reads when
// its own store has no snapshots.
// ---------------------------------------------------------------------------

function compact(value: string | undefined, maximum: number): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, maximum);
}

export type SettlementSummary = {
  content: string;
  asOf?: string;
  snapshotIds: string[];
};

// The single source of truth for the settlement_summary source text, shared by
// the collector and the relay writer so the two never drift.
export function buildSettlementSummary(
  snapshots: readonly DaySnapshot[],
): SettlementSummary {
  const newestDate = snapshots[0]
    ? new Date(`${snapshots[0].localDate}T12:00:00.000Z`)
    : undefined;
  const cutoff = newestDate && !Number.isNaN(newestDate.getTime())
    ? new Date(newestDate.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    : undefined;
  const recentSnapshots = cutoff
    ? snapshots.filter((snapshot) => snapshot.localDate >= cutoff)
    : snapshots;
  const carryStreak = (snapshotIndex: number, taskId: string): number => {
    let count = 0;
    const expectedDate = new Date(
      `${recentSnapshots[snapshotIndex].localDate}T12:00:00.000Z`,
    );
    for (let index = snapshotIndex; index < recentSnapshots.length; index += 1) {
      if (recentSnapshots[index].localDate !== expectedDate.toISOString().slice(0, 10)) break;
      const match = recentSnapshots[index].body.unresolvedItems.find(
        (item) => item.taskId === taskId,
      );
      if (match?.disposition !== "carry") break;
      count += 1;
      expectedDate.setUTCDate(expectedDate.getUTCDate() - 1);
    }
    return count;
  };
  return {
    content:
      recentSnapshots.length > 0
        ? recentSnapshots
            .map((snapshot, snapshotIndex) => {
              const progress = snapshot.body.unresolvedItems
                .filter((item) => item.disposition === "progress")
                .map((item) =>
                  `title=${JSON.stringify(compact(item.title, 100))}` +
                  (item.progressNote
                    ? ` progress_note=${JSON.stringify(compact(item.progressNote, 500))}`
                    : "") +
                  (item.nextStep
                    ? ` next_step=${JSON.stringify(compact(item.nextStep, 200))}`
                    : ""),
                );
              const carry = snapshot.body.unresolvedItems
                .filter((item) => item.disposition === "carry")
                .map((item) =>
                  `title=${JSON.stringify(compact(item.title, 100))}` +
                  ` carried_days_running=${carryStreak(snapshotIndex, item.taskId)}`,
                );
              const other = snapshot.body.unresolvedItems
                .filter((item) => item.disposition === "defer" || item.disposition === "drop")
                .map((item) => `${JSON.stringify(compact(item.title, 100))}(${item.disposition})`);
              return `- ${snapshot.localDate}: completed=${snapshot.body.completedHumanTaskIds.length}` +
                (progress.length > 0 ? ` continuing_work=[${progress.join("; ")}]` : "") +
                (carry.length > 0 ? ` carried_not_moved=[${carry.join("; ")}]` : "") +
                (other.length > 0 ? ` deferred_or_dropped=[${other.join(", ")}]` : "") +
                (snapshot.body.unresolvedItems.length === 0 ? " unresolved=none" : "") +
                (snapshot.body.nextDayRecommendationSeed
                  ? ` continue_first=${JSON.stringify(compact(snapshot.body.nextDayRecommendationSeed.title, 100))}`
                  : "");
            })
            .join("\n")
        : "No settlement snapshots exist yet.",
    asOf: recentSnapshots[0]?.createdAt,
    snapshotIds: recentSnapshots.map((snapshot) => snapshot.id),
  };
}

type SettlementRelayFile = {
  relay_version: number;
  content: string;
  as_of?: string;
  snapshot_ids: string[];
  written_at: string;
};

// Writes the settlement relay (overwrite allowed — single MBP writer). Only
// writes when the local store has at least one snapshot; an empty local state is
// never published as authoritative. Fail-open.
export function writeSettlementRelay(options: {
  store: Pick<DayPlanStore, "listRecentSnapshots">;
  now?: Date;
  dataDir?: string;
  log?: (message: string) => void;
}): boolean {
  try {
    const snapshots = options.store.listRecentSnapshots(7);
    if (snapshots.length === 0) return false;
    const summary = buildSettlementSummary(snapshots);
    const file: SettlementRelayFile = {
      relay_version: BRIEF_RELAY_VERSION,
      content: summary.content,
      ...(summary.asOf ? { as_of: summary.asOf } : {}),
      snapshot_ids: summary.snapshotIds,
      written_at: (options.now ?? new Date()).toISOString(),
    };
    return atomicWrite(settlementRelayPath(options.dataDir), JSON.stringify(file), {
      writeOnce: false,
      log: options.log,
    });
  } catch (error) {
    logLine(
      options.log,
      `settlement-relay write failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return false;
  }
}

export type RelaySettlementSummary = { content: string; asOf: string };

// Reads the settlement relay file (used as the collector's fallback). Strict:
// as_of, written_at, and snapshot_ids are all required and validated, so a
// defective file can never masquerade as a current settlement source forever.
// Fail-open: any defect returns undefined and the collector records the source
// missing.
export function readSettlementRelay(options: {
  dataDir?: string;
  now?: Date;
  log?: (message: string) => void;
} = {}): RelaySettlementSummary | undefined {
  try {
    const filePath = settlementRelayPath(options.dataDir);
    if (!existsSync(filePath)) return undefined;
    if (statSync(filePath).size > MAX_RELAY_FILE_BYTES) return undefined;
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    if (parsed.relay_version !== BRIEF_RELAY_VERSION) return undefined;
    if (!isNonEmptyString(parsed.content)) return undefined;
    const asOfMs = strictIsoMs(parsed.as_of);
    const writtenMs = strictIsoMs(parsed.written_at);
    const nowMs = (options.now ?? new Date()).getTime();
    if (
      asOfMs === undefined ||
      writtenMs === undefined ||
      asOfMs > nowMs + MAX_FUTURE_SKEW_MS ||
      writtenMs > nowMs + MAX_FUTURE_SKEW_MS
    ) {
      return undefined;
    }
    if (
      !Array.isArray(parsed.snapshot_ids) ||
      parsed.snapshot_ids.length === 0 ||
      !parsed.snapshot_ids.every((id) => isNonEmptyString(id))
    ) {
      return undefined;
    }
    return { content: parsed.content, asOf: parsed.as_of as string };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Day-dump relay: the operator types the evening brain dump on whichever machine they are
// sitting at, but the 7:30 brief runs on the Mini, whose day_dumps table is
// machine-private and therefore empty. Without this the freshest and most
// decision-relevant thing he produces never reaches the brief that frames his
// day. Same shape as the settlement relay: the writer publishes, every machine
// reads.
// ---------------------------------------------------------------------------

// A dump older than this belongs to a day already worked through. Two nights
// covers a Friday dump read on Monday morning; beyond that it is history.
export const DUMP_RELAY_MAX_AGE_MS = 60 * 60 * 60 * 1000;

function dumpRelayPath(dataDir?: string): string {
  return path.join(coveDataDir(dataDir), "dump-relay", "latest.json");
}

export type RelayDayDump = { content: string; asOf: string; targetLocalDate: string };

export function writeDumpRelay(options: {
  store: Pick<DayPlanStore, "listDayDumps">;
  now?: Date;
  dataDir?: string;
  log?: (message: string) => void;
}): boolean {
  try {
    const succeeded = options.store
      .listDayDumps()
      .filter((dump) => dump.status === "succeeded" && dump.rawText.trim());
    const newest = succeeded[succeeded.length - 1];
    if (!newest) return false;
    const file = {
      relay_version: BRIEF_RELAY_VERSION,
      content: newest.rawText.trim(),
      as_of: newest.createdAt,
      target_local_date: newest.targetLocalDate,
      dump_id: newest.id,
      origin_host: originHost(),
      written_at: (options.now ?? new Date()).toISOString(),
    };
    return atomicWrite(dumpRelayPath(options.dataDir), JSON.stringify(file), {
      writeOnce: false,
      log: options.log,
    });
  } catch (error) {
    logLine(
      options.log,
      `dump-relay write failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return false;
  }
}

// Strict on the way in, same as the settlement reader: every timestamp is
// validated and a defective file returns undefined so the collector records the
// source missing rather than shipping a stale dump forever.
export function readDumpRelay(options: {
  dataDir?: string;
  now?: Date;
} = {}): RelayDayDump | undefined {
  try {
    const filePath = dumpRelayPath(options.dataDir);
    if (!existsSync(filePath)) return undefined;
    if (statSync(filePath).size > MAX_RELAY_FILE_BYTES) return undefined;
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    if (parsed.relay_version !== BRIEF_RELAY_VERSION) return undefined;
    if (!isNonEmptyString(parsed.content)) return undefined;
    if (!isNonEmptyString(parsed.target_local_date)) return undefined;
    const asOfMs = strictIsoMs(parsed.as_of);
    const writtenMs = strictIsoMs(parsed.written_at);
    const nowMs = (options.now ?? new Date()).getTime();
    if (
      asOfMs === undefined ||
      writtenMs === undefined ||
      asOfMs > nowMs + MAX_FUTURE_SKEW_MS ||
      writtenMs > nowMs + MAX_FUTURE_SKEW_MS ||
      nowMs - asOfMs > DUMP_RELAY_MAX_AGE_MS
    ) {
      return undefined;
    }
    return {
      content: parsed.content,
      asOf: parsed.as_of as string,
      targetLocalDate: parsed.target_local_date,
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Day-closure relay: the machine the operator actually runs the ritual on publishes
// whether a workday is still open. Every other machine gates on this file rather
// than on its own day_plans, which is machine-private and stale by design.
// ---------------------------------------------------------------------------

// A closure fact older than this says nothing about today. Matches the source
// checkpoint window: a MacBook asleep overnight is still inside it, one away for
// a full day is not.
export const CLOSURE_RELAY_MAX_AGE_MS = 26 * 60 * 60 * 1000;

type DayClosureRelayFile = {
  relay_version: number;
  written_at: string;
  origin_host: string;
  open_local_date: string | null;
  latest_local_date: string | null;
};

export type DayClosureRelay = {
  openLocalDate: string | null;
  latestLocalDate: string | null;
  originHost: string;
  writtenAt: string;
};

function closureRelayPath(dataDir?: string): string {
  return path.join(coveDataDir(dataDir), "settlement-relay", "closure.json");
}

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// The shape check alone accepts 2026-02-31, and a date that never existed still
// compares as "before" a real one, which is enough to hold the brief for a full
// day. Round-tripping through UTC is the cheap way to demand a real calendar day.
function isRealLocalDate(value: string): boolean {
  if (!LOCAL_DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// Publishes this machine's closure facts (overwrite allowed). Monotonic by day:
// a store whose newest plan predates the published one is behind, so it declines
// to speak. That is what stops a peer with a stale database from overwriting the
// authoritative answer and silently switching the gate off (or on).
export function writeDayClosureRelay(options: {
  store: Pick<DayPlanStore, "dayClosureFacts">;
  now?: Date;
  dataDir?: string;
  host?: string;
  log?: (message: string) => void;
}): boolean {
  try {
    const facts = options.store.dayClosureFacts();
    if (!facts.latestLocalDate) return false;
    const published = readDayClosureRelay({
      dataDir: options.dataDir,
      now: options.now,
      requireFresh: false,
    });
    if (
      published?.latestLocalDate &&
      published.latestLocalDate > facts.latestLocalDate
    ) {
      logLine(
        options.log,
        `closure-relay declined: local newest ${facts.latestLocalDate} is behind published ${published.latestLocalDate}`,
      );
      return false;
    }
    // Within the same day, closure only moves one way. A store that still shows
    // the day open after it has been published closed is behind, not newer, and
    // letting it speak would re-block a gate nobody can then unblock: the close
    // already happened, so no further close event is coming to fix it.
    if (
      published?.latestLocalDate === facts.latestLocalDate &&
      published.openLocalDate === null &&
      facts.openLocalDate !== null
    ) {
      logLine(
        options.log,
        `closure-relay declined: ${facts.latestLocalDate} is already published closed`,
      );
      return false;
    }
    const file: DayClosureRelayFile = {
      relay_version: BRIEF_RELAY_VERSION,
      written_at: (options.now ?? new Date()).toISOString(),
      origin_host: options.host ?? originHost(),
      open_local_date: facts.openLocalDate,
      latest_local_date: facts.latestLocalDate,
    };
    return atomicWrite(closureRelayPath(options.dataDir), JSON.stringify(file), {
      writeOnce: false,
      log: options.log,
    });
  } catch (error) {
    logLine(
      options.log,
      `closure-relay write failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return false;
  }
}

// Reads the published closure facts. Returns undefined for anything missing,
// oversize, foreign-versioned, malformed, future-stamped, or (unless the caller
// opts out) older than the freshness window. Undefined always means "no opinion",
// never "blocked" — a machine that cannot read this file must still be able to
// write a brief, or a peer going offline would silently end the morning brief.
export function readDayClosureRelay(
  options: {
    dataDir?: string;
    now?: Date;
    requireFresh?: boolean;
  } = {},
): DayClosureRelay | undefined {
  try {
    const filePath = closureRelayPath(options.dataDir);
    if (!existsSync(filePath)) return undefined;
    if (statSync(filePath).size > MAX_RELAY_FILE_BYTES) return undefined;
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    if (parsed.relay_version !== BRIEF_RELAY_VERSION) return undefined;
    if (!isNonEmptyString(parsed.origin_host) || !HOST_RE.test(parsed.origin_host)) {
      return undefined;
    }
    const writtenMs = strictIsoMs(parsed.written_at);
    const nowMs = (options.now ?? new Date()).getTime();
    if (writtenMs === undefined || writtenMs > nowMs + MAX_FUTURE_SKEW_MS) return undefined;
    if (options.requireFresh !== false && nowMs - writtenMs > CLOSURE_RELAY_MAX_AGE_MS) {
      return undefined;
    }
    const open = parsed.open_local_date;
    const latest = parsed.latest_local_date;
    // A writer with no plans at all never publishes, so a null latest date is a
    // corrupt file rather than a real state. And the open day, when there is
    // one, is always the newest one: open_slot is UNIQUE, so a shape claiming
    // otherwise did not come from dayClosureFacts. Rejecting both is free,
    // because rejecting means "no opinion", which can only unblock a brief.
    if (typeof latest !== "string" || !isRealLocalDate(latest)) return undefined;
    if (open !== null && (typeof open !== "string" || open !== latest)) return undefined;
    return {
      openLocalDate: open as string | null,
      latestLocalDate: latest as string | null,
      originHost: parsed.origin_host,
      writtenAt: parsed.written_at as string,
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Source checkpoint: the MBP publishes the identity of its authoritative source
// files; the Mini refuses to generate off synced copies that do not match.
// ---------------------------------------------------------------------------

type CheckpointEntry = { hash: string; mtime: string; as_of: string };
type CheckpointSource = CheckpointEntry | null;

const OPTIONAL_CHECKPOINT_SOURCE_IDS = new Set(["operator_profile", "leadup"]);

export type CheckpointSourceSpec = string | {
  path: string;
  required: boolean;
};

function checkpointSourceSpec(id: string, source: CheckpointSourceSpec): {
  path: string;
  required: boolean;
} {
  return typeof source === "string"
    ? { path: source, required: !OPTIONAL_CHECKPOINT_SOURCE_IDS.has(id) }
    : source;
}

type SourceCheckpointFile = {
  relay_version: number;
  written_at: string;
  sources: Record<string, CheckpointSource>;
};

function checkpointEntry(filePath: string): CheckpointEntry | undefined {
  try {
    const content = readFileSync(filePath, "utf8");
    const mtime = statSync(filePath).mtime.toISOString();
    return { hash: sha256(content), mtime, as_of: mtime };
  } catch {
    return undefined;
  }
}

// Publishes the checkpoint for the authoritative source files (overwrite
// allowed). Called on the MBP at settlement, local brief generation, and each
// worker tick. Fail-open.
export function writeSourceCheckpoint(options: {
  sources: Record<string, CheckpointSourceSpec>;
  now?: Date;
  dataDir?: string;
  log?: (message: string) => void;
}): boolean {
  try {
    const sources: Record<string, CheckpointSource> = {};
    for (const [id, source] of Object.entries(options.sources)) {
      const resolved = checkpointSourceSpec(id, source);
      const entry = checkpointEntry(resolved.path);
      if (entry) {
        sources[id] = entry;
      } else if (!resolved.required) {
        // Explicit absence lets the verifier distinguish an optional file the
        // writer checked from a source an older checkpoint never knew about.
        sources[id] = null;
      }
    }
    if (Object.keys(sources).length === 0) return false;
    const file: SourceCheckpointFile = {
      relay_version: BRIEF_RELAY_VERSION,
      written_at: (options.now ?? new Date()).toISOString(),
      sources,
    };
    return atomicWrite(sourceCheckpointPath(options.dataDir), JSON.stringify(file), {
      writeOnce: false,
      log: options.log,
    });
  } catch (error) {
    logLine(
      options.log,
      `source-checkpoint write failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return false;
  }
}

export type SourceCheckpointVerdict =
  | { ok: true }
  | { ok: false; reason: "missing" | "stale" | "mismatch" };

// Verifies the Mini's local synced source copies against the MBP checkpoint:
// the checkpoint must exist, be fresh (< 26h), and its hashes must match the
// local files. Any failure returns a reason the caller turns into a failed
// status file (source_checkpoint_mismatch) rather than briefing off stale data.
export function verifySourceCheckpoint(options: {
  sources: Record<string, CheckpointSourceSpec>;
  now?: Date;
  dataDir?: string;
}): SourceCheckpointVerdict {
  try {
    const filePath = sourceCheckpointPath(options.dataDir);
    if (!existsSync(filePath)) return { ok: false, reason: "missing" };
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as SourceCheckpointFile;
    if (parsed.relay_version !== BRIEF_RELAY_VERSION || !parsed.sources) {
      return { ok: false, reason: "missing" };
    }
    const writtenAt = Date.parse(parsed.written_at);
    const now = (options.now ?? new Date()).getTime();
    // A checkpoint stamped meaningfully in the future (fast MBP clock or a
    // tampered file) fails closed exactly like a stale one: it must never stay
    // "fresh" beyond the 26h window by clock fiat.
    if (
      !Number.isFinite(writtenAt) ||
      now - writtenAt > SOURCE_CHECKPOINT_MAX_AGE_MS ||
      writtenAt > now + MAX_FUTURE_SKEW_MS
    ) {
      return { ok: false, reason: "stale" };
    }
    for (const [id, source] of Object.entries(options.sources)) {
      const resolved = checkpointSourceSpec(id, source);
      const checkpointKnowsSource = Object.prototype.hasOwnProperty.call(parsed.sources, id);
      if (!checkpointKnowsSource) {
        // Checkpoints written before operator_profile and leadup existed omit
        // those ids entirely. Preserve their compatibility until refreshed.
        if (!resolved.required) continue;
        return { ok: false, reason: "mismatch" };
      }
      const expected = parsed.sources[id];
      const local = checkpointEntry(resolved.path);
      if (expected === null) {
        if (local) return { ok: false, reason: "mismatch" };
        continue;
      }
      if (!expected || !local || expected.hash !== local.hash) {
        return { ok: false, reason: "mismatch" };
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "missing" };
  }
}
