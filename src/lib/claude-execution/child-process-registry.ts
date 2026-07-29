import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { openLocalDatabase } from "../local/database";
import { recordReceipt } from "../reliability/receipts";

export type ClaudeChildLane = "brief" | "dump" | "execution" | "session";

type ActiveChildRow = {
  id: string;
  lane: ClaudeChildLane;
  run_id: string;
  pid: number;
  server_pid: number;
  server_generation: string;
  boot_id: string;
  identity_token: string | null;
  expected_command: string | null;
  server_command: string | null;
  server_started_at: string | null;
};

export type ChildProcessRegistration = {
  lane: ClaudeChildLane;
  runId: string;
  pid: number;
  executable: string;
  dbPath: string;
  serverPid?: number;
  serverGeneration?: string;
  bootId?: string;
  identityToken?: string;
  expectedCommand?: string;
  serverCommand?: string;
  serverStartedAt?: string;
  startedAt?: string;
};

function processCommand(pid: number): string | undefined {
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 64 * 1024,
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function processStartedAt(pid: number): string | undefined {
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 16 * 1024,
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function currentBootId(): string {
  try {
    return execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 16 * 1024,
    }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function hasStrongProcessIdentity(
  row: ActiveChildRow,
  command: string | undefined,
  bootId: string,
): boolean {
  if (!command) return false;
  if (row.identity_token) return command.includes(row.identity_token);
  return row.boot_id !== "unknown" &&
    row.boot_id === bootId &&
    Boolean(row.expected_command) &&
    command === row.expected_command;
}

function hasLiveOwnerServer(
  row: ActiveChildRow,
  bootId: string,
  exists: (pid: number) => boolean,
  commandForPid: (pid: number) => string | undefined,
  startedAtForPid: (pid: number) => string | undefined,
): boolean {
  if (
    row.boot_id === "unknown" ||
    row.boot_id !== bootId ||
    !row.server_command ||
    !row.server_started_at ||
    !exists(row.server_pid)
  ) {
    return false;
  }
  return commandForPid(row.server_pid) === row.server_command &&
    startedAtForPid(row.server_pid) === row.server_started_at;
}

function markOwnedRunFailed(
  db: Database.Database,
  row: ActiveChildRow,
  finishedAt: string,
): void {
  if (row.lane === "brief") {
    db.prepare(
      `UPDATE day_plan_briefs
       SET status = 'failed', error_code = 'orphan_reaped',
           finished_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running'`,
    ).run(finishedAt, finishedAt, row.run_id);
  } else if (row.lane === "dump") {
    db.prepare(
      `UPDATE day_dumps
       SET status = 'failed', error_code = 'orphan_reaped',
           finished_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running'`,
    ).run(finishedAt, finishedAt, row.run_id);
  } else if (row.lane === "execution") {
    db.prepare(
      `UPDATE day_plan_execution_runs
       SET status = 'failed', error_code = 'orphan_reaped',
           finished_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('starting','running','cancelling')`,
    ).run(finishedAt, finishedAt, row.run_id);
  } else {
    db.prepare(
      `UPDATE cove_task_session_runs
       SET status = 'abandoned', error_code = 'orphan_reaped',
           hint = 'The Cove server restarted while this session was open.',
           finished_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('running','awaiting_approval')`,
    ).run(finishedAt, finishedAt, row.run_id);
  }
}

export function registerSpawnedChild(input: ChildProcessRegistration): string {
  const db = openLocalDatabase(input.dbPath);
  try {
    const id = randomUUID();
    const expectedCommand = input.expectedCommand ?? processCommand(input.pid);
    const serverPid = input.serverPid ?? process.pid;
    db.prepare(
      `INSERT INTO cove_spawned_children
       (id, lane, run_id, pid, server_pid, executable, state, started_at,
        server_generation, boot_id, identity_token, expected_command,
        server_command, server_started_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.lane,
      input.runId,
      input.pid,
      serverPid,
      input.executable,
      input.startedAt ?? new Date().toISOString(),
      input.serverGeneration ?? randomUUID(),
      input.bootId ?? currentBootId(),
      input.identityToken ?? null,
      expectedCommand ?? null,
      input.serverCommand ?? processCommand(serverPid) ?? null,
      input.serverStartedAt ?? processStartedAt(serverPid) ?? null,
    );
    return id;
  } finally {
    db.close();
  }
}

export function completeSpawnedChild(
  dbPath: string,
  registrationId: string,
  finishedAt = new Date().toISOString(),
): void {
  const db = openLocalDatabase(dbPath);
  try {
    db.prepare(
      `UPDATE cove_spawned_children
       SET state = 'completed', finished_at = ?
       WHERE id = ? AND state = 'active'`,
    ).run(finishedAt, registrationId);
  } finally {
    db.close();
  }
}

export function pruneSpawnedChildren(options: {
  dbPath: string;
  now?: () => Date;
}): number {
  const db = openLocalDatabase(options.dbPath);
  try {
    const cutoff = new Date(
      (options.now ?? (() => new Date()))().getTime() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    return db.prepare(
      `DELETE FROM cove_spawned_children
       WHERE state IN ('completed','reaped') AND finished_at < ?`,
    ).run(cutoff).changes;
  } finally {
    db.close();
  }
}

export function reapSpawnedChildren(options: {
  dbPath: string;
  serverGeneration?: string;
  bootId?: string;
  now?: () => Date;
  commandForPid?: (pid: number) => string | undefined;
  startedAtForPid?: (pid: number) => string | undefined;
  processExists?: (pid: number) => boolean;
  signalGroup?: (pid: number, signal: NodeJS.Signals) => void;
}): number {
  const db = openLocalDatabase(options.dbPath);
  const now = options.now ?? (() => new Date());
  const serverGeneration = options.serverGeneration ?? randomUUID();
  const bootId = options.bootId ?? currentBootId();
  const commandForPid = options.commandForPid ?? processCommand;
  const startedAtForPid = options.startedAtForPid ?? processStartedAt;
  const exists = options.processExists ?? ((pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  const signalGroup = options.signalGroup ?? ((pid, signal) => process.kill(-pid, signal));
  let reaped = 0;
  try {
    const rows = db.prepare(
      `SELECT id, lane, run_id, pid, server_pid, server_generation, boot_id,
              identity_token, expected_command, server_command,
              server_started_at
       FROM cove_spawned_children
       WHERE state = 'active'
       ORDER BY started_at, id`,
    ).all() as ActiveChildRow[];
    const finishedAt = now().toISOString();
    for (const row of rows) {
      if (row.server_generation === serverGeneration) continue;
      if (
        hasLiveOwnerServer(
          row,
          bootId,
          exists,
          commandForPid,
          startedAtForPid,
        )
      ) {
        continue;
      }
      const command = exists(row.pid) ? commandForPid(row.pid) : undefined;
      if (hasStrongProcessIdentity(row, command, bootId)) {
        try {
          signalGroup(row.pid, "SIGTERM");
        } catch {
          // The child may have exited after the process check.
        }
      }
      db.transaction(() => {
        markOwnedRunFailed(db, row, finishedAt);
        db.prepare(
          `UPDATE cove_spawned_children
           SET state = 'reaped', finished_at = ?
           WHERE id = ? AND state = 'active'`,
        ).run(finishedAt, row.id);
      })();
      reaped += 1;
      try {
        recordReceipt({
          dbPath: options.dbPath,
          source: "claude-child-reaper",
          startedAt: finishedAt,
          finishedAt,
          summary: `Recovered an orphaned ${row.lane} process.`,
          actions: {
            lane: row.lane,
            runId: row.run_id,
            pid: row.pid,
          },
          outcome: "failed",
          failureKey: `${row.lane}:${row.run_id}`,
          failureMessage: `A ${row.lane} process was abandoned after its Cove server stopped.`,
        });
      } catch {
        // Reaping the process and durable run state matters more than its receipt.
      }
    }
    return reaped;
  } finally {
    db.close();
  }
}
