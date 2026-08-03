import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openLocalDatabase } from '../src/lib/local/database.ts';
import { recordReceipt } from '../src/lib/reliability/receipts.ts';
import { currentCoveReadiness } from '../src/lib/health/readiness.ts';
import { createCoveReadinessStore } from '../src/components/tasks/useCoveReadiness.ts';
import { emailEmptyStateMessage } from '../src/components/tasks/EmailCardDetail.tsx';

function markEmailConfigured(dir) {
  writeFileSync(path.join(dir, 'cove-workspace.json'), '{}\n');
}

test('readiness distinguishes fresh email from unavailable worker state', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-readiness-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'cove.db');
  openLocalDatabase(dbPath).close();
  markEmailConfigured(dir);
  recordReceipt({
    dbPath,
    source: 'email-triage',
    startedAt: '2026-07-31T16:00:00.000Z',
    finishedAt: '2026-07-31T16:01:00.000Z',
    summary: 'Inbox checked.',
    outcome: 'success',
  });
  const readiness = currentCoveReadiness({
    dbPath,
    now: new Date('2026-07-31T17:00:00.000Z'),
    workerAvailable: false,
  });
  assert.equal(readiness.email.state, 'ready');
  assert.equal(readiness.worker.state, 'unavailable');
  assert.equal(readiness.writer.state, 'waiting');
});

test('a failed latest inbox check cannot render as ready', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-readiness-failed-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'cove.db');
  openLocalDatabase(dbPath).close();
  markEmailConfigured(dir);
  for (const [finishedAt, outcome] of [
    ['2026-07-31T16:00:00.000Z', 'success'],
    ['2026-07-31T16:30:00.000Z', 'failed'],
  ]) {
    recordReceipt({
      dbPath,
      source: 'email-triage',
      startedAt: finishedAt,
      finishedAt,
      summary: `Inbox ${outcome}.`,
      outcome,
    });
  }
  assert.equal(currentCoveReadiness({
    dbPath,
    now: new Date('2026-07-31T17:00:00.000Z'),
    workerAvailable: true,
  }).email.state, 'unavailable');
});

test('a partial inbox check proves the email connection is ready and fresh', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-readiness-partial-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'cove.db');
  openLocalDatabase(dbPath).close();
  markEmailConfigured(dir);
  recordReceipt({
    dbPath,
    source: 'email-triage',
    startedAt: '2026-07-31T16:00:00.000Z',
    finishedAt: '2026-07-31T16:01:00.000Z',
    summary: 'Inbox checked with one deferred archive.',
    outcome: 'partial',
  });
  const email = currentCoveReadiness({
    dbPath,
    now: new Date('2026-07-31T17:00:00.000Z'),
    workerAvailable: true,
  }).email;
  assert.equal(email.state, 'ready');
  assert.equal(email.lastSuccessAt, '2026-07-31T16:01:00.000Z');
  assert.equal(email.lastRunOutcome, 'partial');
});

test('a fresh configured install waits for its first email and writer runs', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-readiness-fresh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'cove.db');
  openLocalDatabase(dbPath).close();
  markEmailConfigured(dir);

  const readiness = currentCoveReadiness({
    dbPath,
    now: new Date('2026-07-31T17:00:00.000Z'),
    workerAvailable: true,
  });
  assert.equal(readiness.email.state, 'waiting');
  assert.equal(readiness.writer.state, 'waiting');
});

test('an install without Google Workspace reports email as not set up', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-readiness-unconfigured-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'cove.db');
  openLocalDatabase(dbPath).close();

  const readiness = currentCoveReadiness({
    dbPath,
    now: new Date('2026-07-31T17:00:00.000Z'),
    workerAvailable: true,
  });
  assert.equal(readiness.email.state, 'not_configured');
  assert.equal(readiness.writer.state, 'waiting');
});

test('readiness consumers share one poll loop and stop it after the last unsubscribe', async () => {
  let fetches = 0;
  const intervals = [];
  const cleared = [];
  const store = createCoveReadinessStore({
    fetchImpl: async () => {
      fetches += 1;
      return new Response(JSON.stringify({ readiness: { email: { state: 'ready' } } }));
    },
    setIntervalImpl: (callback, delay) => {
      const timer = { callback, delay };
      intervals.push(timer);
      return timer;
    },
    clearIntervalImpl: (timer) => cleared.push(timer),
  });
  const unsubscribeFirst = store.subscribe(() => {});
  const unsubscribeSecond = store.subscribe(() => {});
  await store.load();
  assert.equal(fetches, 1);
  assert.equal(intervals.length, 1);
  unsubscribeFirst();
  assert.equal(cleared.length, 0);
  unsubscribeSecond();
  assert.deepEqual(cleared, intervals);
});

test('a non-local health response is not applicable and permanently stops polling', async () => {
  let fetches = 0;
  const intervals = [];
  const cleared = [];
  const store = createCoveReadinessStore({
    fetchImpl: async () => {
      fetches += 1;
      return new Response(null, { status: 409 });
    },
    setIntervalImpl: (callback, delay) => {
      const timer = { callback, delay };
      intervals.push(timer);
      return timer;
    },
    clearIntervalImpl: (timer) => cleared.push(timer),
  });
  const unsubscribe = store.subscribe(() => {});
  await store.load();
  assert.equal(store.getSnapshot().notApplicable, true);
  assert.equal(store.getSnapshot().error, undefined);
  assert.deepEqual(cleared, intervals);
  await store.load();
  assert.equal(fetches, 1);
  unsubscribe();
});

test('empty email copy distinguishes checking, ready, stale, and unsupported runtimes', () => {
  assert.equal(emailEmptyStateMessage({
    checking: true,
    notApplicable: false,
  }), 'No open email is recorded in Cove. Checking the inbox connection.');
  assert.equal(emailEmptyStateMessage({
    readinessState: 'ready',
    checking: false,
    notApplicable: false,
  }), 'Inbox is clear. Nothing needs you right now.');
  assert.equal(emailEmptyStateMessage({
    readinessState: 'not_configured',
    checking: false,
    notApplicable: false,
  }), 'Email is not set up in Cove.');
  assert.equal(emailEmptyStateMessage({
    readinessState: 'waiting',
    checking: false,
    notApplicable: false,
  }), 'No open email is recorded in Cove. Waiting for the first run.');
  assert.equal(emailEmptyStateMessage({
    readinessState: 'stale',
    checking: false,
    notApplicable: false,
  }), 'No open email is recorded in Cove, but the inbox check is stale or unavailable.');
  assert.equal(emailEmptyStateMessage({
    checking: false,
    notApplicable: true,
  }), 'Inbox is clear. Nothing needs you right now.');
});
