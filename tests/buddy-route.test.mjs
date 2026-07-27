import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { attachBuddyRun, prepareBuddyRecentTurns } from '../src/app/api/buddy/turn/route.ts';
import {
  BUDDY_STALE_TURN_MS,
  prepareBuddySessionReset,
} from '../src/app/api/buddy/session/route.ts';
import { createBuddyStore } from '../src/lib/buddy/store.ts';
import { BUDDY_MAX_TURN_MS } from '../src/lib/buddy/timing.ts';

function setup(t) {
  const file = path.join(os.tmpdir(), `forge-buddy-route-${process.pid}-${Date.now()}-${Math.random()}.db`);
  let now = new Date('2026-07-15T20:00:00.000Z');
  const store = createBuddyStore({ dbPath: file, now: () => now });
  t.after(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  });
  return { store, advance: (milliseconds) => { now = new Date(now.getTime() + milliseconds); } };
}

function claim(store) {
  return store.claimTurn({
    userText: 'Hello', pageContext: null, model: 'sonnet', effort: 'medium',
    routerReason: 'General conversation',
  });
}

test('stale turns cannot be swept during the longest compaction chain', () => {
  assert.ok(BUDDY_STALE_TURN_MS > BUDDY_MAX_TURN_MS);
});

test('session reset sweeps turns just beyond the stale threshold before resetting', (t) => {
  const { store, advance } = setup(t);
  const turn = claim(store);
  advance(BUDDY_STALE_TURN_MS + 1);
  const reset = prepareBuddySessionReset(store);
  assert.ok(reset);
  assert.equal(store.getTurn(turn.id).error_code, 'interrupted');
  assert.equal(reset.headSessionId, null);
});

test('restart recovery sweeps stale running turns before recent history, claim, and reset', (t) => {
  const { store, advance } = setup(t);
  const staleBeforeHistory = claim(store);
  advance(BUDDY_STALE_TURN_MS + 1);
  const recent = prepareBuddyRecentTurns(store, 50);
  assert.equal(recent.find((turn) => turn.id === staleBeforeHistory.id).state, 'failed');
  const next = claim(store);
  assert.ok(next);
  store.finishTurn(next.id, { state: 'succeeded', assistant_text: 'Recovered' });

  const staleBeforeReset = claim(store);
  advance(BUDDY_STALE_TURN_MS + 1);
  const reset = prepareBuddySessionReset(store);
  assert.ok(reset);
  assert.equal(store.getTurn(staleBeforeReset.id).error_code, 'interrupted');
  assert.equal(reset.headSessionId, null);
});

test('a synchronous launch preparation failure finishes the claimed turn', (t) => {
  const { store } = setup(t);
  const turn = claim(store);
  const events = [];
  let closed = false;
  attachBuddyRun({
    store,
    turn,
    buildCommand: () => { throw new Error('spawn setup failed'); },
    send: (event) => events.push(event),
    close: () => { closed = true; },
  });
  assert.equal(store.getTurn(turn.id).state, 'failed');
  assert.equal(store.getTurn(turn.id).error_code, 'spawn_failed');
  assert.deepEqual(events, [{ kind: 'failed', errorCode: 'spawn_failed' }]);
  assert.equal(closed, true);
});

test('an errored result persists partial streamed text when resultText is empty', async (t) => {
  const { store } = setup(t);
  const turn = claim(store);
  await attachBuddyRun({
    store,
    turn,
    buildCommand: () => ({ executable: 'claude', args: [], stdin: '' }),
    runCommand: async (_command, onEvent) => {
      onEvent({ kind: 'delta', text: 'Partial ' });
      onEvent({ kind: 'delta', text: 'answer' });
      return {
        kind: 'done', resultText: '', sessionId: 'error-session', costUsd: 0.1,
        isError: true, errorSubtype: 'budget_exceeded',
      };
    },
    send: () => {},
    close: () => {},
  });
  const finished = store.getTurn(turn.id);
  assert.equal(finished.state, 'failed');
  assert.equal(finished.assistant_text, 'Partial answer');
  assert.equal(store.getBuddyState().headSessionId, 'error-session');
});

test('a successful resolved run persists success and advances the session head', async (t) => {
  const { store } = setup(t);
  const turn = claim(store);
  await attachBuddyRun({
    store,
    turn,
    buildCommand: () => ({ executable: 'claude', args: [], stdin: '' }),
    runCommand: async (_command, onEvent) => {
      const done = {
        kind: 'done', resultText: 'pong', sessionId: 'success-session', costUsd: 0.02,
        isError: false,
      };
      onEvent(done);
      return done;
    },
    send: () => {},
    close: () => {},
  });
  const finished = store.getTurn(turn.id);
  assert.equal(finished.state, 'succeeded');
  assert.equal(finished.assistant_text, 'pong');
  assert.equal(store.getBuddyState().headSessionId, 'success-session');
});

test('a resumed context overflow compacts into a fresh session and retries once', async (t) => {
  const { store } = setup(t);
  store.setHeadSession('old-head');
  const turn = claim(store);
  const events = [];
  const commands = [];
  let run = 0;
  await attachBuddyRun({
    store,
    turn,
    buildCommand: () => ({ executable: 'claude', args: ['initial'], stdin: 'original' }),
    compaction: {
      buildSummaryCommand: () => ({ executable: 'claude', args: ['summary'], stdin: 'summarize' }),
      buildSeedCommand: (summary) => ({ executable: 'claude', args: ['seed'], stdin: summary }),
      buildRetryCommand: (head) => ({ executable: 'claude', args: ['retry', head], stdin: 'original' }),
    },
    runCommand: async (command, onEvent) => {
      commands.push(command);
      run += 1;
      if (run === 1) {
        onEvent({
          kind: 'data-result',
          changes: [{ table: 'tasks', action: 'update', id: 'initial-write', summary: 'Initial write' }],
          sessions: [{ sessionId: 'initial-session', dir: '/tmp/initial', title: 'Initial session' }],
          errors: [],
        });
        return {
          kind: 'done', resultText: 'context window exceeded', sessionId: 'old-head', costUsd: 0.01,
          isError: true, errorSubtype: 'context_length_exceeded',
        };
      }
      if (run === 2) return {
        kind: 'done', resultText: 'Compact handoff', sessionId: 'old-head', costUsd: 0.02,
        isError: false,
      };
      if (run === 3) return {
        kind: 'done', resultText: 'Ready.', sessionId: 'fresh-seed', costUsd: 0.03,
        isError: false,
      };
      onEvent({
        kind: 'data-result',
        changes: [{ table: 'tasks', action: 'update', id: 'retry-write', summary: 'Retry write' }],
        sessions: [{ sessionId: 'retry-session', dir: '/tmp/retry', title: 'Retry session' }],
        errors: [],
      });
      const resultText = 'Retried answer\n```forge-receipts\n' + JSON.stringify({
        changes: [
          { table: 'tasks', action: 'update', id: 'initial-write', summary: 'Initial write' },
          { table: 'tasks', action: 'update', id: 'retry-write', summary: 'Retry write' },
        ],
        pendingDeletes: [],
        sessions: [
          { sessionId: 'initial-session', dir: '/tmp/initial', title: 'Initial session' },
          { sessionId: 'retry-session', dir: '/tmp/retry', title: 'Retry session' },
        ],
      }) + '\n```';
      onEvent({ kind: 'delta', text: resultText });
      return {
        kind: 'done', resultText, sessionId: 'fresh-retry', costUsd: 0.04,
        isError: false,
      };
    },
    send: (event) => events.push(event),
    close: () => {},
  });
  assert.deepEqual(commands.map((command) => command.args[0]), ['initial', 'summary', 'seed', 'retry']);
  assert.equal(commands[2].stdin, 'Compact handoff');
  assert.deepEqual(commands[3].args, ['retry', 'fresh-seed']);
  const finished = store.getTurn(turn.id);
  assert.equal(finished.state, 'succeeded');
  assert.equal(finished.assistant_text, 'Retried answer');
  assert.equal(finished.cost_usd, 0.1);
  const receipts = JSON.parse(finished.receipts_json);
  assert.deepEqual(receipts.changes.map((change) => change.id), ['retry-write']);
  assert.deepEqual(receipts.sessions.map((session) => session.sessionId), ['retry-session']);
  assert.equal(store.getBuddyState().headSessionId, 'fresh-retry');
  assert.equal(events[0].kind, 'compacting');
  assert.equal(events.at(-1).kind, 'done');
});

test('a successful run strips and persists receipt metadata before sending done', async (t) => {
  const { store } = setup(t);
  const turn = claim(store);
  const events = [];
  await attachBuddyRun({
    store,
    turn,
    buildCommand: () => ({ executable: 'claude', args: [], stdin: '' }),
    runCommand: async (_command, onEvent) => {
      onEvent({
        kind: 'data-result',
        changes: [{ table: 'tasks', action: 'update', id: 't1', summary: "Updated 'Gym'" }],
        sessions: [],
        errors: [],
      });
      const done = {
        kind: 'done',
        resultText: 'Done\n```forge-receipts\n{"changes":[{"table":"tasks","action":"update","id":"t1","summary":"Moved Gym"}],"pendingDeletes":[]}\n```',
        sessionId: 'receipt-session', costUsd: 0.02, isError: false,
      };
      onEvent(done);
      return done;
    },
    send: (event) => events.push(event),
    close: () => {},
  });
  const finished = store.getTurn(turn.id);
  assert.equal(finished.assistant_text, 'Done');
  assert.equal(JSON.parse(finished.receipts_json).changes[0].id, 't1');
  assert.equal(events.length, 1);
  assert.equal(events[0].resultText, 'Done');
  assert.equal(events[0].receipts.changes[0].summary, 'Moved Gym');
});

test('a model change claim without a matching CLI receipt is not persisted or sent', async (t) => {
  const { store } = setup(t);
  const turn = claim(store);
  const events = [];
  await attachBuddyRun({
    store,
    turn,
    buildCommand: () => ({ executable: 'claude', args: [], stdin: '' }),
    runCommand: async () => ({
      kind: 'done',
      resultText: 'Deleted it\n```forge-receipts\n{"changes":[{"table":"contacts","action":"delete","id":"c1","summary":"Deleted Jane"}],"pendingDeletes":[]}\n```',
      sessionId: 'unbacked-receipt-session', costUsd: 0.02, isError: false,
    }),
    send: (event) => events.push(event),
    close: () => {},
  });
  const finished = store.getTurn(turn.id);
  assert.equal(finished.assistant_text, 'Deleted it');
  assert.equal(finished.receipts_json, null);
  assert.equal('receipts' in events[0], false);
});

test('a completeTurn exception is recorded and logged as persist_failed, not interrupted', async (t) => {
  const { store } = setup(t);
  const turn = claim(store);
  const originalCompleteTurn = store.completeTurn;
  const originalConsoleError = console.error;
  const logs = [];
  store.completeTurn = () => { throw new Error('database write failed'); };
  console.error = (...values) => logs.push(values);
  t.after(() => {
    store.completeTurn = originalCompleteTurn;
    console.error = originalConsoleError;
  });
  await attachBuddyRun({
    store,
    turn,
    buildCommand: () => ({ executable: 'claude', args: [], stdin: '' }),
    runCommand: async () => ({
      kind: 'done', resultText: 'pong', sessionId: 'success-session', costUsd: 0.02,
      isError: false,
    }),
    send: () => {},
    close: () => {},
  });
  assert.equal(store.getTurn(turn.id).state, 'failed');
  assert.equal(store.getTurn(turn.id).error_code, 'persist_failed');
  assert.equal(logs.length, 1);
  assert.match(logs[0][0], /persistence failed/i);
});

test('a timed-out turn persists and surfaces writes completed before interruption', async (t) => {
  const { store } = setup(t);
  const turn = claim(store);
  const events = [];
  await attachBuddyRun({
    store,
    turn,
    buildCommand: () => ({ executable: 'claude', args: [], stdin: '' }),
    runCommand: async (_command, onEvent) => {
      onEvent({
        kind: 'data-result',
        changes: [{ table: 'tasks', action: 'update', id: 't1', summary: 'Updated Gym' }],
        sessions: [],
        errors: [],
      });
      throw new Error('timeout');
    },
    send: (event) => events.push(event),
    close: () => {},
  });
  const finished = store.getTurn(turn.id);
  assert.equal(finished.state, 'failed');
  assert.equal(finished.error_code, 'timeout');
  assert.equal(JSON.parse(finished.receipts_json).changes[0].table, 'tasks');
  assert.equal(events[0].kind, 'failed');
  assert.equal(events[0].receipts.changes[0].id, 't1');
});
