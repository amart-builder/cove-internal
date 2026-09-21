import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import Database from 'better-sqlite3';
import { openLocalDatabase } from '../src/lib/local/database.ts';
import { createSqliteBackup } from '../src/lib/reliability/backup.ts';
import { JobScheduler } from '../src/lib/reliability/jobs.ts';
import { clearStaleLeases } from '../scripts/lib/cove-clear-stale-leases.mjs';

// A snapshot is written by the backup job while that job holds its lease, so
// inside every snapshot that job is frozen mid-flight. Restore one and the next
// worker tick recovers the expired lease -- correctly -- and files "Cove
// couldn't create a fresh backup" on the Issues page, minutes after somebody
// restored a backup.

const sourceRoot = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(sourceRoot, 'scripts/cove-restore-backup.sh');

function scratch(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cove-lease-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'cove.db');
  const backupDir = path.join(root, 'backups');
  openLocalDatabase(dbPath).close();
  return { root, dbPath, backupDir };
}

// The real path to a snapshot: the queue leases the backup job, and the job
// copies the database while holding that lease.
async function snapshotFromTheQueue(t) {
  const { dbPath, backupDir } = scratch(t);
  const scheduler = new JobScheduler({ dbPath });
  let snapshot;
  scheduler.register('backup', async () => {
    snapshot = await createSqliteBackup({ dbPath, backupDir });
    return { summary: 'Created database backup.' };
  });
  scheduler.enqueue({ type: 'backup', idempotencyKey: 'backup-under-test' });
  const result = await scheduler.runAvailable({ maxJobs: 1 });
  // Closed here, not in t.after: the restore refuses while anything holds the
  // database open, and these tests run the real script.
  scheduler.close();
  assert.equal(result.done, 1, 'the backup job should have run');
  return { dbPath, backupDir, snapshot };
}

function jobs(file) {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare('SELECT id, type, status, attempts FROM cove_jobs').all();
  } finally {
    db.close();
  }
}

test('a real snapshot carries its own backup job as leased', async (t) => {
  const { dbPath, snapshot } = await snapshotFromTheQueue(t);
  const live = jobs(dbPath).find((job) => job.type === 'backup');
  const inside = jobs(snapshot.path).find((job) => job.type === 'backup');
  assert.equal(live.status, 'done');
  assert.equal(inside.id, live.id);
  assert.equal(inside.status, 'leased', 'this is the whole premise of the fix');
});

test('clearing stale leases queues them again and keeps their attempts', (t) => {
  const { dbPath } = scratch(t);
  const db = new Database(dbPath);
  db.prepare(
    `INSERT INTO cove_jobs (id, type, payload, priority, run_after, lease_until, lease_token,
       attempts, max_attempts, status, idempotency_key, created_at)
     VALUES ('frozen', 'backup', '{}', 100, '2026-09-21T00:00:00.000Z',
       '2026-09-21T00:05:00.000Z', 'token', 1, 5, 'leased', 'frozen-key',
       '2026-09-21T00:00:00.000Z')`,
  ).run();
  db.close();

  assert.equal(clearStaleLeases(dbPath), 1);
  const [job] = jobs(dbPath).filter((row) => row.id === 'frozen');
  assert.equal(job.status, 'queued');
  assert.equal(job.attempts, 1, 'a restore is not an attempt');
});

test('a restore leaves no leased job behind', async (t) => {
  const { dbPath, backupDir, snapshot } = await snapshotFromTheQueue(t);
  assert.equal(
    jobs(snapshot.path).some((job) => job.status === 'leased'),
    true,
    'the snapshot should start with the problem',
  );
  const result = spawnSync('/bin/bash', [SCRIPT, '--yes', snapshot.path], {
    cwd: sourceRoot,
    env: {
      ...process.env,
      COVE_DB_PATH: dbPath,
      COVE_BACKUP_DIR: backupDir,
      COVE_NODE_PATH: process.execPath,
      COVE_RESTORE_ALLOW_RUNNING: '1',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // The restore hands over one file. Checked before anything reads the
  // database, because opening it is what creates a WAL beside it.
  assert.equal(existsSync(`${dbPath}-wal`), false);
  assert.equal(existsSync(`${dbPath}-shm`), false);
  assert.equal(jobs(dbPath).some((job) => job.status === 'leased'), false);
});

test('a restore still works when the lease step cannot run', async (t) => {
  // Not fatal is the whole point: a recovery must never fail over tidying.
  const { dbPath, backupDir, snapshot } = await snapshotFromTheQueue(t);
  const root = mkdtempSync(path.join(os.tmpdir(), 'cove-lease-noclear-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'scripts/lib'), { recursive: true });
  symlinkSync(path.join(sourceRoot, 'node_modules'), path.join(root, 'node_modules'));
  symlinkSync(path.join(sourceRoot, 'src'), path.join(root, 'src'));
  // Every script the restore needs, except the one that clears leases.
  for (const name of [
    'cove-restore-backup.sh', 'cove-verify-sqlite.mjs',
    'lib/load-local-env.mjs', 'lib/cove-runtime-paths.mjs',
    'lib/cove-install-runtime.mjs', 'lib/cove-serving.sh',
  ]) copyFileSync(path.join(sourceRoot, 'scripts', name), path.join(root, 'scripts', name));

  const result = spawnSync(
    '/bin/bash',
    [path.join(root, 'scripts/cove-restore-backup.sh'), '--yes', snapshot.path],
    {
      cwd: root,
      env: {
        ...process.env,
        COVE_DB_PATH: dbPath,
        COVE_BACKUP_DIR: backupDir,
        COVE_NODE_PATH: process.execPath,
        COVE_RESTORE_ALLOW_RUNNING: '1',
      },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /restoring anyway/);
  assert.match(result.stdout, /^Restored /m);
});
