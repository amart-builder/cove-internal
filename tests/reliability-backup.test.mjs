import assert from 'node:assert/strict';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
import { JobScheduler } from '../src/lib/reliability/jobs.ts';
import { createSqliteBackup } from '../src/lib/reliability/backup.ts';
import { listRecentReceipts } from '../src/lib/reliability/receipts.ts';

test('the recovery notes describe the gate the restore actually has', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const operations = readFileSync(path.join(repoRoot, 'OPERATIONS.md'), 'utf8');
  const script = readFileSync(path.join(repoRoot, 'scripts/cove-restore-backup.sh'), 'utf8');

  // The gate is "no Cove service is loaded", which is a different question from
  // "is anything writing to this database". A web app started by hand -- which
  // setup does, before the installer runs -- passes it, and the open-handle
  // check behind it can read an idle moment as nobody having the file open.
  // Someone restoring a backup is already having a bad day; the notes have to
  // say which processes the refusal will and will not catch.
  const bullet = operations.match(/- Use `bash scripts\/cove-restore-backup\.sh[^\n]*/);
  assert.ok(bullet, 'OPERATIONS.md no longer documents the restore command');
  for (const phrase of ['com.cove.*', 'cove-stop.sh', 'started by hand', 'backstop', 'reports success']) {
    assert.ok(bullet[0].includes(phrase), `the restore note must mention ${phrase}`);
  }

  assert.ok(script.includes('loaded_cove_services'), 'the restore must still gate on loaded services');
  assert.ok(script.includes("'^com\\.(cove|forge)\\.'"), 'the gate must still match both label prefixes');
  assert.ok(script.includes('database_is_open'), 'the open-handle backstop must still exist');
});


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
        // This restore targets a scratch database, not the installed one, so the
        // script's "is any Cove service loaded" gate does not apply.
        COVE_RESTORE_ALLOW_RUNNING: '1',
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
  const backups = readdirSync(backupDir).filter((name) => /^cove-\d{14}(?:-[a-zA-Z0-9-]{1,80})?\.db$/.test(name));
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
        // This restore targets a scratch database, not the installed one, so the
        // script's "is any Cove service loaded" gate does not apply.
        COVE_RESTORE_ALLOW_RUNNING: '1',
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
        // This restore targets a scratch database, not the installed one, so the
        // script's "is any Cove service loaded" gate does not apply.
        COVE_RESTORE_ALLOW_RUNNING: '1',
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
        // This restore targets a scratch database, not the installed one, so the
        // script's "is any Cove service loaded" gate does not apply.
        COVE_RESTORE_ALLOW_RUNNING: '1',
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
    readdirSync(backupDir).filter((name) => /^cove-\d{14}(?:-[a-zA-Z0-9-]{1,80})?\.db$/.test(name)).length,
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
      // Scratch database, so the "is any Cove service loaded" gate does not
      // apply; this case is about rejecting a non-SQLite input.
      env: { ...process.env, COVE_DB_PATH: dbPath, COVE_RESTORE_ALLOW_RUNNING: '1' },
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

function backupCommandFixture(t) {
  const root = path.join(os.tmpdir(), `cove-backup-command-${process.pid}-${Date.now()}-${Math.random()}`);
  const dbPath = path.join(root, 'cove.db');
  const backupDir = path.join(root, 'backups');
  mkdirSync(root, { recursive: true });
  openLocalDatabase(dbPath).close();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH,
    COVE_NODE_PATH: process.execPath,
    COVE_DB_PATH: dbPath,
    COVE_DATA_DIR: root,
    COVE_BACKUP_DIR: backupDir,
    NEXT_PUBLIC_COVE_RUNTIME: 'local',
  };
  return {
    root, dbPath, backupDir,
    run: (...args) => spawnSync('/bin/bash', ['scripts/cove-backup.sh', ...args], {
      cwd: path.resolve('.'), env, encoding: 'utf8',
    }),
  };
}

test('backup command reports snapshot failure with a failing exit code', (t) => {
  const fixture = backupCommandFixture(t);
  writeFileSync(fixture.backupDir, 'not a directory');
  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Backup did not complete/);
});

test('backup command leaves unrelated queued jobs untouched and ignores email configuration', (t) => {
  const fixture = backupCommandFixture(t);
  // Invalid optional configuration must not prevent a local backup.
  writeFileSync(path.join(fixture.root, 'cove-workspace.json'), '{invalid');
  const scheduler = new JobScheduler({ dbPath: fixture.dbPath });
  const unrelated = scheduler.enqueue({ type: 'gmail-operation', payload: {}, priority: 1000,
    idempotencyKey: 'unrelated-operation' });
  scheduler.close();
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  const reader = new JobScheduler({ dbPath: fixture.dbPath });
  try {
    assert.equal(reader.getJob(unrelated.job.id).status, 'queued');
    assert.equal(reader.getJob(unrelated.job.id).attempts, 0);
  } finally { reader.close(); }
});

test('manual backup creates fresh snapshots containing intervening task changes', (t) => {
  const fixture = backupCommandFixture(t);
  assert.equal(fixture.run().status, 0);
  const first = readdirSync(fixture.backupDir);
  const db = openLocalDatabase(fixture.dbPath);
  db.prepare("INSERT INTO tasks (id,title,status,tags,project,position,source_type) VALUES ('new','New','open','[]','Test',0,'manual')").run();
  db.close();
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  const added = readdirSync(fixture.backupDir).filter((name) => name.endsWith('.db') && !first.includes(name));
  assert.equal(added.length, 1);
  const snapshot = openLocalDatabase(path.join(fixture.backupDir, added[0]));
  try { assert.equal(snapshot.prepare("SELECT count(*) FROM tasks WHERE id='new'").pluck().get(), 1); }
  finally { snapshot.close(); }
});

test('daily backup deduplicates and verifies the completed snapshot on repeat', (t) => {
  const fixture = backupCommandFixture(t);
  assert.equal(fixture.run('--daily').status, 0);
  const files = readdirSync(fixture.backupDir);
  const repeated = fixture.run('--daily');
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(readdirSync(fixture.backupDir), files);
  writeFileSync(path.join(fixture.backupDir, files[0]), 'corrupt snapshot');
  assert.notEqual(fixture.run('--daily').status, 0);
});

test('unique snapshot IDs avoid same-second collisions and participate in retention', async (t) => {
  const fixture = backupCommandFixture(t);
  const now = new Date('2026-09-04T12:00:00Z');
  const first = await createSqliteBackup({ ...fixture, now, snapshotId: 'first' });
  const second = await createSqliteBackup({ ...fixture, now, snapshotId: 'second', keep: 1 });
  assert.notEqual(first.path, second.path);
  assert.equal(existsSync(first.path), false);
  assert.equal(existsSync(second.path), true);
  assert.deepEqual(second.removed, [first.path]);
});

test('a pruned snapshot takes its sidecars with it', async (t) => {
  const fixture = backupCommandFixture(t);
  const now = new Date('2026-09-04T12:00:00Z');
  const first = await createSqliteBackup({ ...fixture, now, snapshotId: 'first' });
  // The verification read leaves these beside every snapshot. Pruning used to
  // delete the database alone, so they stayed in the directory naming a file
  // that was no longer there -- and a glob sorts `.db-wal` after `.db`.
  for (const suffix of ['-wal', '-shm']) {
    writeFileSync(`${first.path}${suffix}`, '');
  }
  await createSqliteBackup({ ...fixture, now, snapshotId: 'second', keep: 1 });
  assert.equal(existsSync(first.path), false);
  assert.equal(existsSync(`${first.path}-wal`), false, 'the pruned snapshot left its -wal behind');
  assert.equal(existsSync(`${first.path}-shm`), false, 'the pruned snapshot left its -shm behind');
});

test('daily backup verifies legacy completed jobs without inventing a new filename', async (t) => {
  const fixture = backupCommandFixture(t);
  const now = new Date();
  const backup = await createSqliteBackup({ ...fixture, now });
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const scheduler = new JobScheduler({ dbPath: fixture.dbPath });
  scheduler.register('backup', () => {});
  const queued = scheduler.enqueue({ type: 'backup', payload: { requestedAt: now.toISOString() },
    idempotencyKey: `backup:${date}` });
  assert.equal(await scheduler.runJob(queued.job.id), 'done');
  scheduler.close();
  const result = fixture.run('--daily');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(backup.path));
  rmSync(backup.path);
  assert.notEqual(fixture.run('--daily').status, 0);
});


test('backup command does not recover or notify about unrelated expired leases', (t) => {
  const fixture = backupCommandFixture(t);
  const scheduler = new JobScheduler({ dbPath: fixture.dbPath });
  const unrelated = scheduler.enqueue({ type: 'gmail-operation', payload: {},
    maxAttempts: 1, idempotencyKey: 'expired-unrelated' });
  scheduler.close();
  const db = openLocalDatabase(fixture.dbPath);
  db.prepare("UPDATE cove_jobs SET status='leased', attempts=1, lease_token='fixture', lease_until='2000-01-01T00:00:00Z' WHERE id=?")
    .run(unrelated.job.id);
  db.close();
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  const reader = new JobScheduler({ dbPath: fixture.dbPath });
  try { assert.equal(reader.getJob(unrelated.job.id).status, 'leased'); }
  finally { reader.close(); }
  assert.equal(listRecentReceipts({ dbPath: fixture.dbPath, source: 'gmail-operation' }).length, 0);
});

test('restore refuses while any Cove service is still loaded', async (t) => {
  // Cove's processes open the database per operation and close it again, so an
  // idle moment looks unlocked to lsof while the server, the worker and the
  // five-minute job tick are all running. The loaded-service check is the
  // actual gate; the open-handle check only closes the remaining race.
  const root = path.join(
    os.tmpdir(),
    `cove-restore-running-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  const dbPath = path.join(root, 'cove.db');
  const backupDir = path.join(root, 'backups');
  const fakeBin = path.join(root, 'bin');
  mkdirSync(fakeBin, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const db = openLocalDatabase(dbPath);
  db.close();
  const backup = await createSqliteBackup({
    dbPath,
    backupDir,
    now: new Date('2026-07-28T15:00:00.000Z'),
  });

  // launchctl list prints "PID Status Label"; only the label column is read.
  writeFileSync(
    path.join(fakeBin, 'launchctl'),
    '#!/bin/sh\nif [ "$1" = "list" ]; then\n  printf "PID\\tStatus\\tLabel\\n"\n  printf "421\\t0\\tcom.cove.claude-worker\\n"\nfi\nexit 0\n',
  );
  chmodSync(path.join(fakeBin, 'launchctl'), 0o755);

  const refused = spawnSync(
    '/bin/bash',
    ['scripts/cove-restore-backup.sh', '--yes', backup.path],
    {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        COVE_DB_PATH: dbPath,
        COVE_BACKUP_DIR: backupDir,
        COVE_RESTORE_ALLOW_RUNNING: '0',
      },
      encoding: 'utf8',
    },
  );
  assert.equal(refused.status, 1, `stdout:\n${refused.stdout}\nstderr:\n${refused.stderr}`);
  assert.match(refused.stderr, /com\.cove\.claude-worker/);
  assert.match(refused.stderr, /scripts\/cove-stop\.sh/);

  // The same restore goes through once nothing is loaded.
  writeFileSync(path.join(fakeBin, 'launchctl'), '#!/bin/sh\nexit 0\n');
  chmodSync(path.join(fakeBin, 'launchctl'), 0o755);
  const allowed = spawnSync(
    '/bin/bash',
    ['scripts/cove-restore-backup.sh', '--yes', backup.path],
    {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        COVE_DB_PATH: dbPath,
        COVE_BACKUP_DIR: backupDir,
        COVE_RESTORE_ALLOW_RUNNING: '0',
      },
      encoding: 'utf8',
    },
  );
  assert.equal(allowed.status, 0, `stdout:\n${allowed.stdout}\nstderr:\n${allowed.stderr}`);
});

test('a damaged backup is refused in plain words and changes nothing', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cove-restore-damaged-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'cove.db');
  const backupDir = path.join(root, 'backups');
  mkdirSync(backupDir, { recursive: true });

  const db = openLocalDatabase(dbPath);
  db.prepare(
    `INSERT INTO task_columns
       (id, name, position, is_default, created_at, updated_at)
     VALUES ('column-1', 'Not Started', 0, 1, 'now', 'now')`,
  ).run();
  db.prepare(
    `INSERT INTO tasks
       (id, column_id, title, status, tags, project, position, source_type)
     VALUES ('keep-me', 'column-1', 'Still here', 'open', '[]', 'Atlas', 0, 'manual')`,
  ).run();
  db.close();
  const before = readFileSync(dbPath);

  // Three ways a snapshot goes bad: not a database at all, truncated, and a
  // valid SQLite file with none of Cove's tables in it.
  const damaged = {
    'not-a-database.db': () => writeFileSync(path.join(backupDir, 'not-a-database.db'), 'this is not a database'),
    'truncated.db': () => {
      const file = path.join(backupDir, 'truncated.db');
      writeFileSync(file, before.subarray(0, 40_000));
    },
    'empty.db': () => writeFileSync(path.join(backupDir, 'empty.db'), ''),
  };
  for (const make of Object.values(damaged)) make();

  for (const name of Object.keys(damaged)) {
    const restored = spawnSync(
      '/bin/bash',
      ['scripts/cove-restore-backup.sh', '--yes', path.join(backupDir, name)],
      {
        cwd: path.resolve('.'),
        env: {
          ...process.env,
          COVE_DB_PATH: dbPath,
          COVE_BACKUP_DIR: backupDir,
          COVE_RESTORE_ALLOW_RUNNING: '1',
        },
        encoding: 'utf8',
      },
    );
    assert.notEqual(restored.status, 0, `${name} must not restore`);
    const output = `${restored.stdout}${restored.stderr}`;
    // Someone restoring a backup is already having a bad day. A SqliteError
    // and a stack is the right detail for a diagnostic and the wrong thing to
    // leave them reading, so a sentence has to come last.
    assert.match(
      output,
      /did not restore it|Nothing was changed/,
      `${name} must say what happened in words`,
    );
    // And the stack has to be gone, not merely followed by a sentence. The
    // first version of this fix added the sentence and left the verifier's
    // output alone, so the person still read eight frames and a Node version
    // banner before reaching it -- which is most of what they saw.
    assert.doesNotMatch(output, /^\s+at .+$/m, `${name} must not print a stack frame`);
    assert.doesNotMatch(output, /node:internal/, `${name} must not print Node internals`);
    assert.doesNotMatch(output, /^Node\.js v/m, `${name} must not print the Node version banner`);
    // One line of the diagnostic is worth keeping: it is the difference
    // between "damaged" and knowing which kind of damaged.
    assert.match(
      output,
      /malformed|not a database|recognized Cove table|file is not a database/i,
      `${name} must say what kind of damage it found`,
    );
    assert.deepEqual(readFileSync(dbPath), before, `${name} must leave the database alone`);
  }
});
