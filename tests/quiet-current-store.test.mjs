import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createWorkSuggestion,
  getQuietCurrentSnapshot,
  pruneSuggestions,
  recordDecisionEvent,
  reopenWorkSuggestion,
  resolveWorkSuggestion,
  setQuietCurrentNowForTests,
  setQuietCurrentStorePathForTests,
} from '../src/lib/quiet-current/store.ts';

function isolatedStore(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-quiet-current-'));
  const file = path.join(dir, 'quiet-current.json');
  setQuietCurrentStorePathForTests(file);
  setQuietCurrentNowForTests(undefined);
  t.after(() => {
    setQuietCurrentNowForTests(undefined);
    setQuietCurrentStorePathForTests(undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  return file;
}

test('refining a proposal keeps it in pencil', (t) => {
  isolatedStore(t);
  const suggestion = createWorkSuggestion({
    title: 'Prepare the launch note',
    reason: 'A launch meeting is on the calendar.',
    source: 'calendar',
  });

  const refined = resolveWorkSuggestion(suggestion.id, {
    state: 'refined',
    title: 'Write the launch note for clients',
    source: 'human_refinement',
  });

  assert.equal(refined.state, 'refined');
  assert.equal(refined.title, 'Write the launch note for clients');
  assert.equal(refined.resolvedTaskId, undefined);
  assert.equal(
    getQuietCurrentSnapshot().decisionEvents.at(-1)?.eventType,
    'suggestion_refine',
  );
});

test('accepting a proposal records the resolved task and closes it once', (t) => {
  isolatedStore(t);
  const suggestion = createWorkSuggestion({
    title: 'Call Sam',
    reason: 'Sam asked for a follow-up.',
    source: 'email',
  });

  const accepted = resolveWorkSuggestion(suggestion.id, {
    state: 'accepted',
    resolvedTaskId: 'task-123',
    source: 'explicit_accept',
  });

  assert.equal(accepted.state, 'accepted');
  assert.equal(accepted.resolvedTaskId, 'task-123');
  assert.equal(
    getQuietCurrentSnapshot().decisionEvents.at(-1)?.eventType,
    'suggestion_accept',
  );
  assert.throws(
    () => resolveWorkSuggestion(suggestion.id, { state: 'deferred' }),
    /already accepted/,
  );

  const reopened = reopenWorkSuggestion(suggestion.id);
  assert.equal(reopened.state, 'proposed');
  assert.equal(reopened.resolvedTaskId, undefined);
  assert.equal(
    getQuietCurrentSnapshot().decisionEvents.at(-1)?.eventType,
    'suggestion_undo',
  );
  assert.throws(() => reopenWorkSuggestion('missing-suggestion'), /not found/);
});

test('observed progress targets an existing task and deterministic relay ids replay', (t) => {
  isolatedStore(t);
  assert.throws(
    () => createWorkSuggestion({
      kind: 'observed_progress',
      title: 'Review observed progress',
      reason: 'A matching commit exists.',
      source: 'progress-reconciler',
    }),
    /target task/,
  );
  const input = {
    id: 'progress-suggestion-0123456789abcdef0123456789abcdef',
    kind: 'observed_progress',
    title: 'Review observed progress',
    reason: 'A matching commit exists.',
    source: 'progress-reconciler',
    targetTaskId: 'task-1',
    claimKey: 'observed_progress:task-1:likely_done',
  };
  const first = createWorkSuggestion(input);
  const replay = createWorkSuggestion(input);
  assert.equal(replay.id, first.id);
  assert.equal(getQuietCurrentSnapshot().suggestions.length, 1);
});

test('default Quiet Current storage follows COVE_DATA_DIR instead of cwd', (t) => {
  const dir = path.join(
    os.tmpdir(),
    `cove-quiet-current-data-dir-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  const previous = process.env.COVE_DATA_DIR;
  process.env.COVE_DATA_DIR = dir;
  setQuietCurrentStorePathForTests(undefined);
  t.after(() => {
    if (previous === undefined) delete process.env.COVE_DATA_DIR;
    else process.env.COVE_DATA_DIR = previous;
    setQuietCurrentStorePathForTests(undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  createWorkSuggestion({
    title: 'Anchored suggestion',
    reason: 'Verify the configured data directory.',
    source: 'test',
  });
  assert.equal(existsSync(path.join(dir, 'cove.db')), true);
});

test('expired pencil retires without changing accepted work', async (t) => {
  isolatedStore(t);
  const suggestion = createWorkSuggestion({
    title: 'Possibly review an old thread',
    reason: 'The thread was recently active.',
    source: 'email',
    expiresAt: new Date(Date.now() + 30).toISOString(),
  });

  await new Promise((resolve) => setTimeout(resolve, 45));
  const snapshot = getQuietCurrentSnapshot();
  assert.equal(
    snapshot.suggestions.find((item) => item.id === suggestion.id)?.state,
    'expired',
  );
  assert.equal(snapshot.decisionEvents.at(-1)?.eventType, 'suggestion_decay');
  assert.throws(() => reopenWorkSuggestion(suggestion.id), /cannot be reopened from expired/);
});

test('Later resurfaces once at the next morning seam and then expires', (t) => {
  isolatedStore(t);
  setQuietCurrentNowForTests(new Date('2026-07-10T12:00:00.000Z'));
  const suggestion = createWorkSuggestion({
    title: 'Review the partnership idea',
    reason: 'A partner asked for a response.',
    source: 'email',
  });

  const deferred = resolveWorkSuggestion(suggestion.id, {
    state: 'deferred',
    source: 'human',
  });
  assert.equal(deferred.state, 'deferred');
  assert.equal(deferred.deferredReturnState, 'proposed');
  assert.ok(deferred.deferredUntil);

  setQuietCurrentNowForTests(new Date(deferred.deferredUntil));
  const resurfaced = getQuietCurrentSnapshot().suggestions.find(
    (item) => item.id === suggestion.id,
  );
  assert.equal(resurfaced?.state, 'proposed');
  assert.ok(resurfaced?.resurfacedFromDeferredAt);
  assert.equal(
    getQuietCurrentSnapshot().decisionEvents.filter(
      (event) => event.eventType === 'suggestion_resurface',
    ).length,
    1,
  );

  const deferredAgain = resolveWorkSuggestion(suggestion.id, {
    state: 'deferred',
    source: 'human',
  });
  assert.equal(deferredAgain.deferredUntil, undefined);
  setQuietCurrentNowForTests(new Date(new Date(deferredAgain.expiresAt).getTime() + 1));
  const expired = getQuietCurrentSnapshot().suggestions.find(
    (item) => item.id === suggestion.id,
  );
  assert.equal(expired?.state, 'expired');
  assert.equal(
    getQuietCurrentSnapshot().decisionEvents.filter(
      (event) => event.eventType === 'suggestion_resurface',
    ).length,
    1,
  );
});

test('Later preserves refined pencil wording when it resurfaces', (t) => {
  isolatedStore(t);
  setQuietCurrentNowForTests(new Date('2026-07-10T12:00:00.000Z'));
  const suggestion = createWorkSuggestion({
    title: 'Prepare the launch note',
    reason: 'A launch is approaching.',
    source: 'calendar',
  });
  resolveWorkSuggestion(suggestion.id, {
    state: 'refined',
    title: 'Prepare the client launch note',
    source: 'human_refinement',
  });
  const deferred = resolveWorkSuggestion(suggestion.id, {
    state: 'deferred',
    source: 'human',
  });

  assert.equal(deferred.deferredReturnState, 'refined');
  setQuietCurrentNowForTests(new Date(deferred.deferredUntil));
  const resurfaced = getQuietCurrentSnapshot().suggestions.find(
    (item) => item.id === suggestion.id,
  );
  assert.equal(resurfaced?.state, 'refined');
  assert.equal(resurfaced?.title, 'Prepare the client launch note');
});

test('legacy deferred pencil returns immediately instead of being stranded', (t) => {
  const file = isolatedStore(t);
  setQuietCurrentNowForTests(new Date('2026-07-10T12:00:00.000Z'));
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      suggestions: [
        {
          id: 'legacy-deferred',
          kind: 'create_task',
          title: 'Revisit the legacy idea',
          description: '',
          reason: 'It was set aside before the one-return lifecycle shipped.',
          source: 'email',
          priority: 'medium',
          state: 'deferred',
          createdAt: '2026-07-08T12:00:00.000Z',
          updatedAt: '2026-07-08T12:00:00.000Z',
          expiresAt: '2026-07-11T12:00:00.000Z',
        },
      ],
      decisionEvents: [],
    }),
  );

  const snapshot = getQuietCurrentSnapshot();
  assert.equal(snapshot.suggestions[0]?.state, 'proposed');
  assert.ok(snapshot.suggestions[0]?.resurfacedFromDeferredAt);
  assert.equal(snapshot.decisionEvents[0]?.eventType, 'suggestion_resurface');
});

test('Later does not revive a suggestion after its real deadline', (t) => {
  isolatedStore(t);
  setQuietCurrentNowForTests(new Date('2026-07-10T12:00:00.000Z'));
  const suggestion = createWorkSuggestion({
    title: 'Prepare for the 2 PM call',
    reason: 'The call is today.',
    source: 'calendar',
    expiresAt: '2026-07-10T14:00:00.000Z',
  });
  const deferred = resolveWorkSuggestion(suggestion.id, {
    state: 'deferred',
    source: 'human',
  });

  setQuietCurrentNowForTests(new Date('2026-07-10T14:00:00.001Z'));
  const expired = getQuietCurrentSnapshot().suggestions.find(
    (item) => item.id === suggestion.id,
  );
  assert.equal(expired?.state, 'expired');
  assert.ok(new Date(suggestion.expiresAt) < new Date(deferred.deferredUntil));
  assert.equal(
    getQuietCurrentSnapshot().decisionEvents.some(
      (event) => event.eventType === 'suggestion_resurface',
    ),
    false,
  );
});

test('a late read expires deferred work even when its deadline followed the return seam', (t) => {
  isolatedStore(t);
  setQuietCurrentNowForTests(new Date('2026-07-10T12:00:00.000Z'));
  const suggestion = createWorkSuggestion({
    title: 'Review the follow-up tomorrow morning',
    reason: 'The follow-up should not linger past tomorrow afternoon.',
    source: 'email',
    expiresAt: '2026-07-11T19:00:00.000Z',
  });
  const deferred = resolveWorkSuggestion(suggestion.id, {
    state: 'deferred',
    source: 'human',
  });
  assert.ok(new Date(suggestion.expiresAt) > new Date(deferred.deferredUntil));

  setQuietCurrentNowForTests(new Date('2026-07-11T20:00:00.000Z'));
  const expired = getQuietCurrentSnapshot().suggestions.find(
    (item) => item.id === suggestion.id,
  );
  assert.equal(expired?.state, 'expired');
  assert.equal(
    getQuietCurrentSnapshot().decisionEvents.some(
      (event) => event.eventType === 'suggestion_resurface',
    ),
    false,
  );
});

test('undo after the morning seam is idempotent when Later already returned', (t) => {
  isolatedStore(t);
  setQuietCurrentNowForTests(new Date('2026-07-10T12:00:00.000Z'));
  const suggestion = createWorkSuggestion({
    title: 'Review the returned idea',
    reason: 'It was set aside yesterday.',
    source: 'email',
  });
  const deferred = resolveWorkSuggestion(suggestion.id, {
    state: 'deferred',
    source: 'human',
  });
  setQuietCurrentNowForTests(new Date(deferred.deferredUntil));
  getQuietCurrentSnapshot();

  const reopened = reopenWorkSuggestion(suggestion.id);
  assert.equal(reopened.state, 'proposed');
});

test('undoing Later before morning cancels the scheduled return', (t) => {
  isolatedStore(t);
  setQuietCurrentNowForTests(new Date('2026-07-10T12:00:00.000Z'));
  const suggestion = createWorkSuggestion({
    title: 'Review the partnership idea',
    reason: 'A partner asked for a response.',
    source: 'email',
  });
  const deferred = resolveWorkSuggestion(suggestion.id, {
    state: 'deferred',
    source: 'human',
  });
  const scheduledReturn = deferred.deferredUntil;

  const reopened = reopenWorkSuggestion(suggestion.id);
  assert.equal(reopened.state, 'proposed');
  assert.equal(reopened.deferredUntil, undefined);

  setQuietCurrentNowForTests(new Date(new Date(scheduledReturn).getTime() + 1));
  const snapshot = getQuietCurrentSnapshot();
  assert.equal(
    snapshot.suggestions.find((item) => item.id === suggestion.id)?.state,
    'proposed',
  );
  assert.equal(
    snapshot.decisionEvents.filter(
      (event) => event.eventType === 'suggestion_resurface',
    ).length,
    0,
  );
});

test('returned work cannot exist without its accepted target', (t) => {
  isolatedStore(t);
  assert.throws(
    () =>
      createWorkSuggestion({
        kind: 'returned_work',
        title: 'Draft ready',
        reason: 'The delegated work finished.',
        source: 'Jarvis handoff',
      }),
    /requires an existing target task/,
  );
});

test('pruning removes terminal history before active pencil', () => {
  const base = {
    kind: 'create_task',
    description: '',
    reason: 'reason',
    source: 'source',
    priority: 'medium',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-04T00:00:00.000Z',
  };
  const suggestions = [
    { ...base, id: 'active-old', title: 'Active old', state: 'proposed' },
    { ...base, id: 'terminal-old', title: 'Terminal old', state: 'accepted' },
    { ...base, id: 'active-new', title: 'Active new', state: 'refined' },
    { ...base, id: 'deferred', title: 'Deferred', state: 'deferred' },
  ];
  const pruned = pruneSuggestions(suggestions, 3);
  assert.deepEqual(
    pruned.map((suggestion) => suggestion.id),
    ['active-old', 'active-new', 'deferred'],
  );
});

test('decision events remain inspectable and ordered', (t) => {
  isolatedStore(t);
  recordDecisionEvent({
    eventType: 'focus_change',
    entityId: 'task-a',
    before: { focusedTaskId: null },
    after: { focusedTaskId: 'task-a' },
    source: 'keyboard',
  });
  recordDecisionEvent({
    eventType: 'task_handoff',
    entityId: 'task-a',
    source: 'human',
  });

  const snapshot = getQuietCurrentSnapshot();
  assert.deepEqual(
    snapshot.decisionEvents.map((event) => event.eventType),
    ['focus_change', 'task_handoff'],
  );
});
