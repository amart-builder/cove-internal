import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnNativeNotification } from '../src/lib/claude-execution/notify.ts';
import { remoteIMessageArgs } from '../src/lib/intake/notification-transport.mjs';

function createReminderDatabase(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT,
      due_at TEXT,
      status TEXT NOT NULL,
      notified_at TEXT,
      remind_native INTEGER NOT NULL DEFAULT 0,
      remind_text INTEGER NOT NULL DEFAULT 0,
      source_type TEXT
    );
    CREATE TABLE inbound_events (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL
    );
    CREATE TABLE cove_failure_inbox (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_id TEXT NOT NULL,
      message TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      occurred_at TEXT NOT NULL,
      dismissed_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (source, source_id)
    );
  `);
  return db;
}

function fixture(t) {
  const dir = path.join(
    os.tmpdir(),
    `cove-notification-routing-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  const bin = path.join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const calls = path.join(dir, 'calls.log');
  const sshCalls = path.join(dir, 'ssh-calls.log');
  writeFileSync(
    path.join(bin, 'ssh'),
    '#!/bin/sh\nexit 1\n',
  );
  writeFileSync(
    path.join(bin, 'osascript'),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$COVE_TEST_CALLS"\n',
  );
  chmodSync(path.join(bin, 'ssh'), 0o700);
  chmodSync(path.join(bin, 'osascript'), 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, bin, calls, sshCalls };
}

test('remote iMessage failure falls back to native notification but reports non-delivery', (t) => {
  const { dir, bin, calls } = fixture(t);
  const config = path.join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({
    channel: 'imessage',
    imessage_to: '+13105550123',
    remote_host: 'operator@100.64.0.9',
  }));
  const result = spawnSync(
    process.execPath,
    ['scripts/cove-notify.mjs', 'Client needs attention'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        COVE_REMINDER_CONFIG_PATH: config,
        COVE_TEST_CALLS: calls,
      },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /remote iMessage failed/);
  assert.match(result.stderr, /"delivered":false/);
  assert.match(readFileSync(calls, 'utf8'), /display notification/);
});

test('remote iMessage argv safely quotes hostile AppleScript and shell text', () => {
  const hostile = "He said \"go\" `whoami` $(touch /tmp/cove-pwned) and it's urgent";
  const args = remoteIMessageArgs(
    'operator@100.64.0.9',
    '+13105550123',
    hostile,
  );
  assert.deepEqual(args.slice(0, 5), [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    'operator@100.64.0.9',
  ]);
  assert.match(args[5], /^osascript -e '/);
  assert.match(args[5], /`whoami`/);
  assert.match(args[5], /\$\(touch \/tmp\/cove-pwned\)/);
  assert.equal(args[5].includes(`'"'"'`), true);
  assert.equal(args[5].endsWith("'"), true);
});

test('the reminders tick fires and removes a due scheduled intake entry', (t) => {
  const { dir, bin, calls } = fixture(t);
  const config = path.join(dir, 'config.json');
  const dbPath = path.join(dir, 'cove.db');
  const reminders = path.join(dir, 'reminders');
  const entry = path.join(reminders, 'scheduled-task-1.json');
  mkdirSync(reminders);
  writeFileSync(config, '{"channel":"none"}');
  writeFileSync(entry, JSON.stringify({
    id: 'task-1',
    task_id: 'task-1',
    title: 'Review the proposal',
    surface_at: '2020-01-01T09:00:00.000Z',
  }));
  const result = spawnSync(process.execPath, ['scripts/cove-reminders.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      COVE_DB_PATH: dbPath,
      COVE_REMINDER_CONFIG_PATH: config,
      COVE_TEST_CALLS: calls,
    },
  });
  assert.equal(result.status, 0);
  assert.equal(existsSync(entry), false);
  assert.match(readFileSync(calls, 'utf8'), /Review the proposal/);
});

test('a native-only scheduled failure is recorded and the due file is still deleted', (t) => {
  const { dir, bin } = fixture(t);
  writeFileSync(path.join(bin, 'osascript'), '#!/bin/sh\nexit 1\n');
  const config = path.join(dir, 'config.json');
  const dbPath = path.join(dir, 'cove.db');
  const reminders = path.join(dir, 'reminders');
  const entry = path.join(reminders, 'scheduled-task-2.json');
  mkdirSync(reminders);
  createReminderDatabase(dbPath).close();
  writeFileSync(config, '{"channel":"none"}');
  writeFileSync(entry, JSON.stringify({
    id: 'task-2',
    task_id: 'task-2',
    title: 'Keep trying this reminder',
    surface_at: '2020-01-01T09:00:00.000Z',
  }));
  const result = spawnSync(process.execPath, ['scripts/cove-reminders.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      COVE_DB_PATH: dbPath,
      COVE_REMINDER_CONFIG_PATH: config,
    },
  });
  assert.equal(result.status, 0);
  assert.equal(existsSync(entry), false);
  assert.match(result.stderr, /native notification failed/);
  const db = new Database(dbPath, { readonly: true });
  const failure = db.prepare(
    'SELECT source, source_id, message FROM cove_failure_inbox',
  ).get();
  db.close();
  assert.equal(failure.source, 'reminder-delivery');
  assert.equal(failure.source_id, 'scheduled:task-2');
  assert.match(failure.message, /Native reminder failed/);
});

test('a failed scheduled text is finalized, surfaced natively, and recorded', (t) => {
  const { dir, bin, calls } = fixture(t);
  const config = path.join(dir, 'config.json');
  const dbPath = path.join(dir, 'cove.db');
  const reminders = path.join(dir, 'reminders');
  const entry = path.join(reminders, 'scheduled-task-3.json');
  mkdirSync(reminders);
  createReminderDatabase(dbPath).close();
  writeFileSync(config, JSON.stringify({
    channel: 'imessage',
    imessage_to: '+13105550123',
    remote_host: 'operator@100.64.0.9',
  }));
  writeFileSync(entry, JSON.stringify({
    id: 'task-3',
    task_id: 'task-3',
    title: 'Remote delivery must settle this',
    surface_at: '2020-01-01T09:00:00.000Z',
  }));
  const result = spawnSync(process.execPath, ['scripts/cove-reminders.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      COVE_DB_PATH: dbPath,
      COVE_REMINDER_CONFIG_PATH: config,
      COVE_TEST_CALLS: calls,
    },
  });
  assert.equal(result.status, 0);
  assert.equal(existsSync(entry), false);
  assert.match(result.stderr, /configured channel failed/);
  assert.match(readFileSync(calls, 'utf8'), /Text failed: Remote delivery must settle this/);
  const db = new Database(dbPath, { readonly: true });
  const failure = db.prepare(
    'SELECT source, source_id, message FROM cove_failure_inbox',
  ).get();
  db.close();
  assert.equal(failure.source, 'reminder-delivery');
  assert.equal(failure.source_id, 'scheduled:task-3');
  assert.match(failure.message, /Remote delivery must settle this/);
});

test('a failed due-task text finalizes once, records failure, and attempts fallback', (t) => {
  const { dir, bin, calls } = fixture(t);
  const config = path.join(dir, 'config.json');
  const dbPath = path.join(dir, 'cove.db');
  writeFileSync(config, JSON.stringify({
    channel: 'imessage',
    imessage_to: '+13105550123',
    remote_host: 'operator@100.64.0.9',
  }));
  const db = createReminderDatabase(dbPath);
  db.prepare(
    `INSERT INTO tasks
       (id, title, due_at, status, notified_at, remind_native, remind_text)
     VALUES (?, ?, ?, 'open', NULL, 0, 1)`,
  ).run('due-task', 'Call Maya about the launch', '2020-01-01T09:00:00.000Z');
  db.close();

  const run = () => spawnSync(process.execPath, ['scripts/cove-reminders.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      COVE_DB_PATH: dbPath,
      COVE_REMINDER_CONFIG_PATH: config,
      COVE_TEST_CALLS: calls,
    },
  });
  const first = run();
  assert.equal(first.status, 0);
  assert.match(first.stderr, /configured channel failed/);

  const afterFirst = new Database(dbPath, { readonly: true });
  const task = afterFirst.prepare(
    'SELECT notified_at FROM tasks WHERE id = ?',
  ).get('due-task');
  const failures = afterFirst.prepare(
    'SELECT source, source_id, message FROM cove_failure_inbox',
  ).all();
  afterFirst.close();
  assert.ok(task.notified_at);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].source_id, 'task:due-task');
  assert.match(failures[0].message, /Call Maya about the launch/);
  const callsAfterFirst = readFileSync(calls, 'utf8');
  assert.match(callsAfterFirst, /Text failed: Call Maya about the launch/);

  const second = run();
  assert.equal(second.status, 0);
  assert.equal(readFileSync(calls, 'utf8'), callsAfterFirst);
  const afterSecond = new Database(dbPath, { readonly: true });
  const finalTask = afterSecond.prepare(
    'SELECT notified_at FROM tasks WHERE id = ?',
  ).get('due-task');
  const failureCount = afterSecond.prepare(
    'SELECT COUNT(*) FROM cove_failure_inbox',
  ).pluck().get();
  afterSecond.close();
  assert.equal(finalTask.notified_at, task.notified_at);
  assert.equal(failureCount, 1);
});

test('a native-only due-task failure is recorded after the task is claimed', (t) => {
  const { dir, bin } = fixture(t);
  writeFileSync(path.join(bin, 'osascript'), '#!/bin/sh\nexit 1\n');
  const config = path.join(dir, 'config.json');
  const dbPath = path.join(dir, 'cove.db');
  writeFileSync(config, '{"channel":"none"}');
  const db = createReminderDatabase(dbPath);
  db.prepare(
    `INSERT INTO tasks
       (id, title, due_at, status, notified_at, remind_native, remind_text)
     VALUES (?, ?, ?, 'open', NULL, 1, 0)`,
  ).run('native-only-task', 'Native reminder must be visible', '2020-01-01T09:00:00.000Z');
  db.close();

  const result = spawnSync(process.execPath, ['scripts/cove-reminders.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      COVE_DB_PATH: dbPath,
      COVE_REMINDER_CONFIG_PATH: config,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const check = new Database(dbPath, { readonly: true });
  const task = check.prepare(
    'SELECT notified_at FROM tasks WHERE id = ?',
  ).get('native-only-task');
  const failure = check.prepare(
    'SELECT source, source_id, message FROM cove_failure_inbox',
  ).get();
  check.close();
  assert.ok(task.notified_at);
  assert.equal(failure.source, 'reminder-delivery');
  assert.equal(failure.source_id, 'task:native-only-task');
  assert.match(failure.message, /Native reminder failed/);
});

test('a due-task skips an unconfigured text channel while its native banner succeeds', (t) => {
  const { dir, bin, calls } = fixture(t);
  const config = path.join(dir, 'config.json');
  const dbPath = path.join(dir, 'cove.db');
  writeFileSync(config, '{"channel":"none"}');
  const db = createReminderDatabase(dbPath);
  db.prepare(
    `INSERT INTO tasks
       (id, title, due_at, status, notified_at, remind_native, remind_text)
     VALUES (?, ?, ?, 'open', NULL, 1, 1)`,
  ).run('native-with-unconfigured-text', 'Use the native path', '2020-01-01T09:00:00.000Z');
  db.close();

  const result = spawnSync(process.execPath, ['scripts/cove-reminders.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      COVE_DB_PATH: dbPath,
      COVE_REMINDER_CONFIG_PATH: config,
      COVE_TEST_CALLS: calls,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(calls, 'utf8'), /Use the native path/);
  assert.doesNotMatch(result.stderr, /configured channel failed/);
  const check = new Database(dbPath, { readonly: true });
  assert.equal(check.prepare(
    'SELECT COUNT(*) FROM cove_failure_inbox',
  ).pluck().get(), 0);
  check.close();
});

test('a due-task text failure does not block a concurrent SQLite writer', (t) => {
  const { dir, bin } = fixture(t);
  const concurrentError = path.join(dir, 'concurrent-error.log');
  writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh
"$COVE_TEST_NODE" -e 'const Database=require("better-sqlite3");const db=new Database(process.env.COVE_DB_PATH);db.pragma("busy_timeout = 100");db.prepare("INSERT INTO cove_failure_inbox (id, source, source_id, message, details_json, occurred_at, dismissed_at, created_at) VALUES (?,?,?,?,?,?,NULL,?)").run("concurrent-id","concurrent-writer","write-during-send","write succeeded","{}",new Date().toISOString(),new Date().toISOString());db.close();' 2>"$COVE_TEST_CONCURRENT_ERROR"
exit 1
`);
  chmodSync(path.join(bin, 'ssh'), 0o700);
  const config = path.join(dir, 'config.json');
  const dbPath = path.join(dir, 'cove.db');
  writeFileSync(config, JSON.stringify({
    channel: 'imessage',
    imessage_to: '+13105550123',
    remote_host: 'operator@100.64.0.9',
  }));
  const db = createReminderDatabase(dbPath);
  db.prepare(
    `INSERT INTO tasks
       (id, title, due_at, status, notified_at, remind_native, remind_text)
     VALUES (?, ?, ?, 'open', NULL, 0, 1)`,
  ).run('concurrent-task', 'Allow other Cove writers', '2020-01-01T09:00:00.000Z');
  db.close();

  const result = spawnSync(process.execPath, ['scripts/cove-reminders.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      COVE_DB_PATH: dbPath,
      COVE_REMINDER_CONFIG_PATH: config,
      COVE_TEST_NODE: process.execPath,
      COVE_TEST_CONCURRENT_ERROR: concurrentError,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /SQLITE_BUSY/);
  assert.equal(readFileSync(concurrentError, 'utf8'), '');
  const check = new Database(dbPath, { readonly: true });
  const sources = check.prepare(
    'SELECT source FROM cove_failure_inbox ORDER BY source',
  ).pluck().all();
  check.close();
  assert.deepEqual(sources, ['concurrent-writer', 'reminder-delivery']);
});

test('scheduled text includes titles only for direct-author sources', (t) => {
  const { dir, bin, calls, sshCalls } = fixture(t);
  writeFileSync(
    path.join(bin, 'ssh'),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$COVE_TEST_SSH_CALLS"\n',
  );
  chmodSync(path.join(bin, 'ssh'), 0o700);
  const config = path.join(dir, 'config.json');
  const dbPath = path.join(dir, 'cove.db');
  const reminders = path.join(dir, 'reminders');
  mkdirSync(reminders);
  writeFileSync(config, JSON.stringify({
    channel: 'imessage',
    imessage_to: '+13105550123',
    remote_host: 'operator@100.64.0.9',
  }));
  const entries = [
    { id: 'email-task', title: 'Sensitive email title', source: 'email' },
    { id: 'legacy-task', title: 'Legacy sensitive title' },
    { id: 'chat-task', title: 'Direct chat title', source: 'chat' },
  ];
  for (const entry of entries) {
    writeFileSync(
      path.join(reminders, `scheduled-${entry.id}.json`),
      JSON.stringify({ ...entry, surface_at: '2020-01-01T09:00:00.000Z' }),
    );
  }

  const result = spawnSync(process.execPath, ['scripts/cove-reminders.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      COVE_DB_PATH: dbPath,
      COVE_REMINDER_CONFIG_PATH: config,
      COVE_TEST_CALLS: calls,
      COVE_TEST_SSH_CALLS: sshCalls,
    },
  });
  assert.equal(result.status, 0);
  for (const entry of entries) {
    assert.equal(
      existsSync(path.join(reminders, `scheduled-${entry.id}.json`)),
      false,
    );
  }
  const sent = readFileSync(sshCalls, 'utf8');
  assert.equal(sent.match(/Cove reminder: open the board/g)?.length, 2);
  assert.doesNotMatch(sent, /Sensitive email title|Legacy sensitive title/);
  assert.match(sent, /Cove reminder: Direct chat title/);
  const banners = readFileSync(calls, 'utf8');
  assert.match(banners, /Sensitive email title/);
  assert.match(banners, /Legacy sensitive title/);
});

test('notifyHardFailure uses the native banner path only when COVE_NOTIFY=1', () => {
  const result = spawnSync(process.execPath, [
    '--import',
    'tsx',
    '--input-type=module',
    '--eval',
    `
      import notifications from './src/lib/reliability/notifications.ts';
      const { notifyHardFailure } = notifications;
      const calls = [];
      const dependencies = {
        exists: () => false,
        spawnImpl: (executable, args, options) => {
          calls.push({ executable, args, options });
          return {
            once: () => undefined,
            unref: () => undefined,
          };
        },
        logError: () => undefined,
      };
      const input = {
        source: 'job:backup',
        message: 'Backup retries exhausted.',
      };
      notifyHardFailure(input, { ...dependencies, env: {} });
      notifyHardFailure(input, {
        ...dependencies,
        env: { COVE_NOTIFY: '1' },
      });
      process.stdout.write(JSON.stringify(calls));
    `,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = JSON.parse(result.stdout);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, '/usr/bin/osascript');
  assert.deepEqual(calls[0].args.slice(-3), [
    '--',
    'Cove needs attention',
    'job:backup: Backup retries exhausted.',
  ]);
});

test('terminal-notifier accepts a hard-failure group without an open URL', () => {
  const calls = [];
  spawnNativeNotification({
    title: 'Cove needs attention',
    body: 'job:backup: Backup retries exhausted.',
    group: 'cove-hard-failure-job:backup',
  }, {
    exists: () => true,
    spawnImpl: (executable, args, options) => {
      calls.push({ executable, args, options });
      return { unref: () => undefined };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, '/opt/homebrew/bin/terminal-notifier');
  assert.deepEqual(calls[0].args, [
    '-title', 'Cove needs attention',
    '-message', 'job:backup: Backup retries exhausted.',
    '-group', 'cove-hard-failure-job:backup',
  ]);
  assert.equal(calls[0].args.includes('-open'), false);
});
