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
import { coveDataDir } from "../operator";
import {
  createWorkSuggestion,
  getQuietCurrentSnapshot,
  type WorkSuggestion,
} from "../quiet-current/store";
import type {
  SessionDigest,
  SessionDigestTaskProgress,
} from "../day-plan/store";

const RELAY_VERSION = 1;
const MAX_FILE_BYTES = 512 * 1024;
const DIGEST_FILE_RE = /^progress-[a-f0-9]{32}\.json$/;
const SUGGESTION_FILE_RE = /^progress-suggestion-[a-f0-9]{32}\.json$/;

type DigestRelayFile = {
  relay_version: 1;
  id: string;
  run_at: string;
  project: string;
  summary: string;
  per_task: SessionDigestTaskProgress[];
  evidence: Record<string, unknown>;
  origin_host: string;
  checksum: string;
};

export type ProgressSuggestionRelayInput = {
  digestId: string;
  taskId: string;
  taskTitle: string;
  note: string;
  evidenceQuote: string;
  claim: "likely_done" | "scope_changed";
  suggestedReshape?: string;
  createdAt: string;
};

type SuggestionRelayFile = {
  relay_version: 1;
  id: string;
  digest_id: string;
  kind: "observed_progress";
  task_id: string;
  title: string;
  description: string;
  reason: string;
  source: "progress-reconciler";
  claim_key: string;
  review_material?: string;
  created_at: string;
  expires_at: string;
  origin_host: string;
  checksum: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function relayRoot(dataDir?: string): string {
  return path.join(coveDataDir(dataDir), "progress-relay");
}

function digestDir(dataDir?: string): string {
  return path.join(relayRoot(dataDir), "digests");
}

function suggestionDir(dataDir?: string): string {
  return path.join(relayRoot(dataDir), "suggestions");
}

function receiptDir(dataDir?: string): string {
  return path.join(relayRoot(dataDir), "receipts");
}

function atomicWriteOnce(file: string, value: unknown): boolean {
  if (existsSync(file)) return false;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    if (existsSync(file)) {
      rmSync(temporary, { force: true });
      return false;
    }
    renameSync(temporary, file);
    return true;
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function validTaskProgress(value: unknown): value is SessionDigestTaskProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    validText(row.task_id, 200) &&
    (row.progress === "none" ||
      row.progress === "some" ||
      row.progress === "likely_done") &&
    typeof row.evidence_quote === "string" &&
    row.evidence_quote.length <= 300 &&
    typeof row.note === "string" &&
    row.note.length <= 200 &&
    typeof row.scope_changed === "boolean" &&
    (
      row.suggested_reshape === undefined ||
      (
        typeof row.suggested_reshape === "string" &&
        row.suggested_reshape.length <= 300
      )
    )
  );
}

function digestPayload(file: Omit<DigestRelayFile, "checksum">): string {
  return JSON.stringify([
    file.relay_version,
    file.id,
    file.run_at,
    file.project,
    file.summary,
    file.per_task,
    file.evidence,
    file.origin_host,
  ]);
}

function suggestionPayload(file: Omit<SuggestionRelayFile, "checksum">): string {
  return JSON.stringify([
    file.relay_version,
    file.id,
    file.digest_id,
    file.kind,
    file.task_id,
    file.title,
    file.description,
    file.reason,
    file.source,
    file.claim_key,
    file.review_material ?? null,
    file.created_at,
    file.expires_at,
    file.origin_host,
  ]);
}

export function progressEvidenceFingerprint(input: {
  pingTimestamps: string[];
  gitHead?: string;
}): string {
  return sha256(JSON.stringify({
    ping_timestamps: [...new Set(input.pingTimestamps)].sort(),
    git_head: input.gitHead ?? null,
  }));
}

export function progressDigestId(project: string, fingerprint: string): string {
  return `progress-${sha256(`${project}\0${fingerprint}`).slice(0, 32)}`;
}

export function writeProgressDigestRelay(options: {
  digest: Omit<SessionDigest, "createdAt">;
  dataDir?: string;
  host?: string;
}): boolean {
  const base: Omit<DigestRelayFile, "checksum"> = {
    relay_version: RELAY_VERSION,
    id: options.digest.id,
    run_at: options.digest.runAt,
    project: options.digest.project,
    summary: options.digest.summary,
    per_task: options.digest.perTask,
    evidence: options.digest.evidence,
    origin_host: options.host ?? hostname(),
  };
  const file: DigestRelayFile = {
    ...base,
    checksum: sha256(digestPayload(base)),
  };
  return atomicWriteOnce(
    path.join(digestDir(options.dataDir), `${options.digest.id}.json`),
    file,
  );
}

function readDigestFile(filePath: string): SessionDigest | undefined {
  try {
    if (statSync(filePath).size > MAX_FILE_BYTES) return undefined;
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as DigestRelayFile;
    if (
      parsed.relay_version !== RELAY_VERSION ||
      !DIGEST_FILE_RE.test(`${parsed.id}.json`) ||
      !validIso(parsed.run_at) ||
      !validText(parsed.project, 200) ||
      !validText(parsed.summary, 400) ||
      !Array.isArray(parsed.per_task) ||
      parsed.per_task.length > 20 ||
      !parsed.per_task.every(validTaskProgress) ||
      !parsed.evidence ||
      typeof parsed.evidence !== "object" ||
      Array.isArray(parsed.evidence) ||
      !validText(parsed.origin_host, 200)
    ) {
      return undefined;
    }
    const { checksum, ...base } = parsed;
    if (checksum !== sha256(digestPayload(base))) return undefined;
    return {
      id: parsed.id,
      runAt: parsed.run_at,
      project: parsed.project,
      summary: parsed.summary,
      perTask: parsed.per_task,
      evidence: parsed.evidence,
      createdAt: parsed.run_at,
    };
  } catch {
    return undefined;
  }
}

export function readProgressDigestRelays(options: {
  dataDir?: string;
  since?: string;
  until?: string;
  perProjectLimit?: number;
  totalLimit?: number;
} = {}): SessionDigest[] {
  const dir = digestDir(options.dataDir);
  if (!existsSync(dir)) return [];
  const sinceMs = options.since ? Date.parse(options.since) : Number.NEGATIVE_INFINITY;
  const untilMs = options.until ? Date.parse(options.until) : Number.POSITIVE_INFINITY;
  const perProjectLimit = Math.max(1, Math.min(20, options.perProjectLimit ?? 20));
  const totalLimit = Math.max(1, Math.min(200, options.totalLimit ?? 100));
  const rows = readdirSync(dir)
    .filter((name) => DIGEST_FILE_RE.test(name) && !name.includes(".sync-conflict-"))
    .map((name) => readDigestFile(path.join(dir, name)))
    .filter((row): row is SessionDigest => Boolean(row))
    .filter((row) => {
      const runAt = Date.parse(row.runAt);
      return runAt >= sinceMs && runAt < untilMs;
    })
    .sort((left, right) => right.runAt.localeCompare(left.runAt));
  const counts = new Map<string, number>();
  return rows.filter((row) => {
    const count = counts.get(row.project) ?? 0;
    if (count >= perProjectLimit) return false;
    counts.set(row.project, count + 1);
    return true;
  }).slice(0, totalLimit);
}

export function writeProgressSuggestionRelay(options: {
  suggestion: ProgressSuggestionRelayInput;
  dataDir?: string;
  host?: string;
}): { id: string; written: boolean } {
  const input = options.suggestion;
  const claimKey = `observed_progress:${input.taskId}:${input.claim}`;
  const id = `progress-suggestion-${
    sha256(`${input.digestId}\0${claimKey}`).slice(0, 32)
  }`;
  const createdAt = new Date(input.createdAt);
  const expiresAt = new Date(createdAt.getTime() + 3 * 24 * 60 * 60_000);
  const base: Omit<SuggestionRelayFile, "checksum"> = {
    relay_version: RELAY_VERSION,
    id,
    digest_id: input.digestId,
    kind: "observed_progress",
    task_id: input.taskId,
    title: `Review progress: ${input.taskTitle}`.slice(0, 240),
    description: input.note.slice(0, 200),
    reason: input.evidenceQuote.slice(0, 300),
    source: "progress-reconciler",
    claim_key: claimKey,
    ...(input.suggestedReshape
      ? {
          review_material:
            `${input.note}\nSuggested reshape: ${input.suggestedReshape}`.slice(0, 1_000),
        }
      : {}),
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    origin_host: options.host ?? hostname(),
  };
  const file: SuggestionRelayFile = {
    ...base,
    checksum: sha256(suggestionPayload(base)),
  };
  return {
    id,
    written: atomicWriteOnce(
      path.join(suggestionDir(options.dataDir), `${id}.json`),
      file,
    ),
  };
}

function readSuggestionFile(filePath: string): SuggestionRelayFile | undefined {
  try {
    if (statSync(filePath).size > MAX_FILE_BYTES) return undefined;
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as SuggestionRelayFile;
    if (
      parsed.relay_version !== RELAY_VERSION ||
      !SUGGESTION_FILE_RE.test(`${parsed.id}.json`) ||
      parsed.kind !== "observed_progress" ||
      !validText(parsed.digest_id, 200) ||
      !validText(parsed.task_id, 200) ||
      !validText(parsed.title, 240) ||
      typeof parsed.description !== "string" ||
      parsed.description.length > 200 ||
      !validText(parsed.reason, 300) ||
      parsed.source !== "progress-reconciler" ||
      !validText(parsed.claim_key, 300) ||
      !validIso(parsed.created_at) ||
      !validIso(parsed.expires_at) ||
      !validText(parsed.origin_host, 200)
    ) {
      return undefined;
    }
    const { checksum, ...base } = parsed;
    if (checksum !== sha256(suggestionPayload(base))) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function normalizedClaim(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function equivalentSuggestion(
  existing: WorkSuggestion,
  incoming: SuggestionRelayFile,
  now: Date,
): boolean {
  if (
    existing.targetTaskId !== incoming.task_id ||
    Date.parse(existing.expiresAt) <= now.getTime()
  ) {
    return false;
  }
  return (
    existing.claimKey === incoming.claim_key ||
    normalizedClaim(existing.reason) === normalizedClaim(incoming.reason)
  );
}

export function consumeProgressSuggestionRelays(options: {
  dataDir?: string;
  now?: Date;
  getSnapshot?: typeof getQuietCurrentSnapshot;
  createSuggestion?: typeof createWorkSuggestion;
  log?: (message: string) => void;
} = {}): { examined: number; created: number; deduped: number; expired: number } {
  const dir = suggestionDir(options.dataDir);
  const result = { examined: 0, created: 0, deduped: 0, expired: 0 };
  if (!existsSync(dir)) return result;
  const now = options.now ?? new Date();
  const getSnapshot = options.getSnapshot ?? getQuietCurrentSnapshot;
  const createSuggestion = options.createSuggestion ?? createWorkSuggestion;
  for (const name of readdirSync(dir)) {
    if (!SUGGESTION_FILE_RE.test(name) || name.includes(".sync-conflict-")) continue;
    const id = name.slice(0, -5);
    const receiptPath = path.join(receiptDir(options.dataDir), `${id}.json`);
    if (existsSync(receiptPath)) continue;
    result.examined += 1;
    const relay = readSuggestionFile(path.join(dir, name));
    if (!relay) {
      options.log?.(`progress suggestion relay rejected: ${name}`);
      continue;
    }
    if (Date.parse(relay.expires_at) <= now.getTime()) {
      result.expired += 1;
    } else {
      const existing = getSnapshot(options.dataDir).suggestions.find((suggestion) =>
        equivalentSuggestion(suggestion, relay, now)
      );
      if (existing) {
        result.deduped += 1;
      } else {
        createSuggestion({
          dataDir: options.dataDir,
          id: relay.id,
          kind: "observed_progress",
          title: relay.title,
          description: relay.description,
          reason: relay.reason.slice(0, 300),
          source: relay.source,
          priority: "medium",
          targetTaskId: relay.task_id,
          reviewMaterial: relay.review_material,
          claimKey: relay.claim_key,
          expiresAt: relay.expires_at,
        });
        result.created += 1;
      }
    }
    atomicWriteOnce(receiptPath, {
      relay_version: RELAY_VERSION,
      suggestion_id: relay.id,
      consumed_at: now.toISOString(),
      origin_host: hostname(),
    });
  }
  return result;
}
