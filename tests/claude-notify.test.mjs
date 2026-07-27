import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  createExecutionNotifier,
  MAX_NOTIFICATION_DEDUPE_ENTRIES,
  notificationCopy,
  notifyExecutionRun,
  rememberNotificationTransition,
  sanitizeNotificationText,
} from '../src/lib/claude-execution/notify.ts';

const TRANSITIONED_AT = '2026-07-16T18:00:00.000Z';
const PROCESS_STARTED_AT = new Date('2026-07-16T17:59:00.000Z');

function closingChild(exitCode = 0) {
  const child = Object.assign(new EventEmitter(), { unref: () => undefined });
  queueMicrotask(() => child.emit('close', exitCode));
  return child;
}

function input(overrides = {}) {
  return {
    runId: 'run-123',
    state: 'plan_ready',
    itemTitle: 'Finish\nlaunch\u0000 brief',
    claudeSessionId: 'session with spaces',
    transitionedAt: TRANSITIONED_AT,
    ...overrides,
  };
}

test('terminal-notifier receives sanitized values as separate argv and dedupes a transition', async () => {
  const calls = [];
  const logs = [];
  const notify = createExecutionNotifier({
    env: { FORGE_NOTIFY: '1' },
    processStartedAt: PROCESS_STARTED_AT,
    exists: (candidate) => candidate === '/opt/homebrew/bin/terminal-notifier',
    spawnImpl: (executable, args, options) => {
      calls.push({ executable, args, options });
      return closingChild();
    },
    logger: (line) => logs.push(line),
  });

  await notify(input());
  await notify(input());

  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, '/opt/homebrew/bin/terminal-notifier');
  assert.deepEqual(calls[0].args, [
    '-title', 'Forge needs you',
    '-message', 'Plan ready: Finish launch brief. Claude has questions only you can answer.',
    '-group', 'forge-run-123',
    '-open', 'claude://resume?session=session%20with%20spaces',
  ]);
  assert.deepEqual(calls[0].options, { detached: true, stdio: 'ignore', shell: false });
  assert.deepEqual(logs, ['run-123 plan_ready delivered']);
});

test('notification gate and process-start guard suppress delivery without consuming a spawn', async () => {
  let spawns = 0;
  const spawnImpl = () => {
    spawns += 1;
    return closingChild();
  };
  await createExecutionNotifier({ env: {}, spawnImpl })(input());
  await createExecutionNotifier({
    env: { FORGE_NOTIFY: '1' },
    processStartedAt: new Date('2026-07-16T18:01:00.000Z'),
    spawnImpl,
  })(input());
  assert.equal(spawns, 0);
});

test('default notifier is a no-op and does not throw when FORGE_NOTIFY is unset', async () => {
  const previous = process.env.FORGE_NOTIFY;
  delete process.env.FORGE_NOTIFY;
  try {
    await assert.doesNotReject(notifyExecutionRun(input({ transitionedAt: new Date().toISOString() })));
  } finally {
    if (previous === undefined) delete process.env.FORGE_NOTIFY;
    else process.env.FORGE_NOTIFY = previous;
  }
});

test('notification transition dedupe evicts the oldest entry after 500 keys', () => {
  const transitions = new Set();
  for (let index = 0; index < MAX_NOTIFICATION_DEDUPE_ENTRIES; index += 1) {
    assert.equal(rememberNotificationTransition(transitions, `run-${index}:plan_ready`), true);
  }
  assert.equal(rememberNotificationTransition(transitions, 'run-new:plan_ready'), true);
  assert.equal(transitions.size, MAX_NOTIFICATION_DEDUPE_ENTRIES);
  assert.equal(transitions.has('run-0:plan_ready'), false);
  assert.equal(transitions.has('run-1:plan_ready'), true);
  assert.equal(transitions.has('run-new:plan_ready'), true);
  assert.equal(rememberNotificationTransition(transitions, 'run-new:plan_ready'), false);
});

test('notification spawn failure is contained and logged once', async () => {
  const logs = [];
  const notify = createExecutionNotifier({
    env: { FORGE_NOTIFY: '1' },
    processStartedAt: PROCESS_STARTED_AT,
    exists: () => true,
    spawnImpl: () => {
      throw new Error('spawn failed');
    },
    logger: (line) => logs.push(line),
  });
  await assert.doesNotReject(notify(input({ state: 'failed', claudeSessionId: undefined })));
  assert.deepEqual(logs, ['run-123 failed failed']);
});

test('osascript fallback keeps user text in argv and has no click action', async () => {
  const calls = [];
  const notify = createExecutionNotifier({
    env: { FORGE_NOTIFY: '1' },
    processStartedAt: PROCESS_STARTED_AT,
    exists: () => false,
    spawnImpl: (executable, args, options) => {
      calls.push({ executable, args, options });
      return closingChild();
    },
    logger: () => undefined,
  });
  await notify(input({ state: 'failed', claudeSessionId: undefined }));
  assert.equal(calls[0].executable, '/usr/bin/osascript');
  assert.deepEqual(calls[0].args.slice(-3), [
    '--',
    'Forge',
    "Didn't finish: Finish launch brief. Open Forge to restart it.",
  ]);
  assert.equal(calls[0].args.includes('http://127.0.0.1:3200/tasks'), false);
});

test('terminal-notifier opens the Forge board when a session reference is absent', async () => {
  const calls = [];
  const notify = createExecutionNotifier({
    env: { FORGE_NOTIFY: '1' },
    processStartedAt: PROCESS_STARTED_AT,
    exists: () => true,
    spawnImpl: (executable, args, options) => {
      calls.push({ executable, args, options });
      return closingChild();
    },
    logger: () => undefined,
  });
  await notify(input({ claudeSessionId: undefined }));
  assert.deepEqual(calls[0].args.slice(-2), [
    '-open',
    'http://127.0.0.1:3200/tasks',
  ]);
});

test('notification copy is limited to needs-you states and strips controls', () => {
  assert.equal(sanitizeNotificationText('A\nB\u0007C'), 'A B C');
  assert.equal(notificationCopy(input({ state: 'queued' })), undefined);
  assert.equal(notificationCopy(input({ state: 'running' })), undefined);
  assert.equal(notificationCopy(input({ state: 'cancelled' })), undefined);
  const long = notificationCopy(input({ itemTitle: 'x'.repeat(200) }));
  assert.ok(long.body.length <= 100);
});
