import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { attachBuddyRun } from '../src/app/api/buddy/turn/implementation.ts';
import { createBuddyStore } from '../src/lib/buddy/store.ts';
import { isProviderMissing, isProviderNotSignedIn } from '../src/lib/buddy/errors.ts';

function setup(t) {
  const file = path.join(os.tmpdir(), `cove-buddy-first-run-${process.pid}-${Date.now()}-${Math.random()}.db`);
  const store = createBuddyStore({ dbPath: file, now: () => new Date('2026-09-21T16:00:00.000Z') });
  t.after(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  });
  return store;
}

function claim(store) {
  return store.claimTurn({
    userText: 'How do I close my day?', pageContext: null, model: 'sonnet', effort: 'medium',
    routerReason: 'General conversation',
  });
}

async function runWithRejection(t, message) {
  const store = setup(t);
  const turn = claim(store);
  const events = [];
  await attachBuddyRun({
    store,
    turn,
    buildCommand: () => ({ executable: 'claude', args: [], stdin: '' }),
    runCommand: async () => { throw new Error(message); },
    send: (event) => events.push(event),
    close: () => {},
  });
  return { finished: store.getTurn(turn.id), events };
}

// Buddy is the most inviting control on every screen, and on a machine whose
// CLI is not installed or not signed in it is the first thing a new person
// touches. Every rejection used to land on "interrupted", which the screen
// renders as "Buddy was interrupted." above a Retry that cannot work.
test('a lapsed provider sign-in is reported as a sign-in, not an interruption', async (t) => {
  const { finished, events } = await runWithRejection(
    t,
    'missing_result:1:Invalid API key · Please run /login',
  );
  assert.equal(finished.state, 'failed');
  assert.equal(finished.error_code, 'not_signed_in');
  assert.deepEqual(events.at(-1), { kind: 'failed', errorCode: 'not_signed_in' });
});

test('a provider command that is not installed is named as missing', async (t) => {
  const { finished } = await runWithRejection(t, 'spawn /Users/someone/.local/bin/claude ENOENT');
  assert.equal(finished.error_code, 'provider_missing');
});

test('an ordinary execution failure is still an interruption', async (t) => {
  const { finished } = await runWithRejection(t, 'missing_result:1:');
  assert.equal(finished.error_code, 'interrupted');
});

test('a timeout keeps its own code', async (t) => {
  const { finished } = await runWithRejection(t, 'timeout');
  assert.equal(finished.error_code, 'timeout');
});

test('the detectors read the shapes the two CLIs actually produce', () => {
  assert.equal(isProviderNotSignedIn('claude', 'missing_result:1:Please run /login'), true);
  assert.equal(isProviderNotSignedIn('codex', 'missing_result:1:You must sign in first'), true);
  assert.equal(isProviderNotSignedIn('codex', 'missing_result:1:stream disconnected'), false);
  assert.equal(isProviderNotSignedIn('claude', 'missing_result:1:'), false);
  assert.equal(isProviderMissing('spawn codex ENOENT'), true);
  assert.equal(isProviderMissing('missing_result:1:'), false);
});

// The screen is what the person reads, so the codes have to reach it.
test('the message component acts on both codes', () => {
  const source = readFileSync(new URL('../src/components/buddy/BuddyMessage.tsx', import.meta.url), 'utf8');
  assert.match(source, /error_code === 'not_signed_in'/);
  assert.match(source, /error_code === 'provider_missing'/);
  assert.match(source, /Ask your Cove setup agent to install it/);
});

// Nothing reached the server log either, so a person helping from another
// machine had no diagnostic at all.
test('the route logs what the provider said', () => {
  const source = readFileSync(new URL('../src/app/api/buddy/turn/implementation.ts', import.meta.url), 'utf8');
  assert.match(source, /console\.error\("Buddy turn failed\."/);
});
