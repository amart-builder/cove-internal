import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { openLocalDatabase } from "../local/database";
import type { JobScheduler } from "../reliability/jobs";

const DAY_MS = 24 * 60 * 60 * 1_000;
const COLLECTOR_VERSION = 1;

export type CoveHealthSystemSignals = {
  brief: {
    lastSuccessAt: string | null;
    ageDays: number | null;
  };
  triage: {
    sampledRuns: number;
    successfulRuns: number;
    successRate: number | null;
    lastSuccessAt: string | null;
  };
  meetingLane: {
    lastHeartbeatAt: string | null;
    ownerId: string | null;
    ownerHostname: string | null;
    disabled: boolean | null;
    errors: number | null;
    granolaStatus: "ok" | "disabled" | "failed" | null;
    degraded: boolean;
  };
  jobs: {
    queueDepth: number;
    failed: number;
    dead: number;
  };
  failureInboxCount: number;
  backup: {
    lastSuccessAt: string | null;
    ageDays: number | null;
    lastRestoreTestPassed: boolean | null;
  };
};

export type CoveAdoptionSignals = {
  daysSinceArrival: number | null;
  daysSinceSettlement: number | null;
  draftsWrittenLast30Days: number;
  staleTaskCount: number;
  recurringStreakBreaksLast30Days: number;
};

export type CoveHealthSnapshot = {
  id: string;
  collectedAt: string;
  collectorVersion: number;
  system: CoveHealthSystemSignals;
  adoption: CoveAdoptionSignals;
};

type SnapshotRow = {
  id: string;
  collected_at: string;
  collector_version: number;
  system_json: string;
  adoption_json: string;
};

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
  ).get(name));
}

function ageDays(now: Date, value: string | null): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.floor((now.getTime() - time) / DAY_MS));
}

function scalarNumber(
  db: Database.Database,
  sql: string,
  ...parameters: unknown[]
): number {
  return Number(
    (db.prepare(sql).pluck().get(...parameters) as number | bigint | undefined) ??
      0,
  );
}

function scalarText(
  db: Database.Database,
  sql: string,
  ...parameters: unknown[]
): string | null {
  const value = db.prepare(sql).pluck().get(...parameters);
  return typeof value === "string" && value ? value : null;
}

function readJson(file: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function latestMeetingHeartbeat(dataDir: string): {
  lastHeartbeatAt: string | null;
  disabled: boolean | null;
  errors: number | null;
  granolaStatus: "ok" | "disabled" | "failed" | null;
  degraded: boolean;
} {
  const root = readJson(path.join(dataDir, "intake", "heartbeats.json"));
  const machines = objectValue(root.machines);
  const heartbeats = Object.values(machines).flatMap((machine) => {
    const heartbeat = objectValue(objectValue(machine).meeting_watch);
    const at = typeof heartbeat.last_run_at === "string"
      ? heartbeat.last_run_at
      : typeof heartbeat.observed_at === "string"
        ? heartbeat.observed_at
        : null;
    return at ? [{ at, heartbeat }] : [];
  }).sort((left, right) => right.at.localeCompare(left.at));
  const latest = heartbeats[0];
  const granola = objectValue(latest?.heartbeat.granola);
  const granolaStatus = granola.status === "ok" ||
      granola.status === "disabled" || granola.status === "failed"
    ? granola.status
    : null;
  const errors = Number.isFinite(Number(latest?.heartbeat.errors))
    ? Number(latest?.heartbeat.errors)
    : null;
  return {
    lastHeartbeatAt: latest?.at ?? null,
    disabled: typeof latest?.heartbeat.disabled === "boolean"
      ? latest.heartbeat.disabled
      : null,
    errors,
    granolaStatus,
    degraded: granolaStatus === "disabled"
      ? false
      : granolaStatus === "failed" || (errors !== null && errors > 0),
  };
}

function meetingOwner(dataDir: string): {
  ownerId: string | null;
  ownerHostname: string | null;
} {
  const lanes = objectValue(
    readJson(path.join(dataDir, "cove-lane-owners.json")).lanes,
  );
  const owner = objectValue(lanes.meeting_watch);
  return {
    ownerId: typeof owner.id === "string" ? owner.id : null,
    ownerHostname: typeof owner.hostname_at_claim === "string"
      ? owner.hostname_at_claim
      : null,
  };
}

function backupFileTime(backupDir: string): string | null {
  if (!existsSync(backupDir)) return null;
  const files = readdirSync(backupDir)
    .filter((name) => /^cove-(?:\d{14}|\d{8}-\d{6})\.db$/.test(name))
    .map((name) => statSync(path.join(backupDir, name)).mtime)
    .sort((left, right) => right.getTime() - left.getTime());
  return files[0]?.toISOString() ?? null;
}

function restoreTestFlag(db: Database.Database): boolean | null {
  if (!tableExists(db, "app_state")) return null;
  const value = scalarText(
    db,
    `SELECT value FROM app_state
     WHERE key IN ('cove.restore_test_passed', 'restore_test_passed')
     ORDER BY updated_at DESC LIMIT 1`,
  );
  if (value === "true" || value === "1" || value === "passed") return true;
  if (value === "false" || value === "0" || value === "failed") return false;
  return null;
}

function staleTaskCount(db: Database.Database, cutoff: string): number {
  if (!tableExists(db, "tasks") || !tableExists(db, "task_columns")) return 0;
  return scalarNumber(
    db,
    `SELECT COUNT(*)
     FROM tasks
     JOIN task_columns ON task_columns.id = tasks.column_id
     WHERE tasks.status = 'open'
       AND tasks.archived_at IS NULL
       AND lower(task_columns.name) IN (
         'not started', 'to do', 'todo', 'backlog',
         'in flight / waiting', 'in flight', 'in progress', 'doing', 'waiting'
       )
       AND COALESCE(tasks.updated_at, tasks.created_at) <= ?`,
    cutoff,
  );
}

function decodeSnapshot(row: SnapshotRow): CoveHealthSnapshot {
  return {
    id: row.id,
    collectedAt: row.collected_at,
    collectorVersion: row.collector_version,
    system: JSON.parse(row.system_json) as CoveHealthSystemSignals,
    adoption: JSON.parse(row.adoption_json) as CoveAdoptionSignals,
  };
}

export function collectCoveHealth(input: {
  dbPath?: string;
  dataDir?: string;
  backupDir?: string;
  now?: Date;
} = {}): CoveHealthSnapshot {
  const now = input.now ?? new Date();
  const collectedAt = now.toISOString();
  const dataDir = input.dataDir ??
    path.dirname(input.dbPath ?? path.join(process.cwd(), "data", "cove.db"));
  const backupDir = input.backupDir ?? path.join(dataDir, "backups");
  const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const staleCutoff = new Date(now.getTime() - 14 * DAY_MS).toISOString();
  const db = openLocalDatabase(input.dbPath);
  try {
    const lastBriefSuccess = tableExists(db, "day_plan_briefs")
      ? scalarText(
          db,
          `SELECT COALESCE(finished_at, updated_at)
           FROM day_plan_briefs
           WHERE status = 'succeeded'
           ORDER BY COALESCE(finished_at, updated_at) DESC LIMIT 1`,
        )
      : null;
    const triageRows = db.prepare(
      `SELECT outcome, finished_at
       FROM cove_receipts
       WHERE source = 'email-triage' AND finished_at >= ?
       ORDER BY finished_at DESC LIMIT 100`,
    ).all(thirtyDaysAgo) as Array<{
      outcome: string;
      finished_at: string;
    }>;
    const triageSuccesses = triageRows.filter((row) => row.outcome === "success");
    const heartbeat = latestMeetingHeartbeat(dataDir);
    const owner = meetingOwner(dataDir);
    const lastBackupReceipt = scalarText(
      db,
      `SELECT finished_at FROM cove_receipts
       WHERE source = 'backup' AND outcome = 'success'
       ORDER BY finished_at DESC LIMIT 1`,
    );
    const lastBackupSuccess = lastBackupReceipt ?? backupFileTime(backupDir);
    const lastArrival = tableExists(db, "day_plans")
      ? scalarText(
          db,
          `SELECT MAX(COALESCE(arrival_interacted_at, confirmed_at))
           FROM day_plans`,
        )
      : null;
    const lastSettlement = tableExists(db, "day_plans")
      ? scalarText(db, "SELECT MAX(settled_at) FROM day_plans")
      : null;
    const draftsWritten = scalarNumber(
      db,
      `SELECT COUNT(*) FROM email_items
       WHERE created_at >= ?
         AND (
           source_payload LIKE '%"gmail_draft_id"%'
           OR draft_response IS NOT NULL
         )`,
      thirtyDaysAgo,
    );
    const system: CoveHealthSystemSignals = {
      brief: {
        lastSuccessAt: lastBriefSuccess,
        ageDays: ageDays(now, lastBriefSuccess),
      },
      triage: {
        sampledRuns: triageRows.length,
        successfulRuns: triageSuccesses.length,
        successRate: triageRows.length > 0
          ? triageSuccesses.length / triageRows.length
          : null,
        lastSuccessAt: triageSuccesses[0]?.finished_at ?? null,
      },
      meetingLane: { ...heartbeat, ...owner },
      jobs: {
        queueDepth: scalarNumber(
          db,
          "SELECT COUNT(*) FROM cove_jobs WHERE status IN ('queued','leased')",
        ),
        failed: scalarNumber(
          db,
          "SELECT COUNT(*) FROM cove_jobs WHERE status = 'failed'",
        ),
        dead: scalarNumber(
          db,
          "SELECT COUNT(*) FROM cove_jobs WHERE status = 'dead'",
        ),
      },
      failureInboxCount: scalarNumber(
        db,
        "SELECT COUNT(*) FROM cove_failure_inbox WHERE dismissed_at IS NULL",
      ),
      backup: {
        lastSuccessAt: lastBackupSuccess,
        ageDays: ageDays(now, lastBackupSuccess),
        lastRestoreTestPassed: restoreTestFlag(db),
      },
    };
    const adoption: CoveAdoptionSignals = {
      daysSinceArrival: ageDays(now, lastArrival),
      daysSinceSettlement: ageDays(now, lastSettlement),
      draftsWrittenLast30Days: draftsWritten,
      staleTaskCount: staleTaskCount(db, staleCutoff),
      recurringStreakBreaksLast30Days: tableExists(db, "recurring_occurrences")
        ? scalarNumber(
            db,
            `SELECT COUNT(*) FROM recurring_occurrences
             WHERE state = 'missed'
               AND COALESCE(missed_at, updated_at, created_at) >= ?`,
            thirtyDaysAgo,
          )
        : 0,
    };
    const id = randomUUID();
    db.prepare(
      `INSERT INTO cove_health_snapshots
         (id, collected_at, collector_version, system_json, adoption_json,
          created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      collectedAt,
      COLLECTOR_VERSION,
      JSON.stringify(system),
      JSON.stringify(adoption),
      collectedAt,
    );
    return { id, collectedAt, collectorVersion: COLLECTOR_VERSION, system, adoption };
  } finally {
    db.close();
  }
}

export function latestCoveHealthSnapshot(input: {
  dbPath?: string;
} = {}): CoveHealthSnapshot | null {
  const db = openLocalDatabase(input.dbPath);
  try {
    const row = db.prepare(
      `SELECT id, collected_at, collector_version, system_json, adoption_json
       FROM cove_health_snapshots
       ORDER BY collected_at DESC, id DESC LIMIT 1`,
    ).get() as SnapshotRow | undefined;
    return row ? decodeSnapshot(row) : null;
  } finally {
    db.close();
  }
}

export function enqueueDueHealthCollection(
  scheduler: JobScheduler,
  input: { dbPath?: string; now?: Date } = {},
): {
  enqueued: boolean;
  reason: "due" | "recent" | "already-scheduled";
} {
  const now = input.now ?? new Date();
  const latest = latestCoveHealthSnapshot({ dbPath: input.dbPath });
  if (
    latest &&
    now.getTime() - Date.parse(latest.collectedAt) < 2 * DAY_MS
  ) {
    return { enqueued: false, reason: "recent" };
  }
  const bucket = Math.floor(now.getTime() / (2 * DAY_MS));
  const result = scheduler.enqueue({
    type: "health-collector",
    payload: { requestedAt: now.toISOString() },
    priority: 20,
    maxAttempts: 5,
    idempotencyKey: `health-collector:${bucket}`,
  });
  return result.inserted
    ? { enqueued: true, reason: "due" }
    : { enqueued: false, reason: "already-scheduled" };
}
