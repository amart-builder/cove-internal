import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildDayPlanCandidates } from '../src/lib/day-plan/candidates.ts';
import { createDayPlanStore } from '../src/lib/day-plan/store.ts';
import { evaluateScheduledBriefGate } from '../src/lib/day-plan/brief-gate.ts';
import {
  CLOSURE_RELAY_MAX_AGE_MS,
  writeDayClosureRelay,
} from '../src/lib/day-plan/brief-relay.ts';
import { mkdtempSync } from 'node:fs';
import { enqueueDueMorningBrief } from '../src/lib/claude-execution/worker.ts';
import { maybeQueueMorningBrief } from '../src/lib/day-plan/brief-triggers.ts';
import {
  briefProgress,
  briefRemainingLabel,
  estimateBriefSeconds,
  DEFAULT_BRIEF_ESTIMATE_SECONDS,
} from '../src/lib/day-plan/presentation.ts';

// ---------------------------------------------------------------------------
// Trigger wiring. The asymmetry is the whole design: settlement is never gated
// (gating it deadlocks forever), and the arrival backfill needs no gate because
// the schema will not let a blind backfill happen (proved against a real store
// below).
// ---------------------------------------------------------------------------

const TRIGGER_NOW = new Date('2026-07-24T15:30:00.000Z'); // morning closeout of Jul 23 in LA
const TZ = 'America/Los_Angeles';

function triggerStore({ eligible } = {}) {
  const enqueued = [];
  return {
    enqueued,
    getReadModel: () => ({ pendingReconciliations: [] }),
    listMorningBriefs: () => [],
    listPendingReconciliations: () => [],
    getPlan: (id) => ({ id, localDate: '2026-07-23', timezone: TZ }),
    latestEligibleMorningBrief: () => eligible,
    enqueueMorningBrief: (targetLocalDate, _provenance, options) => {
      enqueued.push({ targetLocalDate, options });
      return { created: true, brief: { id: `queued-${enqueued.length}` } };
    },
  };
}

test('late morning settlement queues today without requiring an older closure signal', () => {
  // The deadlock guard. If closing a day could itself be blocked by some older
  // day he will never close, no brief would ever be produced again.
  const store = triggerStore();
  maybeQueueMorningBrief(
    store,
    'settlement_commit',
    {
      plan: { id: 'plan-1', localDate: '2026-07-23', timezone: TZ },
      snapshot: { id: 'snap-1' },
      replayed: false,
    },
    TRIGGER_NOW,
  );
  assert.equal(store.enqueued.length, 1);
  assert.equal(store.enqueued[0].targetLocalDate, '2026-07-24');
});

test('the reconciliation-ack path enqueues exactly like the commit path', () => {
  const store = triggerStore();
  maybeQueueMorningBrief(
    store,
    'reconciliation_applied',
    {
      reconciliation: {
        id: 'r1',
        action: 'defer',
        snapshotId: 'snap-1',
        dayPlanId: 'plan-1',
        state: 'applied',
      },
      replayed: false,
    },
    TRIGGER_NOW,
  );
  assert.equal(store.enqueued.length, 1);
  assert.equal(store.enqueued[0].targetLocalDate, '2026-07-24');
});

test('the arrival backfill queues for today, and waits on a live peer attempt', () => {
  // 16:00 UTC on Jul 24 is the morning of Jul 24 in LA.
  const morning = new Date('2026-07-24T16:00:00.000Z');
  const allowed = triggerStore();
  maybeQueueMorningBrief(
    allowed,
    'arrival_open',
    { plan: { id: 'p', state: 'proposed', localDate: '2026-07-24', timezone: TZ }, replayed: false },
    morning,
  );
  assert.equal(allowed.enqueued.length, 1);
  assert.equal(allowed.enqueued[0].targetLocalDate, '2026-07-24');

  // The other machine is mid-generation for the same date: wait for its artifact
  // to sync rather than paying for a second one.
  const waiting = triggerStore();
  maybeQueueMorningBrief(
    waiting,
    'arrival_open',
    { plan: { id: 'p', state: 'proposed', localDate: '2026-07-24', timezone: TZ }, replayed: false },
    morning,
    { isRemoteAttemptLive: () => true },
  );
  assert.deepEqual(waiting.enqueued, []);
});

test('arrival backfill leaves a started or already arranged day alone', () => {
  for (const detail of [
    { state: 'active' },
    { state: 'proposed', arrivalInteractedAt: '2026-07-24T15:59:00.000Z' },
  ]) {
    const store = triggerStore();
    maybeQueueMorningBrief(store, 'arrival_open', {
      plan: { id: 'p', localDate: '2026-07-24', timezone: TZ, ...detail }, replayed: false,
    }, new Date('2026-07-24T16:00:00.000Z'));
    assert.deepEqual(store.enqueued, []);
  }
});

// ---------------------------------------------------------------------------
// Store: the gate's real data source, and the progress bar's real inputs.
// ---------------------------------------------------------------------------

function isolatedStore(t, initialClock = '2026-07-24T16:00:00.000Z') {
  const file = path.join(
    os.tmpdir(),
    `cove-brief-gate-${process.pid}-${Date.now()}-${Math.random()}.db`,
  );
  let clock = new Date(initialClock);
  const store = createDayPlanStore({ dbPath: file, now: () => new Date(clock) });
  t.after(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  });
  return { store, setClock: (value) => { clock = new Date(value); } };
}

function ensureFor(store, localDate, attempt = 1) {
  return store.ensureDayPlan({
    localDate,
    timezone: TZ,
    // Attempt keeps the mutation id unique: a replayed ensure returns the plan
    // the first call produced, which would hide the transition being asserted.
    mutationId: `ensure:${localDate}:${attempt}`,
    candidates: buildDayPlanCandidates({
      localDate,
      timezone: TZ,
      tasks: [
        {
          id: `task-${localDate}`,
          title: 'Ship the gate',
          description: 'Ship the gate',
          priority: 'high',
          position: 0,
          column: 'today',
          status: 'open',
          updatedAt: `${localDate}T15:00:00.000Z`,
          refreshedAt: `${localDate}T16:00:00.000Z`,
        },
      ],
    }),
  }).plan;
}

// day_plans.open_slot is UNIQUE, so at most one unsettled plan exists and
// ensureDayPlan hands back that open plan whatever date you ask for. Any fixture
// spanning several days has to close each one before the next exists at all.
function settleFully(store, initial) {
  let current = initial;
  const step = (action, patch = {}) =>
    (current = store.mutateDayPlan({
      planId: current.id,
      mutationId: `${action}:${current.id}:${current.version}`,
      expectedVersion: current.version,
      action,
      ...patch,
    }).plan);
  step('arrival_open');
  step('start_day');
  step('settlement_start');
  for (const item of current.items) {
    step('settlement_decide', { itemId: item.id, disposition: 'carry' });
  }
  step('settlement_commit', { completedHumanTaskIds: [] });
  return current;
}

test('an unclosed yesterday makes a plan dated today unrepresentable', (t) => {
  // This is why the arrival backfill needs no local closure gate. open_slot is
  // UNIQUE and ensureDayPlan returns the open plan whatever date it is asked
  // for, so asking for today while Jul 23 is still open hands back Jul 23. The
  // backfill's own "only today's arrival regenerates" check then declines, and
  // the brief it would have written blind is never queued.
  const { store } = isolatedStore(t);
  const previous = ensureFor(store, '2026-07-23');
  assert.equal(previous.localDate, '2026-07-23');

  const today = ensureFor(store, '2026-07-24');
  assert.equal(today.id, previous.id);
  assert.equal(today.localDate, '2026-07-23');

  // Close it, and only then does today become its own plan.
  settleFully(store, today);
  const fresh = ensureFor(store, '2026-07-24', 2);
  assert.notEqual(fresh.id, previous.id);
  assert.equal(fresh.localDate, '2026-07-24');
});

test('a forced brief never double-queues', (t) => {
  const { store } = isolatedStore(t);
  const provenance = { modelAlias: 'sonnet', effort: 'medium', budgetUsd: 1 };
  const first = store.enqueueMorningBrief('2026-07-24', provenance);
  assert.equal(first.created, true);

  // A double tap on "write it anyway" must not start a second generation.
  const second = store.enqueueMorningBrief('2026-07-24', provenance);
  assert.equal(second.created, false);
  assert.equal(second.brief.id, first.brief.id);
});

test('recent brief durations feed the estimate and ignore unfinished runs', (t) => {
  const { store, setClock } = isolatedStore(t);
  const provenance = { modelAlias: 'sonnet', effort: 'medium', budgetUsd: 1 };
  const run = (date, seconds) => {
    setClock(`${date}T14:00:00.000Z`);
    store.enqueueMorningBrief(date, provenance);
    const claimed = store.claimNextMorningBrief();
    setClock(new Date(Date.parse(`${date}T14:00:00.000Z`) + seconds * 1000).toISOString());
    store.completeMorningBrief(claimed.id, JSON.stringify({ lensNarrative: 'x' }));
    return claimed.id;
  };
  run('2026-07-20', 90);
  run('2026-07-21', 120);
  run('2026-07-22', 180);
  // Queued but never finished: no honest duration, so it must not count.
  store.enqueueMorningBrief('2026-07-23', provenance);

  const durations = store.recentBriefDurationsSeconds();
  assert.deepEqual(durations, [180, 120, 90]);
  assert.equal(estimateBriefSeconds(durations), 120);
});

// ---------------------------------------------------------------------------
// The scheduled gate. This is the one that runs in production: the 7:30 cron
// lives on the Mini, whose own day_plans is stale by design, so it may only ever
// read the closure fact the ritual machine publishes.
// ---------------------------------------------------------------------------

function relayDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-closure-relay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Stands in for the ritual machine: publishes whatever closure facts it is told.
function publisher(openLocalDate, latestLocalDate) {
  return { dayClosureFacts: () => ({ openLocalDate, latestLocalDate }) };
}

test('no published signal is no opinion, never a block', (t) => {
  const dataDir = relayDir(t);
  // An empty relay directory is exactly what a fresh install, an unsynced peer,
  // or an older build on the other machine looks like. Blocking here would stop
  // the morning brief forever with nothing on either machine explaining why.
  assert.deepEqual(evaluateScheduledBriefGate({ targetLocalDate: '2026-07-24', dataDir }), {
    blocked: false,
    reason: 'no_closure_signal',
  });
});

test('the peer machine publishes an open day, and the cron machine holds', (t) => {
  const dataDir = relayDir(t);
  const now = new Date('2026-07-24T14:30:00.000Z');
  assert.equal(
    writeDayClosureRelay({ store: publisher('2026-07-23', '2026-07-23'), dataDir, now }),
    true,
  );
  const verdict = evaluateScheduledBriefGate({
    targetLocalDate: '2026-07-24',
    dataDir,
    now,
  });
  assert.equal(verdict.blocked, true);
  assert.equal(verdict.unclosedLocalDate, '2026-07-23');
});

test('a closed peer, and a peer whose only open plan is today, both allow', (t) => {
  const now = new Date('2026-07-24T14:30:00.000Z');
  const closed = relayDir(t);
  writeDayClosureRelay({ store: publisher(null, '2026-07-23'), dataDir: closed, now });
  assert.equal(
    evaluateScheduledBriefGate({ targetLocalDate: '2026-07-24', dataDir: closed, now }).blocked,
    false,
  );
  // He already started today on the other machine. That is today's own plan, not
  // unfinished yesterday, so it must never block today's brief.
  const workingToday = relayDir(t);
  writeDayClosureRelay({
    store: publisher('2026-07-24', '2026-07-24'),
    dataDir: workingToday,
    now,
  });
  assert.equal(
    evaluateScheduledBriefGate({ targetLocalDate: '2026-07-24', dataDir: workingToday, now })
      .blocked,
    false,
  );
});

test('a stale published fact expires into no opinion rather than a stuck block', (t) => {
  const dataDir = relayDir(t);
  const written = new Date('2026-07-20T14:30:00.000Z');
  writeDayClosureRelay({ store: publisher('2026-07-19', '2026-07-19'), dataDir, now: written });
  const later = new Date(written.getTime() + CLOSURE_RELAY_MAX_AGE_MS + 60_000);
  // The publisher has been off for over a day. Its last word must not keep the
  // brief switched off indefinitely.
  assert.deepEqual(
    evaluateScheduledBriefGate({ targetLocalDate: '2026-07-24', dataDir, now: later }),
    { blocked: false, reason: 'no_closure_signal' },
  );
});

test('a stale peer cannot clobber a fresher published fact', (t) => {
  const dataDir = relayDir(t);
  const now = new Date('2026-07-24T14:30:00.000Z');
  writeDayClosureRelay({ store: publisher(null, '2026-07-23'), dataDir, now });
  // A machine whose database is days behind writes second. The monotonic guard
  // is what stops it from resurrecting an unclosed day and killing the brief.
  assert.equal(
    writeDayClosureRelay({ store: publisher('2026-07-14', '2026-07-14'), dataDir, now }),
    false,
  );
  assert.equal(
    evaluateScheduledBriefGate({ targetLocalDate: '2026-07-24', dataDir, now }).blocked,
    false,
  );
});

test('within one day, a peer that still shows it open cannot reopen it', (t) => {
  const dataDir = relayDir(t);
  const now = new Date('2026-07-24T14:30:00.000Z');
  // Same latest date, so the strictly-older guard does not catch this one. He
  // closed Jul 24 on the ritual machine; a peer whose copy of that day is a few
  // minutes behind must not be able to say it is open again, because no second
  // close event is coming to undo it.
  writeDayClosureRelay({ store: publisher(null, '2026-07-24'), dataDir, now });
  assert.equal(
    writeDayClosureRelay({ store: publisher('2026-07-24', '2026-07-24'), dataDir, now }),
    false,
  );
  assert.equal(
    evaluateScheduledBriefGate({ targetLocalDate: '2026-07-25', dataDir, now }).blocked,
    false,
  );
});

test('a date that passes the shape check but is not a real day is ignored', (t) => {
  const dataDir = relayDir(t);
  const now = new Date('2026-07-24T14:30:00.000Z');
  // 2026-02-31 matches YYYY-MM-DD and rolls over to Mar 3 if you trust it. A
  // corrupt or hand-edited relay file must read as no signal, not as a date.
  mkdirSync(path.join(dataDir, 'settlement-relay'), { recursive: true });
  writeFileSync(
    path.join(dataDir, 'settlement-relay', 'closure.json'),
    JSON.stringify({
      relay_version: 1,
      written_at: now.toISOString(),
      origin_host: 'peer',
      open_local_date: '2026-02-31',
      latest_local_date: '2026-02-31',
    }),
  );
  assert.deepEqual(evaluateScheduledBriefGate({ targetLocalDate: '2026-07-24', dataDir, now }), {
    blocked: false,
    reason: 'no_closure_signal',
  });
});

test('the real store publishes the facts the gate reads', (t) => {
  const dataDir = relayDir(t);
  const { store } = isolatedStore(t);
  const now = new Date('2026-07-24T16:00:00.000Z');
  const open = ensureFor(store, '2026-07-23');
  assert.equal(writeDayClosureRelay({ store, dataDir, now }), true);
  assert.equal(
    evaluateScheduledBriefGate({ targetLocalDate: '2026-07-24', dataDir, now }).blocked,
    true,
  );

  settleFully(store, open);
  assert.equal(writeDayClosureRelay({ store, dataDir, now }), true);
  assert.equal(
    evaluateScheduledBriefGate({ targetLocalDate: '2026-07-24', dataDir, now }).blocked,
    false,
  );
});

// ---------------------------------------------------------------------------
// The waiting experience: what the bar claims to know, and what it admits.
// ---------------------------------------------------------------------------

test('the estimate stays silent until it has real evidence', () => {
  assert.equal(estimateBriefSeconds([]), DEFAULT_BRIEF_ESTIMATE_SECONDS);
  assert.equal(estimateBriefSeconds([100, 110]), DEFAULT_BRIEF_ESTIMATE_SECONDS);
  // Garbage never counts toward the three-sample floor.
  assert.equal(estimateBriefSeconds([100, 110, 0, -5, NaN]), DEFAULT_BRIEF_ESTIMATE_SECONDS);
});

test('the estimate is the median, so one bad night cannot poison every morning', () => {
  assert.equal(estimateBriefSeconds([75, 130, 666]), 130);
  assert.equal(estimateBriefSeconds([80, 100, 140, 666]), 120);
  // Unsorted input and duplicates behave the same.
  assert.equal(estimateBriefSeconds([666, 75, 130, 130, 75]), 130);
});

test('the bar never fills while the brief is still being written', () => {
  assert.deepEqual(briefProgress(0, 100), { fraction: 0, overrun: false });
  assert.deepEqual(briefProgress(50, 100), { fraction: 0.5, overrun: false });
  assert.deepEqual(briefProgress(94, 100), { fraction: 0.94, overrun: false });
  // At and past the estimate it stops pretending to know.
  assert.deepEqual(briefProgress(100, 100), { fraction: 0.95, overrun: true });
  assert.deepEqual(briefProgress(400, 100), { fraction: 0.95, overrun: true });
});

test('the bar survives clock skew and a missing estimate', () => {
  // Server timestamp ahead of this browser: elapsed floors at zero, never runs backwards.
  assert.deepEqual(briefProgress(-30, 100), { fraction: 0, overrun: false });
  assert.equal(briefProgress(75, 0).fraction, 75 / DEFAULT_BRIEF_ESTIMATE_SECONDS);
  assert.equal(briefProgress(75, NaN).fraction, 75 / DEFAULT_BRIEF_ESTIMATE_SECONDS);
});

test('the remaining-time line reads like an estimate, not a countdown', () => {
  assert.equal(briefRemainingLabel(0, 150), 'About 2.5 minutes left.');
  assert.equal(briefRemainingLabel(30, 150), 'About 2 minutes left.');
  assert.equal(briefRemainingLabel(105, 150), 'About a minute left.');
  assert.equal(briefRemainingLabel(140, 150), 'Almost done.');
  assert.equal(briefRemainingLabel(150, 150), 'Taking longer than usual. Still working.');
  assert.equal(briefRemainingLabel(900, 150), 'Taking longer than usual. Still working.');
});


test('an evening closeout produces no brief until the next workday at 08:00 with no browser open', (t) => {
  for (const [closed, evening, target, morning] of [
    ['2026-07-23', '2026-07-24T01:00:00Z', '2026-07-24', '2026-07-24T15:00:00Z'],
    ['2026-07-24', '2026-07-25T01:00:00Z', '2026-07-27', '2026-07-27T15:00:00Z'],
  ]) {
    const { store, setClock } = isolatedStore(t, evening);
    const settled = settleFully(store, ensureFor(store, closed));
    maybeQueueMorningBrief(store, 'settlement_commit', { plan: settled, snapshot: store.getReadModel().latestSnapshot }, new Date(evening));
    assert.equal(store.getReadModel().currentPlan, undefined);
    assert.equal(store.listMorningBriefs(target).length, 0);
    assert.equal(enqueueDueMorningBrief(store, new Date(Date.parse(morning) - 1000)), undefined);
    setClock(morning);
    assert.equal(enqueueDueMorningBrief(store, new Date(morning)).targetLocalDate, target);
    maybeQueueMorningBrief(store, 'ensure', { plan: ensureFor(store, target) }, new Date(morning));
    assert.equal(store.listMorningBriefs(target).length, 1);
  }
});
