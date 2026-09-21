import Database from "better-sqlite3";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";

export type BackupResult = {
  path: string;
  removed: string[];
  reused: boolean;
};

function backupStamp(date: Date): string {
  return date.toISOString().replace(/\D/g, "").slice(0, 14);
}

export function sqliteBackupPath(input: { backupDir: string; now: Date; snapshotId?: string }): string {
  if (input.snapshotId !== undefined && !/^[a-zA-Z0-9-]{1,80}$/.test(input.snapshotId)) {
    throw new Error("Invalid backup snapshot ID.");
  }
  return path.join(input.backupDir,
    `cove-${backupStamp(input.now)}${input.snapshotId ? `-${input.snapshotId}` : ""}.db`);
}

export async function createSqliteBackup(input: {
  dbPath: string;
  backupDir: string;
  keep?: number;
  now?: Date;
  reuseExisting?: boolean;
  snapshotId?: string;
}): Promise<BackupResult> {
  if (!existsSync(input.dbPath)) {
    throw new Error(`No database exists at ${input.dbPath}.`);
  }
  const keep = Math.max(1, Math.trunc(input.keep ?? 14));
  const now = input.now ?? new Date();
  const destination = sqliteBackupPath({ ...input, now });
  mkdirSync(input.backupDir, { recursive: true, mode: 0o700 });
  let reused = false;
  if (existsSync(destination)) {
    if (!input.reuseExisting) {
      throw new Error(`A backup already exists at ${destination}.`);
    }
    verifySqliteBackup(destination);
    reused = true;
  } else {
    const source = new Database(input.dbPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      source.pragma("busy_timeout = 5000");
      await source.backup(destination);
      chmodSync(destination, 0o600);
      // Validate before rotating older snapshots or recording success.
      verifySqliteBackup(destination);
    } catch (error) {
      rmSync(destination, { force: true });
      throw error;
    } finally {
      source.close();
    }
  }

  const backups = readdirSync(input.backupDir)
    .filter((name) => /^(?:cove|forge)-(?:\d{14}(?:-[a-zA-Z0-9-]{1,80})?|\d{8}-\d{6})\.db$/.test(name))
    .map((name) => path.join(input.backupDir, name))
    .sort((left, right) => {
      // Keep the snapshot just verified even when filesystem timestamps tie.
      if (left === destination) return -1;
      if (right === destination) return 1;
      const modified = statSync(right).mtimeMs - statSync(left).mtimeMs;
      return modified || right.localeCompare(left);
    });
  const removed = backups.slice(keep);
  // Every snapshot leaves a -wal and a -shm beside it, from the verification
  // read that follows the copy. Deleting only the database left those two
  // behind for good, so a pruned backup directory filled with sidecars that
  // name a file no longer in it -- and a glob over that directory sorts a
  // `.db-wal` after its `.db`, which is exactly how a person ends up trying to
  // restore one.
  for (const file of removed) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
  }
  return { path: destination, removed, reused };
}

/** Read-only verification for both newly created and previously completed jobs. */
export function verifySqliteBackup(file: string): void {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const check = db.pragma("quick_check") as { quick_check: string }[];
    if (check.length !== 1 || check[0]?.quick_check !== "ok") {
      throw new Error(`Backup failed quick_check: ${file}.`);
    }
  } finally {
    db.close();
  }
}
