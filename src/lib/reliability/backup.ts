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

export async function createSqliteBackup(input: {
  dbPath: string;
  backupDir: string;
  keep?: number;
  now?: Date;
  reuseExisting?: boolean;
}): Promise<BackupResult> {
  if (!existsSync(input.dbPath)) {
    throw new Error(`No database exists at ${input.dbPath}.`);
  }
  const keep = Math.max(1, Math.trunc(input.keep ?? 14));
  const now = input.now ?? new Date();
  mkdirSync(input.backupDir, { recursive: true, mode: 0o700 });
  const destination = path.join(
    input.backupDir,
    `forge-${backupStamp(now)}.db`,
  );
  let reused = false;
  if (existsSync(destination)) {
    if (!input.reuseExisting) {
      throw new Error(`A backup already exists at ${destination}.`);
    }
    const existing = new Database(destination, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const check = existing.pragma("quick_check") as {
        quick_check: string;
      }[];
      if (check.length !== 1 || check[0]?.quick_check !== "ok") {
        throw new Error(`Existing backup failed quick_check: ${destination}.`);
      }
      reused = true;
    } finally {
      existing.close();
    }
  } else {
    const source = new Database(input.dbPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      source.pragma("busy_timeout = 5000");
      await source.backup(destination);
      chmodSync(destination, 0o600);
    } catch (error) {
      rmSync(destination, { force: true });
      throw error;
    } finally {
      source.close();
    }
  }

  const backups = readdirSync(input.backupDir)
    .filter((name) => /^forge-(?:\d{14}|\d{8}-\d{6})\.db$/.test(name))
    .map((name) => path.join(input.backupDir, name))
    .sort((left, right) => {
      const modified = statSync(right).mtimeMs - statSync(left).mtimeMs;
      return modified || right.localeCompare(left);
    });
  const removed = backups.slice(keep);
  for (const file of removed) rmSync(file, { force: true });
  return { path: destination, removed, reused };
}
