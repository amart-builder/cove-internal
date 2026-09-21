// Clear the leases a snapshot froze in place.
//
// A Cove snapshot is written by the backup job while that job holds its lease,
// so the job's own row inside the file it produced is always mid-flight. Restore
// that file and Cove holds a job whose worker no longer exists: the next tick
// recovers the expired lease -- correctly -- and files "Cove couldn't create a
// fresh backup" on the Issues page, minutes after somebody restored a backup,
// which is the moment they can least tell a real problem from bookkeeping.
//
// After a restore nobody holds a lease on anything, so saying so is honest for
// every job type rather than a special case for backups. The jobs go back to
// queued with their attempt count untouched; the scheduler runs them again.
//
// Usage: node scripts/lib/cove-clear-stale-leases.mjs <database>
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export function clearStaleLeases(dbPath) {
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cove_jobs'")
      .get();
    if (!table) return 0;
    const cleared = db
      .prepare(
        "UPDATE cove_jobs SET status = 'queued', lease_until = NULL, lease_token = NULL WHERE status = 'leased'",
      )
      .run();
    // Leave the file as the restore found it: a clean database with no sidecars
    // beside it, so the swap that follows moves one file and not three.
    db.pragma("wal_checkpoint(TRUNCATE)");
    return cleared.changes;
  } finally {
    db.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    process.stderr.write("Usage: node scripts/lib/cove-clear-stale-leases.mjs <database>\n");
    process.exit(2);
  }
  process.stdout.write(`${clearStaleLeases(target)}\n`);
}
