import assert from 'node:assert/strict';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { openLocalDatabase } from '../src/lib/local/database.ts';
import { localSchemaFingerprint } from '../src/lib/local/migrations.ts';
import { createSqliteBackup } from '../src/lib/reliability/backup.ts';
import { listRecentReceipts } from '../src/lib/reliability/receipts.ts';

test('backup and restore round trip preserves rows and schema', async (t) => {
  const root = path.join(
    os.tmpdir(),
    `cove-backup-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  const dbPath = path.join(root, 'cove.db');
  const backupDir = path.join(root, 'backups');
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const db = openLocalDatabase(dbPath);
  db.prepare(
    `INSERT INTO task_columns
       (id, name, position, is_default, created_at, updated_at)
     VALUES ('column-1', 'Not Started', 0, 1, 'now', 'now')`,
  ).run();
  db.prepare(
    `INSERT INTO tasks
       (id, column_id, title, status, tags, project, position, source_type)
     VALUES ('task-1', 'column-1', 'First', 'open', '[]', 'Atlas', 0, 'manual'),
            ('task-2', 'column-1', 'Second', 'open', '[]', 'Atlas', 1, 'manual')`,
  ).run();
  const expectedSchema = localSchemaFingerprint(db);
  const expectedRows = db.prepare('SELECT COUNT(*) FROM tasks').pluck().get();
  db.close();

  const backup = await createSqliteBackup({
    dbPath,
    backupDir,
    now: new Date('2026-07-28T12:00:00.000Z'),
  });
  const changed = openLocalDatabase(dbPath);
  changed.prepare('DELETE FROM tasks').run();
  changed.close();

  const restored = spawnSync(
    '/bin/bash',
    ['scripts/cove-restore-backup.sh', '--yes', backup.path],
    {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        COVE_DB_PATH: dbPath,
        COVE_BACKUP_DIR: backupDir,
      },
      encoding: 'utf8',
    },
  );
  assert.equal(
    restored.status,
    0,
    `stdout:\n${restored.stdout}\nstderr:\n${restored.stderr}`,
  );

  const verify = openLocalDatabase(dbPath);
  try {
    assert.equal(verify.prepare('SELECT COUNT(*) FROM tasks').pluck().get(), expectedRows);
    assert.equal(localSchemaFingerprint(verify), expectedSchema);
  } finally {
    verify.close();
  }
});

test('backup rotation keeps the newest fourteen snapshots', async (t) => {
  const root = path.join(
    os.tmpdir(),
    `cove-backup-rotation-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  const dbPath = path.join(root, 'cove.db');
  const backupDir = path.join(root, 'backups');
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  openLocalDatabase(dbPath).close();
  const legacyBackup = path.join(backupDir, 'forge-20260728-115959.db');
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(legacyBackup, 'legacy backup');
  utimesSync(legacyBackup, new Date(0), new Date(0));

  for (let index = 0; index < 15; index += 1) {
    await createSqliteBackup({
      dbPath,
      backupDir,
      keep: 14,
      now: new Date(Date.UTC(2026, 6, 28, 12, 0, index)),
    });
  }
  const backups = readdirSync(backupDir).filter((name) => /^cove-\d{14}\.db$/.test(name));
  assert.equal(backups.length, 14);
  assert.equal(backups.includes('cove-20260728120000.db'), false);
  assert.equal(existsSync(legacyBackup), false);
});

test('online backup includes rows still present in a live WAL', async (t) => {
  const root = path.join(
    os.tmpdir(),
    `cove-backup-wal-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  const dbPath = path.join(root, 'cove.db');
  const backupDir = path.join(root, 'backups');
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const writer = openLocalDatabase(dbPath);
  writer.pragma('wal_autocheckpoint = 0');
  writer.prepare(
    `INSERT INTO tasks
       (id, title, status, tags, project, position, source_type)
     VALUES ('wal-task', 'Still in WAL', 'open', '[]', 'Atlas', 0, 'manual')`,
  ).run();
  assert.equal(existsSync(`${dbPath}-wal`), true);
  const result = await createSqliteBackup({
    dbPath,
    backupDir,
    now: new Date('2026-07-28T13:00:00.000Z'),
  });
  const snapshot = openLocalDatabase(result.path);
  try {
    assert.equal(
      snapshot.prepare("SELECT COUNT(*) FROM tasks WHERE id = 'wal-task'").pluck().get(),
      1,
    );
  } finally {
    snapshot.close();
    writer.close();
  }
});

test('restore refuses while another process has the database open', async (t) => {
  const hasLsof = spawnSync('/usr/bin/env', ['sh', '-c', 'command -v lsof'], {
    encoding: 'utf8',
  }).status === 0;
  if (!hasLsof) {
    t.skip('lsof is unavailable on this platform');
    return;
  }
  const root = path.join(
    os.tmpdir(),
    `cove-restore-open-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  const dbPath = path.join(root, 'cove.db');
  const backupDir = path.join(root, 'backups');
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  openLocalDatabase(dbPath).close();
  const backup = await createSqliteBackup({
    dbPath,
    backupDir,
    now: new Date('2026-07-28T14:00:00.000Z'),
  });
  const heldOpen = openLocalDatabase(dbPath);
  const restored = spawnSync(
    '/bin/bash',
    ['scripts/cove-restore-backup.sh', '--yes', backup.path],
    {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        COVE_DB_PATH: dbPath,
        COVE_BACKUP_DIR: backupDir,
      },
      encoding: 'utf8',
    },
  );
  heldOpen.close();
  assert.equal(restored.status, 1);
  assert.match(restored.stderr, /still has .* open/);
});

test('restore refuses while another process has the WAL open', async (t) => {
  const hasLsof = spawnSync('/usr/bin/env', ['sh', '-c', 'command -v lsof'], {
    encoding: 'utf8',
  }).status === 0;
  if (!hasLsof) {
    t.skip('lsof is unavailable on this platform');
    return;
  }
  const root = path.join(
    os.tmpdir(),
    `cove-restore-wal-open-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  const dbPath = path.join(root, 'cove.db');
  const backupDir = path.join(root, 'backups');
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  openLocalDatabase(dbPath).close();
  const backup = await createSqliteBackup({
    dbPath,
    backupDir,
    now: new Date('2026-07-28T14:30:00.000Z'),
  });
  const walHandle = openSync(`${dbPath}-wal`, 'a');
  const restored = spawnSync(
    '/bin/bash',
    ['scripts/cove-restore-backup.sh', '--yes', backup.path],
    {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        COVE_DB_PATH: dbPath,
        COVE_BACKUP_DIR: backupDir,
      },
      encoding: 'utf8',
    },
  );
  closeSync(walHandle);
  assert.equal(restored.status, 1);
  assert.match(restored.stderr, /still has .* open/);
});

test('restore rechecks liveness immediately before the atomic swap', async (t) => {
  const root = path.join(
    os.tmpdir(),
    `cove-restore-recheck-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  const dbPath = path.join(root, 'cove.db');
  const backupDir = path.join(root, 'backups');
  const fakeBin = path.join(root, 'bin');
  const lsofState = path.join(root, 'lsof-count');
  mkdirSync(fakeBin, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  openLocalDatabase(dbPath).close();
  const backup = await createSqliteBackup({
    dbPath,
    backupDir,
    now: new Date('2026-07-28T14:45:00.000Z'),
  });
  const fakeLsof = path.join(fakeBin, 'lsof');
  writeFileSync(
    fakeLsof,
    `#!/bin/bash
count=0
if [ -f "${lsofState}" ]; then count="$(/bin/cat "${lsofState}")"; fi
count=$((count + 1))
/bin/echo "$count" > "${lsofState}"
if [ "$count" -ge 3 ]; then exit 0; fi
exit 1
`,
  );
  chmodSync(fakeLsof, 0o755);

  const restored = spawnSync(
    '/bin/bash',
    ['scripts/cove-restore-backup.sh', '--yes', backup.path],
    {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        COVE_DB_PATH: dbPath,
        COVE_BACKUP_DIR: backupDir,
      },
      encoding: 'utf8',
    },
  );
  assert.equal(restored.status, 1);
  assert.match(restored.stderr, /reopened .* during restore/);
  assert.equal(existsSync(dbPath), true);
});

test('restore keeps the old database in place until an atomic replacement', () => {
  const source = readFileSync(
    new URL('../scripts/cove-restore-backup.sh', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /mv "\$DB"/);
  assert.match(source, /trap '' HUP INT TERM\s+mv -f "\$TEMP" "\$DB"/);
});

test('backup entry point works from a foreign cwd with launchd PATH', (t) => {
  const root = path.join(
    os.tmpdir(),
    `cove-backup-entry-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  const dbPath = path.join(root, 'cove.db');
  const backupDir = path.join(root, 'backups');
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  openLocalDatabase(dbPath).close();
  const script = path.resolve('scripts/cove-backup.sh');
  const result = spawnSync('/bin/bash', [script], {
    cwd: os.tmpdir(),
    env: {
      HOME: os.homedir(),
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      COVE_DB_PATH: dbPath,
      COVE_BACKUP_DIR: backupDir,
      COVE_NODE_PATH: process.execPath,
    },
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.equal(
    readdirSync(backupDir).filter((name) => /^cove-\d{14}\.db$/.test(name)).length,
    1,
  );
  assert.equal(listRecentReceipts({ dbPath, source: 'backup' }).length, 1);
  assert.equal(listRecentReceipts({ dbPath, source: 'scheduler' }).length, 1);
});

test('restore rejects a non-SQLite input before replacing the database', (t) => {
  const root = path.join(
    os.tmpdir(),
    `cove-restore-invalid-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  const dbPath = path.join(root, 'cove.db');
  const invalid = path.join(root, 'not-a-backup.db');
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  openLocalDatabase(dbPath).close();
  writeFileSync(invalid, 'not a SQLite database');
  const result = spawnSync(
    '/bin/bash',
    ['scripts/cove-restore-backup.sh', '--yes', invalid],
    {
      cwd: path.resolve('.'),
      env: { ...process.env, COVE_DB_PATH: dbPath },
      encoding: 'utf8',
    },
  );
  assert.notEqual(result.status, 0);
  const unchanged = openLocalDatabase(dbPath);
  try {
    assert.equal(
      unchanged.prepare(
        "SELECT COUNT(*) FROM sqlite_schema WHERE name = 'cove_jobs'",
      ).pluck().get(),
      1,
    );
  } finally {
    unchanged.close();
  }
});
