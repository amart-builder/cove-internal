import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InboundEvent, InboundEventState } from "../data/types";
import { handleLocalRest, resolveLocalInboundEvent } from "../local/db";
import { forgeDataDir } from "../operator";
import { getRuntimeMode } from "../runtime/mode";

export type RecordEventInput = {
  id?: string;
  source: string;
  sourceId: string;
  rawText: string;
  machine?: string;
  createdAt?: string;
  state?: Extract<InboundEventState, "pending" | "dismissed">;
};

type RecordEventOptions = {
  dataDir?: string;
  spoolOnFailure?: boolean;
};

type ResolveEventInput = {
  state: InboundEventState;
  taskId?: string;
  error?: string;
};

type ResolveEventOptions = {
  now?: () => Date;
};

type SpoolRecord = RecordEventInput & {
  machine: string;
  createdAt: string;
};

class InboxDatabaseError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "InboxDatabaseError";
  }
}

function tableName(): string {
  const prefix =
    process.env.FORGE_TABLE_PREFIX ??
    process.env.NEXT_PUBLIC_FORGE_TABLE_PREFIX ??
    "";
  return prefix ? `${prefix}inbound_events` : "inbound_events";
}

async function databaseRequest<T>(
  method: "GET" | "POST" | "PATCH",
  query = new URLSearchParams(),
  body?: unknown,
): Promise<T> {
  if (getRuntimeMode() === "local") {
    const result = handleLocalRest(
      "inbound_events",
      method,
      query,
      body === undefined ? undefined : JSON.stringify(body),
    );
    if (result.status >= 400) {
      throw new InboxDatabaseError(
        `Local inbound_events ${method} failed.`,
        result.status,
        typeof result.body === "string" ? result.body : undefined,
      );
    }
    return result.body as T;
  }

  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceRoleKey) {
    throw new InboxDatabaseError("Supabase inbox is not configured.");
  }
  const url = new URL(`/rest/v1/${tableName()}`, baseUrl);
  query.forEach((value, key) => url.searchParams.append(key, value));
  const response = await fetch(url, {
    method,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new InboxDatabaseError(
      `Supabase inbound_events ${method} failed.`,
      response.status,
      text.slice(0, 500),
    );
  }
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

async function atomicResolveEvent(input: {
  id: string;
  state: InboundEventState;
  taskId: string | null;
  error: string | null;
  updatedAt: string;
}): Promise<InboundEvent | undefined> {
  if (getRuntimeMode() === "local") {
    const row = resolveLocalInboundEvent(input);
    return row ? inboundEvent(row) : undefined;
  }
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceRoleKey) {
    throw new InboxDatabaseError("Supabase inbox is not configured.");
  }
  const response = await fetch(
    new URL("/rest/v1/rpc/forge_resolve_inbound_event", baseUrl),
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_id: input.id,
        p_state: input.state,
        p_task_id: input.taskId,
        p_error: input.error,
        p_updated_at: input.updatedAt,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new InboxDatabaseError(
      "Supabase inbound event resolution failed.",
      response.status,
      text.slice(0, 500),
    );
  }
  const rows = text ? JSON.parse(text) as unknown[] : [];
  return rows[0] ? inboundEvent(rows[0]) : undefined;
}

function inboundEvent(value: unknown): InboundEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InboxDatabaseError("Inbound event response had an invalid shape.");
  }
  return value as InboundEvent;
}

function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const detail = error instanceof InboxDatabaseError ? error.detail ?? "" : "";
  const code = (error as Error & { code?: string }).code ?? "";
  return (
    code.includes("SQLITE_CONSTRAINT") ||
    detail.includes("23505") ||
    detail.toLowerCase().includes("duplicate key") ||
    error.message.toLowerCase().includes("unique constraint")
  );
}

function spoolDir(dataDir?: string): string {
  return path.join(forgeDataDir(dataDir), "intake");
}

function spoolFilename(dataDir?: string): string {
  const safeHost = os.hostname().replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(spoolDir(dataDir), `spool-${safeHost}.jsonl`);
}

function belongsToCurrentHost(file: string): boolean {
  const safeHost = os.hostname().replace(/[^A-Za-z0-9._-]/g, "_");
  const name = path.basename(file);
  return (
    name === `spool-${safeHost}.jsonl` ||
    name.startsWith(`spool-${safeHost}-overflow-`)
  );
}

function parseSpoolRecord(line: string): SpoolRecord | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const source = typeof value.source === "string" ? value.source : undefined;
    const id = typeof value.id === "string" ? value.id : undefined;
    const sourceId = typeof value.sourceId === "string"
      ? value.sourceId
      : typeof value.source_id === "string"
        ? value.source_id
        : undefined;
    const rawText = typeof value.rawText === "string"
      ? value.rawText
      : typeof value.raw_text === "string"
        ? value.raw_text
        : undefined;
    const machine = typeof value.machine === "string" ? value.machine : os.hostname();
    const createdAt = typeof value.createdAt === "string"
      ? value.createdAt
      : typeof value.created_at === "string"
        ? value.created_at
        : undefined;
    const state = value.state === "dismissed" ? "dismissed" : "pending";
    if (!source || !sourceId || rawText === undefined || !createdAt) return undefined;
    return {
      ...(id ? { id } : {}),
      source,
      sourceId,
      rawText,
      machine,
      createdAt,
      state,
    };
  } catch {
    return undefined;
  }
}

async function withSpoolLock<T>(
  file: string,
  operation: () => T | Promise<T>,
  options: { reclaimStale?: boolean } = {},
): Promise<T | undefined> {
  const lockKey = createHash("sha256")
    .update(path.dirname(file))
    .digest("hex")
    .slice(0, 24);
  // Keep lock state off Syncthing and let SQLite release it on process death.
  const lockDb = new Database(
    path.join(os.tmpdir(), `forge-intake-spool-lock-${lockKey}.sqlite`),
  );
  lockDb.pragma(`busy_timeout = ${options.reclaimStale ? 1000 : 0}`);
  let locked = false;
  try {
    lockDb.exec("BEGIN IMMEDIATE");
    locked = true;
    const result = await operation();
    lockDb.exec("COMMIT");
    locked = false;
    return result;
  } catch (error) {
    if (locked) {
      try {
        lockDb.exec("ROLLBACK");
      } catch {
        // Closing the connection also releases a crashed or failed lock.
      }
    }
    if ((error as { code?: unknown }).code === "SQLITE_BUSY") return undefined;
    throw error;
  } finally {
    lockDb.close();
  }
}

async function appendToSpool(
  record: SpoolRecord,
  dataDir?: string,
): Promise<boolean> {
  try {
    const directory = spoolDir(dataDir);
    const file = spoolFilename(dataDir);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const appended = await withSpoolLock(file, () => {
      if (existsSync(file)) {
        const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
        const duplicateIndex = lines.findIndex((line) => {
          const entry = parseSpoolRecord(line);
          return entry?.source === record.source && entry.sourceId === record.sourceId;
        });
        if (duplicateIndex >= 0) {
          const existing = parseSpoolRecord(lines[duplicateIndex]);
          if (existing && existing.state !== record.state) {
            lines[duplicateIndex] = JSON.stringify({
              ...existing,
              state: record.state,
            });
            const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
            writeFileSync(temporary, `${lines.join("\n")}\n`, {
              encoding: "utf8",
              mode: 0o600,
            });
            renameSync(temporary, file);
            chmodSync(file, 0o600);
          }
          return true;
        }
      }
      appendFileSync(file, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      chmodSync(file, 0o600);
      return true;
    }, { reclaimStale: true });
    if (appended !== undefined) return appended;

    // A crashed or busy sweeper must never turn capture into a dropped item.
    // A unique overflow file stays within the same per-machine spool family and
    // is picked up by the next sweep.
    const overflow = path.join(
      directory,
      `spool-${os.hostname().replace(/[^A-Za-z0-9._-]/g, "_")}-overflow-${randomUUID()}.jsonl`,
    );
    writeFileSync(overflow, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    chmodSync(overflow, 0o600);
    return true;
  } catch (error) {
    console.error("Forge inbound capture could not write its spool.", error);
    return false;
  }
}

function syntheticEvent(
  record: SpoolRecord,
  spooled: boolean,
  error?: unknown,
): InboundEvent {
  return {
    id: record.id ?? randomUUID(),
    source: record.source,
    source_id: record.sourceId,
    raw_text: record.rawText,
    machine: record.machine,
    state: record.state ?? "pending",
    task_id: null,
    error: spooled
      ? null
      : error instanceof Error
        ? `spool_failed:${error.message}`.slice(0, 500)
        : "spool_failed",
    attempts: 0,
    created_at: record.createdAt,
    updated_at: record.createdAt,
    spooled,
  };
}

export async function getEvent(id: string): Promise<InboundEvent | undefined> {
  const query = new URLSearchParams({
    select: "*",
    id: `eq.${id}`,
    limit: "1",
  });
  const rows = await databaseRequest<unknown[]>("GET", query);
  return rows[0] ? inboundEvent(rows[0]) : undefined;
}

async function findBySource(
  source: string,
  sourceId: string,
): Promise<InboundEvent | undefined> {
  const query = new URLSearchParams({
    select: "*",
    source: `eq.${source}`,
    source_id: `eq.${sourceId}`,
    limit: "1",
  });
  const rows = await databaseRequest<unknown[]>("GET", query);
  return rows[0] ? inboundEvent(rows[0]) : undefined;
}

/**
 * Durably captures an inbound item without throwing to capture callers.
 *
 * When `event.spooled` is true and the caller did not supply a deterministic
 * id, its synthetic random id is receipt-only and must never be persisted or
 * used as a foreign key. The eventual database row receives its own durable id.
 */
export async function recordEvent(
  input: RecordEventInput,
  options: RecordEventOptions = {},
): Promise<{ event: InboundEvent; existed: boolean }> {
  const createdAt = input.createdAt && Number.isFinite(Date.parse(input.createdAt))
    ? input.createdAt
    : new Date().toISOString();
  const record: SpoolRecord = {
    ...(input.id ? { id: input.id } : {}),
    source: input.source,
    sourceId: input.sourceId,
    rawText: input.rawText,
    machine: input.machine ?? os.hostname(),
    createdAt,
    state: input.state ?? "pending",
  };
  try {
    const rows = await databaseRequest<unknown[]>(
      "POST",
      new URLSearchParams(),
      {
        ...(record.id ? { id: record.id } : {}),
        source: record.source,
        source_id: record.sourceId,
        raw_text: record.rawText,
        machine: record.machine,
        state: record.state,
        task_id: null,
        error: null,
        attempts: 0,
        created_at: record.createdAt,
        updated_at: record.createdAt,
      },
    );
    return { event: inboundEvent(rows[0]), existed: false };
  } catch (error) {
    if (isUniqueViolation(error)) {
      try {
        const existing = await findBySource(record.source, record.sourceId);
        if (existing) return { event: existing, existed: true };
      } catch {
        // The database may have dropped between the insert and the lookup.
      }
    }
    const spooled = options.spoolOnFailure === false
      ? false
      : await appendToSpool(record, options.dataDir);
    return { event: syntheticEvent(record, spooled, error), existed: false };
  }
}

export async function resolveEvent(
  id: string,
  input: ResolveEventInput,
  options: ResolveEventOptions = {},
): Promise<InboundEvent> {
  const current = await getEvent(id);
  if (!current) throw new InboxDatabaseError(`Inbound event ${id} was not found.`);
  const updated = await atomicResolveEvent({
    id,
    state: input.state,
    taskId: input.taskId ?? current.task_id,
    error: input.error ?? null,
    updatedAt: (options.now ?? (() => new Date()))().toISOString(),
  });
  if (!updated) throw new InboxDatabaseError(`Inbound event ${id} was not updated.`);
  return updated;
}

export async function listUnresolved(input: {
  olderThanMinutes: number;
  now?: Date;
}): Promise<InboundEvent[]> {
  const now = input.now ?? new Date();
  const cutoff = new Date(
    now.getTime() - Math.max(0, input.olderThanMinutes) * 60_000,
  ).toISOString();
  const minimumRetryCutoff = new Date(now.getTime() - 10 * 60_000).toISOString();
  const query = new URLSearchParams({
    select: "*",
    state: "in.(pending,failed)",
    attempts: "lt.5",
    created_at: `lte.${cutoff}`,
    updated_at: `lte.${minimumRetryCutoff}`,
    order: "created_at.asc",
  });
  const rows = await databaseRequest<unknown[]>("GET", query);
  return rows.map(inboundEvent).filter((event) => {
    const updatedAt = Date.parse(event.updated_at);
    if (!Number.isFinite(updatedAt)) return false;
    const retryMinutes = Math.max(10, 2 ** event.attempts);
    return updatedAt <= now.getTime() - retryMinutes * 60_000;
  });
}

function spoolFiles(dataDir?: string): string[] {
  const directory = spoolDir(dataDir);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /^spool-.*\.jsonl$/.test(name))
    .sort()
    .map((name) => path.join(directory, name));
}

export function countSpooledEvents(dataDir?: string): number {
  return spoolFiles(dataDir).reduce((count, file) => {
    const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    return count + lines.length;
  }, 0);
}

function isOverflowSpool(file: string): boolean {
  return path.basename(file).includes("-overflow-");
}

function drainableSpoolFiles(dataDir: string | undefined, now: Date): string[] {
  const foreignCutoff = now.getTime() - 15 * 60_000;
  return spoolFiles(dataDir).filter((file) => {
    if (belongsToCurrentHost(file)) return true;
    try {
      return statSync(file).mtimeMs <= foreignCutoff;
    } catch {
      return false;
    }
  });
}

export async function drainSpoolFiles(
  dataDir?: string,
  options: { now?: Date } = {},
): Promise<{ processed: number; remaining: number }> {
  let processed = 0;
  let remaining = 0;
  const now = options.now ?? new Date();
  for (const file of drainableSpoolFiles(dataDir, now)) {
    try {
      const result = await withSpoolLock(file, async () => {
        const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
        const keep: string[] = [];
        let fileProcessed = 0;
        for (const line of lines) {
          const record = parseSpoolRecord(line);
          if (!record) {
            keep.push(line);
            continue;
          }
          const capture = await recordEvent(record, {
            dataDir,
            spoolOnFailure: false,
          });
          if (capture.event.spooled === false) {
            keep.push(line);
          } else {
            fileProcessed += 1;
          }
        }
        if (keep.length === 0 && isOverflowSpool(file)) {
          unlinkSync(file);
          return { fileProcessed, fileRemaining: 0 };
        }
        const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
        writeFileSync(temporary, keep.length > 0 ? `${keep.join("\n")}\n` : "", {
          encoding: "utf8",
          mode: 0o600,
        });
        renameSync(temporary, file);
        chmodSync(file, 0o600);
        return { fileProcessed, fileRemaining: keep.length };
      }, { reclaimStale: true });
      if (result) {
        processed += result.fileProcessed;
        remaining += result.fileRemaining;
      } else {
        remaining += readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).length;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error("Inbound spool file could not be drained; continuing.", {
          file,
          error,
        });
      }
    }
  }
  return { processed, remaining };
}
