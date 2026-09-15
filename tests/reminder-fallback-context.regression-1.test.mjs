import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { textDeliveryUncertain } from '../src/lib/intake/notification-transport.mjs';
import { runLocalMigrations } from '../src/lib/local/migrations.ts';

function fixture(t, kind, failNative = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cove-reminder-fallback-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'); mkdirSync(bin);
  const calls = path.join(root, 'native.log'); const texts = path.join(root, 'text.log');
  const notifier = path.join(bin, 'notifier');
  writeFileSync(notifier, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$COVE_TEST_NATIVE"\ncase "$*" in *"Text delivery"*) exit 0;; esac\nexit "${COVE_TEST_NATIVE_FAIL:-0}"\n', { mode: 0o700 });
  writeFileSync(path.join(bin, 'ssh'), '#!/bin/sh\nprintf "attempt\\n" >> "$COVE_TEST_TEXT"\nprintf "ETIMEDOUT\\n" >&2\nexit 255\n', { mode: 0o700 });
  const dbPath = path.join(root, 'cove.db'); const db = new Database(dbPath); runLocalMigrations(db);
  db.prepare("INSERT INTO tasks(id,title,status,due_at,remind_native,remind_text,position,created_at,updated_at) VALUES('task-fixture','Call the client','open',?,1,1,0,?,?)").run(kind === 'task' ? '2099-08-06T09:00:00-07:00' : null, '2099-01-01', '2099-01-01');
  db.prepare("INSERT INTO inbound_events(id,source,source_id,raw_text,state,created_at,updated_at) VALUES('task-fixture','chat','fixture','fixture','triaged','2099-01-01','2099-01-01')").run();
  if (kind === 'scheduled') {
    mkdirSync(path.join(root, 'reminders'));
    writeFileSync(path.join(root, 'reminders/scheduled-fixture.json'), JSON.stringify({ id: 'schedule-fixture', task_id: 'task-fixture', title: 'Call the client', source: 'chat', surface_at: '2000-01-01T09:00:00Z' }));
  }
  const config = path.join(root, 'cove-reminders.json');
  writeFileSync(config, JSON.stringify({ channel: 'imessage', imessage_to: 'fixture@example.test', remote_host: 'fixture-host' }));
  t.after(() => db.close());
  const run = () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/cove-reminders.mjs'], { encoding: 'utf8', env: { ...process.env,
      PATH: `${bin}:${process.env.PATH}`, COVE_DB_PATH: dbPath, COVE_DATA_DIR: root, COVE_REMINDER_CONFIG_PATH: config,
      COVE_NOTIFICATION_APP: notifier, COVE_ATTENTION_NOW: '2099-08-06T10:00:00-07:00', COVE_TEST_NATIVE: calls,
      COVE_TEST_TEXT: texts, COVE_TEST_NATIVE_FAIL: failNative ? '1' : '0' } });
    assert.equal(result.status, 0, result.stderr);
  };
  return { run, db, calls, texts };
}
for (const kind of ['task', 'scheduled']) test(`${kind} text timeout records issue without a duplicate successful Mac reminder`, t => {
  const f = fixture(t, kind);
  f.run(); f.run();
  const calls = readFileSync(f.calls, 'utf8').trim().split('\n');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /Call the client/);
  assert.doesNotMatch(calls[0], /unconfirmed/);
  assert.equal(readFileSync(f.texts, 'utf8').trim(), 'attempt');
  assert.equal(f.db.prepare("SELECT count(*) FROM cove_failure_inbox WHERE source='reminder-delivery'").pluck().get(), 1);
});
test('when the first Mac reminder fails, fallback preserves task context and opens that task', t => {
  const f = fixture(t, 'task', true); f.run();
  const calls = readFileSync(f.calls, 'utf8').trim().split('\n');
  assert.equal(calls.length, 2);
  assert.match(calls[1], /Call the client.*Text delivery is unconfirmed/);
  assert.match(calls[1], /task=task-fixture/);
  assert.doesNotMatch(calls[1], /\/failures/);
});

test('SSH connection timeout is a known pre-handoff failure, command timeout remains uncertain', () => {
  assert.equal(textDeliveryUncertain('Command failed: ssh fixture\nssh: connect to host fixture port 22: Operation timed out'), false);
  assert.equal(textDeliveryUncertain(new Error('spawnSync ssh ETIMEDOUT')), true);
  assert.equal(textDeliveryUncertain('execution error: timed out waiting for Messages'), true);
  assert.equal(textDeliveryUncertain('Configured text channel is unavailable.'), false);
});
