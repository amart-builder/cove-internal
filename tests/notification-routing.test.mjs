import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
import { remoteIMessageArgs } from '../src/lib/intake/notification-transport.mjs';

function fixture(t) {
  const dir = path.join(
    os.tmpdir(),
    `forge-notification-routing-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  const bin = path.join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const calls = path.join(dir, 'calls.log');
  writeFileSync(
    path.join(bin, 'ssh'),
    '#!/bin/sh\nexit 1\n',
  );
  writeFileSync(
    path.join(bin, 'osascript'),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FORGE_TEST_CALLS"\n',
  );
  chmodSync(path.join(bin, 'ssh'), 0o700);
  chmodSync(path.join(bin, 'osascript'), 0o700);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, bin, calls };
}

test('remote iMessage failure falls back to native notification but reports non-delivery', (t) => {
  const { dir, bin, calls } = fixture(t);
  const config = path.join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({
    channel: 'imessage',
    imessage_to: '+13105550123',
    remote_host: 'alex@100.102.6.81',
  }));
  const result = spawnSync(
    process.execPath,
    ['scripts/forge-notify.mjs', 'Client needs attention'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FORGE_REMINDER_CONFIG_PATH: config,
        FORGE_TEST_CALLS: calls,
      },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /remote iMessage failed/);
  assert.match(result.stderr, /"delivered":false/);
  assert.match(readFileSync(calls, 'utf8'), /display notification/);
});

test('remote iMessage argv safely quotes hostile AppleScript and shell text', () => {
  const hostile = "He said \"go\" `whoami` $(touch /tmp/forge-pwned) and it's urgent";
  const args = remoteIMessageArgs(
    'alex@100.102.6.81',
    '+13105550123',
    hostile,
  );
  assert.deepEqual(args.slice(0, 5), [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    'alex@100.102.6.81',
  ]);
  assert.match(args[5], /^osascript -e '/);
  assert.match(args[5], /`whoami`/);
  assert.match(args[5], /\$\(touch \/tmp\/forge-pwned\)/);
  assert.equal(args[5].includes(`'"'"'`), true);
  assert.equal(args[5].endsWith("'"), true);
});

test('the reminders tick fires and removes a due scheduled intake entry', (t) => {
  const { dir, bin, calls } = fixture(t);
  const config = path.join(dir, 'config.json');
  const dbPath = path.join(dir, 'forge.db');
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
  const result = spawnSync(process.execPath, ['scripts/forge-reminders.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FORGE_DB_PATH: dbPath,
      FORGE_REMINDER_CONFIG_PATH: config,
      FORGE_TEST_CALLS: calls,
    },
  });
  assert.equal(result.status, 0);
  assert.equal(existsSync(entry), false);
  assert.match(readFileSync(calls, 'utf8'), /Review the proposal/);
});

test('the reminders tick retains a due entry when every delivery path fails', (t) => {
  const { dir, bin } = fixture(t);
  writeFileSync(path.join(bin, 'osascript'), '#!/bin/sh\nexit 1\n');
  const config = path.join(dir, 'config.json');
  const dbPath = path.join(dir, 'forge.db');
  const reminders = path.join(dir, 'reminders');
  const entry = path.join(reminders, 'scheduled-task-2.json');
  mkdirSync(reminders);
  writeFileSync(config, '{"channel":"none"}');
  writeFileSync(entry, JSON.stringify({
    id: 'task-2',
    task_id: 'task-2',
    title: 'Keep trying this reminder',
    surface_at: '2020-01-01T09:00:00.000Z',
  }));
  const result = spawnSync(process.execPath, ['scripts/forge-reminders.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FORGE_DB_PATH: dbPath,
      FORGE_REMINDER_CONFIG_PATH: config,
    },
  });
  assert.equal(result.status, 0);
  assert.equal(existsSync(entry), true);
  assert.match(result.stderr, /native notification failed/);
});

test('a failed remote iMessage keeps the receipt even when native succeeds', (t) => {
  const { dir, bin, calls } = fixture(t);
  const config = path.join(dir, 'config.json');
  const dbPath = path.join(dir, 'forge.db');
  const reminders = path.join(dir, 'reminders');
  const entry = path.join(reminders, 'scheduled-task-3.json');
  mkdirSync(reminders);
  writeFileSync(config, JSON.stringify({
    channel: 'imessage',
    imessage_to: '+13105550123',
    remote_host: 'alex@100.102.6.81',
  }));
  writeFileSync(entry, JSON.stringify({
    id: 'task-3',
    task_id: 'task-3',
    title: 'Remote delivery must settle this',
    surface_at: '2020-01-01T09:00:00.000Z',
  }));
  const result = spawnSync(process.execPath, ['scripts/forge-reminders.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FORGE_DB_PATH: dbPath,
      FORGE_REMINDER_CONFIG_PATH: config,
      FORGE_TEST_CALLS: calls,
    },
  });
  assert.equal(result.status, 0);
  assert.equal(existsSync(entry), true);
  assert.match(result.stderr, /configured channel failed/);
  assert.match(readFileSync(calls, 'utf8'), /Remote delivery must settle this/);
});
