import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { buildDayPlanCandidates } from '../src/lib/day-plan/candidates.ts';
import {
  MORNING_BRIEF_PROMPT_VERSION,
  MORNING_BRIEF_SCHEMA_VERSION,
} from '../src/lib/day-plan/brief.ts';
import {
  arrivalAdditionOutcomeKey,
  matchesArrivalAddition,
} from '../src/lib/day-plan/arrival-addition.ts';
import {
  DayPlanInvalidTransition,
  DayPlanVersionConflict,
  createDayPlanStore,
} from '../src/lib/day-plan/store.ts';

function isolatedStore(t, initialClock = '2026-07-10T16:00:00.000Z') {
  const file = path.join(
    os.tmpdir(),
    `cove-day-plan-${process.pid}-${Date.now()}-${Math.random()}.db`,
  );
  const boardDb = new Database(file);
  createManagedBoardTables(boardDb);
  boardDb.close();
  let clock = new Date(initialClock);
  const store = createDayPlanStore({ dbPath: file, now: () => new Date(clock) });
  t.after(() => {
    store.close();
    rmSync(file, { force: true });
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
  });
  return {
    file,
    store,
    setClock: (value) => {
      clock = new Date(value);
    },
  };
}

function candidates(ids = ['task-a', 'task-b']) {
  return buildDayPlanCandidates({
    localDate: '2026-07-10',
    timezone: 'America/Los_Angeles',
    tasks: ids.map((id, position) => ({
      id,
      title: `Task ${id}`,
      description: `Finish ${id}`,
      priority: position === 0 ? 'high' : 'medium',
      position,
      column: 'today',
      status: 'open',
      updatedAt: '2026-07-10T15:00:00.000Z',
      refreshedAt: '2026-07-10T16:00:00.000Z',
    })),
  }, ids.length);
}

function ensure(store, mutationId = 'ensure:2026-07-10') {
  return store.ensureDayPlan({
    localDate: '2026-07-10',
    timezone: 'America/Los_Angeles',
    mutationId,
    candidates: candidates(),
  });
}

function mutate(store, plan, action, patch = {}) {
  return store.mutateDayPlan({
    planId: plan.id,
    mutationId: `${action}:${plan.version}:${Math.random()}`.replaceAll('.', '-'),
    expectedVersion: plan.version,
    action,
    ...patch,
  });
}

function reorderPlanToItemIds(store, plan, orderedItemIds) {
  let next = plan;
  for (let position = 0; position < orderedItemIds.length; position += 1) {
    const ordered = [...next.items].sort((left, right) => left.position - right.position);
    if (ordered[position]?.id === orderedItemIds[position]) continue;
    next = mutate(store, next, 'item_reorder', {
      itemId: orderedItemIds[position],
      position,
    }).plan;
  }
  return next;
}

function removeManualCreationMarker(file, planId) {
  const db = new Database(file);
  const row = db.prepare(
    "SELECT id, after_json FROM day_plan_events WHERE day_plan_id = ? AND event_type = 'ensure'",
  ).get(planId);
  const after = JSON.parse(row.after_json);
  delete after.creation;
  db.prepare('UPDATE day_plan_events SET after_json = ? WHERE id = ?')
    .run(JSON.stringify(after), row.id);
  db.close();
}

function createManagedBoardTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_columns (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, column_id TEXT, title TEXT NOT NULL, description TEXT,
      priority TEXT, due_at TEXT, due_date TEXT, tags TEXT, project TEXT,
      position REAL, status TEXT, archived_at TEXT, archived_from_status TEXT,
      recurring_template_id TEXT, occurrence_local_date TEXT, origin TEXT,
      created_at TEXT, updated_at TEXT
    );
    INSERT OR IGNORE INTO task_columns (id, name, position) VALUES
      ('col-ns', 'Not Started', 0),
      ('col-today', 'Must happen today', 10),
      ('col-flight', 'In Flight / Waiting', 20),
      ('col-done', 'Done', 30);
  `);
}

function containsAsciiControl(value, { preserveFormatting = false } = {}) {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0);
    if (preserveFormatting && (character === '\n' || character === '\t')) return false;
    return code < 32 || code === 127;
  });
}

test('schema migration preserves existing SQLite data', (t) => {
  const file = path.join(os.tmpdir(), `cove-day-plan-legacy-${process.pid}-${Date.now()}.db`);
  const legacy = new Database(file);
  legacy.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
  legacy.prepare('INSERT INTO tasks (id, title) VALUES (?, ?)').run('legacy-task', 'Keep me');
  legacy.close();

  const store = createDayPlanStore({ dbPath: file });
  t.after(() => {
    store.close();
    rmSync(file, { force: true });
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
  });
  const verify = new Database(file, { readonly: true });
  assert.deepEqual(verify.prepare('SELECT * FROM tasks').get(), {
    id: 'legacy-task',
    title: 'Keep me',
  });
  verify.close();
});

test('ensure is idempotent and one open plan survives competing dates', (t) => {
  const { store } = isolatedStore(t);
  const created = ensure(store);
  const replay = ensure(store);
  assert.equal(replay.replayed, true);
  assert.equal(replay.plan.id, created.plan.id);
  assert.equal(replay.plan.version, 1);
  assert.equal(created.plan.items.every((item) => item.decision === 'preselected'), true);

  const otherDate = store.ensureDayPlan({
    localDate: '2026-07-11',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:2026-07-11',
    candidates: [],
  });
  assert.equal(otherDate.plan.id, created.plan.id);
  assert.equal(store.getReadModel().currentPlan.id, created.plan.id);
  assert.equal(store.listEvents(created.plan.id).length, 2);
});

test('automatic weekend creation gates, manual creation is marked, and existing retrieval is unaffected', (t) => {
  const { store } = isolatedStore(t, '2026-08-01T16:00:00.000Z');
  const gated = store.ensureDayPlan({
    localDate: '2026-08-01',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:weekend:auto',
    candidates: [],
  });
  assert.deepEqual(gated, {
    weekendGate: { localDate: '2026-08-01', weekday: 'Saturday' },
    replayed: false,
  });
  assert.equal(store.getReadModel().currentPlan, undefined);

  const manual = store.ensureDayPlan({
    localDate: '2026-08-01',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:weekend:manual',
    candidates: [],
    creation: 'manual',
  });
  assert.equal(manual.plan.localDate, '2026-08-01');
  assert.equal(store.listEvents(manual.plan.id)[0].after.creation, 'manual');

  const existing = store.ensureDayPlan({
    localDate: '2026-08-02',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:weekend:existing',
    candidates: [],
  });
  assert.equal(existing.plan.id, manual.plan.id);
});

test('automatic weekday creation still creates a plan', (t) => {
  const { store } = isolatedStore(t, '2026-08-03T16:00:00.000Z');
  const result = store.ensureDayPlan({
    localDate: '2026-08-03',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:monday',
    candidates: [],
  });
  assert.equal(result.plan.localDate, '2026-08-03');
});

test('arrival skip promotes proposed work into an active non-empty Today list', (t) => {
  const { store } = isolatedStore(t);
  let plan = ensure(store, 'ensure:skip-promotes').plan;
  plan = mutate(store, plan, 'arrival_skip').plan;

  assert.equal(plan.arrivalState, 'skipped');
  assert.equal(plan.state, 'active');
  assert.ok(plan.items.filter((item) => item.decision === 'accepted').length > 0);
  assert.equal(
    plan.items.some((item) => item.decision === 'pending' || item.decision === 'preselected'),
    false,
  );
  assert.equal(store.listExecutionRuns(plan.id).length, 0);
});

test('arrival bypass promotes proposed work into an active non-empty Today list', (t) => {
  const { store } = isolatedStore(t);
  let plan = ensure(store, 'ensure:bypass-promotes').plan;
  plan = mutate(store, plan, 'arrival_bypass').plan;

  assert.equal(plan.arrivalState, 'bypassed');
  assert.equal(plan.state, 'active');
  assert.ok(plan.items.filter((item) => item.decision === 'accepted').length > 0);
  assert.equal(
    plan.items.some((item) => item.decision === 'pending' || item.decision === 'preselected'),
    false,
  );
  assert.equal(store.listExecutionRuns(plan.id).length, 0);
});

test('settlement from a snoozed arrival promotes the proposed items before opening', (t) => {
  const { store } = isolatedStore(t);
  let plan = ensure(store, 'ensure:snoozed-settlement').plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  plan = mutate(store, plan, 'arrival_snooze', {
    snoozedUntil: '2026-07-10T17:00:00.000Z',
  }).plan;
  plan = mutate(store, plan, 'settlement_start').plan;

  assert.equal(plan.state, 'settling');
  assert.equal(plan.settlementState, 'in_progress');
  assert.ok(plan.items.filter((item) => item.decision === 'accepted').length > 0);
  assert.equal(
    plan.items.some((item) => item.decision === 'pending' || item.decision === 'preselected'),
    false,
  );
});

test('initialize auto-settles an untouched legacy weekend through settlement and writes one receipt', (t) => {
  const { file, store, setClock } = isolatedStore(t, '2026-08-01T16:00:00.000Z');
  const plan = store.ensureDayPlan({
    localDate: '2026-08-01',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:legacy-weekend',
    candidates: candidates(['weekend-task']),
    creation: 'manual',
  }).plan;
  removeManualCreationMarker(file, plan.id);
  setClock('2026-08-03T16:00:00.000Z');

  store.initialize();
  const settled = store.getPlan(plan.id);
  assert.equal(settled.state, 'settled');
  assert.equal(settled.settlementState, 'settled');
  assert.equal(settled.items[0].decision, 'preselected');
  assert.ok(store.getSnapshot(plan.id));
  const eventTypes = store.listEvents(plan.id).map((event) => event.eventType);
  assert.ok(eventTypes.includes('settlement_start'));
  assert.ok(eventTypes.includes('settlement_commit'));
  assert.equal(store.listMorningBriefs('2026-08-03').length, 0);

  store.initialize();
  const db = new Database(file, { readonly: true });
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM cove_receipts WHERE source = 'weekend-auto-settle'").pluck().get(),
    1,
  );
  db.close();
});

test('fresh construction auto-settles an untouched weekend with proposed items without throwing', (t) => {
  const { file, store } = isolatedStore(t, '2026-08-01T16:00:00.000Z');
  const plan = store.ensureDayPlan({
    localDate: '2026-08-01',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:legacy-weekend-construction',
    candidates: candidates(['weekend-construction-task']),
    creation: 'manual',
  }).plan;
  removeManualCreationMarker(file, plan.id);
  store.close();

  let reopened;
  assert.doesNotThrow(() => {
    reopened = createDayPlanStore({
      dbPath: file,
      now: () => new Date('2026-08-03T16:00:00.000Z'),
    });
  });
  t.after(() => reopened?.close());
  const settled = reopened.getPlan(plan.id);
  assert.equal(settled.state, 'settled');
  assert.equal(settled.settlementState, 'settled');
  assert.equal(settled.items[0].decision, 'preselected');
});

test('initialize leaves touched and manually-created weekend plans for normal closeout', (t) => {
  const touchedFixture = isolatedStore(t, '2026-08-01T16:00:00.000Z');
  const touched = touchedFixture.store.ensureDayPlan({
    localDate: '2026-08-01',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:touched-weekend',
    candidates: [],
    creation: 'manual',
  }).plan;
  removeManualCreationMarker(touchedFixture.file, touched.id);
  touchedFixture.store.markArrivalInteraction(touched.id, 'interact:touched-weekend');
  touchedFixture.setClock('2026-08-03T16:00:00.000Z');
  touchedFixture.store.initialize();
  assert.notEqual(touchedFixture.store.getPlan(touched.id).state, 'settled');

  const manualFixture = isolatedStore(t, '2026-08-02T16:00:00.000Z');
  const manual = manualFixture.store.ensureDayPlan({
    localDate: '2026-08-02',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:manual-weekend',
    candidates: [],
    creation: 'manual',
  }).plan;
  manualFixture.setClock('2026-08-03T16:00:00.000Z');
  manualFixture.store.initialize();
  assert.notEqual(manualFixture.store.getPlan(manual.id).state, 'settled');
});

test('initialize does not auto-settle a legacy weekend with accepted work', (t) => {
  const { file, store, setClock } = isolatedStore(t, '2026-08-01T16:00:00.000Z');
  let plan = store.ensureDayPlan({
    localDate: '2026-08-01',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:accepted-weekend',
    candidates: candidates(['accepted-weekend-task']),
    creation: 'manual',
  }).plan;
  removeManualCreationMarker(file, plan.id);
  plan = mutate(store, plan, 'arrival_open').plan;
  plan = mutate(store, plan, 'item_accept', { itemId: plan.items[0].id }).plan;
  setClock('2026-08-03T16:00:00.000Z');

  store.initialize();
  assert.equal(store.getPlan(plan.id).items[0].decision, 'accepted');
  assert.notEqual(store.getPlan(plan.id).state, 'settled');
});

test('initialize resumes an interrupted weekend settlement idempotently', (t) => {
  const { file, store, setClock } = isolatedStore(t, '2026-08-01T16:00:00.000Z');
  let plan = store.ensureDayPlan({
    localDate: '2026-08-01',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:interrupted-weekend',
    candidates: [],
    creation: 'manual',
  }).plan;
  removeManualCreationMarker(file, plan.id);
  plan = mutate(store, plan, 'arrival_bypass').plan;
  plan = mutate(store, plan, 'settlement_start', { completedHumanTaskIds: [] }).plan;
  assert.equal(plan.settlementState, 'in_progress');
  setClock('2026-08-03T16:00:00.000Z');

  store.initialize();
  store.initialize();
  assert.equal(store.getPlan(plan.id).state, 'settled');
  assert.equal(
    store.listEvents(plan.id).filter((event) => event.eventType === 'settlement_commit').length,
    1,
  );
  const db = new Database(file, { readonly: true });
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM cove_receipts WHERE source = 'weekend-auto-settle'").pluck().get(),
    1,
  );
  db.close();
});

test('expected versions prevent stale overwrites and duplicate action IDs replay', (t) => {
  const { store } = isolatedStore(t);
  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  const input = {
    planId: plan.id,
    mutationId: `owner:${plan.id}`,
    expectedVersion: plan.version,
    action: 'item_owner',
    itemId: plan.items[0].id,
    owner: 'together',
  };
  const changed = store.mutateDayPlan(input);
  const replayed = store.mutateDayPlan(input);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.plan.version, changed.plan.version);
  assert.equal(store.listEvents(plan.id).filter((event) => event.id === input.mutationId).length, 1);

  assert.throws(
    () =>
      store.mutateDayPlan({
        ...input,
        mutationId: 'different-mutation',
        owner: 'me',
      }),
    (error) =>
      error instanceof DayPlanVersionConflict &&
      error.currentPlan.version === changed.plan.version,
  );
  assert.equal(store.getPlan(plan.id).items[0].owner, 'together');
});

test('item_add creates a Today task and appends a preselected owned item', (t) => {
  const { file, store } = isolatedStore(t);
  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  const previousVersion = plan.version;
  const previousLength = plan.items.length;

  const changed = mutate(store, plan, 'item_add', {
    title: 'Prepare the client follow-up',
    outcome: 'A send-ready follow-up is drafted.',
    why: 'The client is waiting on the next step.',
    owner: 'together',
  }).plan;

  assert.equal(changed.version, previousVersion + 1);
  assert.equal(changed.items.length, previousLength + 1);
  const added = changed.items.at(-1);
  assert.equal(added.title, 'Prepare the client follow-up');
  assert.equal(added.outcome, 'A send-ready follow-up is drafted.');
  assert.equal(added.definitionOfDone, 'A send-ready follow-up is drafted.');
  assert.equal(added.whyToday, 'The client is waiting on the next step.');
  assert.equal(added.owner, 'together');
  assert.equal(added.position, previousLength);
  assert.equal(added.decision, 'preselected');
  assert.equal(
    added.sourceRefs.some(
      (source) => source.sourceType === 'task' && source.recordId === added.taskId,
    ),
    true,
  );
  const verify = new Database(file, { readonly: true });
  assert.deepEqual(
    verify.prepare(
      'SELECT id, column_id, title, description, status, position FROM tasks WHERE id = ?',
    ).get(added.taskId),
    {
      id: added.taskId,
      column_id: 'col-today',
      title: 'Prepare the client follow-up',
      description: 'A send-ready follow-up is drafted.',
      status: 'open',
      position: 0,
    },
  );
  verify.close();
});

test('item_add requires a Today column and leaves the plan unchanged when it is missing', (t) => {
  const { file, store } = isolatedStore(t);
  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  const db = new Database(file);
  db.prepare("DELETE FROM task_columns WHERE id = 'col-today'").run();
  db.close();

  assert.throws(
    () => mutate(store, plan, 'item_add', {
      title: 'Unplaceable work',
      outcome: 'This needs a real task.',
      why: 'It matters today.',
      owner: 'me',
    }),
    (error) =>
      error instanceof DayPlanInvalidTransition &&
      error.message === 'Cove needs a Today list to add work.',
  );
  assert.equal(store.getPlan(plan.id).version, plan.version);
  const verify = new Database(file, { readonly: true });
  assert.equal(verify.prepare("SELECT COUNT(*) FROM tasks").pluck().get(), 0);
  verify.close();
});

test('task-backed item_add hydrates from SQLite and restores the same item after Not today', (t) => {
  const { file, store } = isolatedStore(t);
  const db = new Database(file);
  createManagedBoardTables(db);
  db.prepare(
    `INSERT INTO tasks
      (id, column_id, title, description, priority, tags, project, position,
       status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  ).run(
    'task-c',
    'col-ns',
    'Prepare the launch notes',
    'A complete launch note is ready.',
    'high',
    '[]',
    'Cove',
    0,
    '2026-07-10T15:00:00.000Z',
    '2026-07-10T15:00:00.000Z',
  );
  db.close();

  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  plan = mutate(store, plan, 'item_add', { taskId: 'task-c' }).plan;
  const added = plan.items.find((item) => item.taskId === 'task-c');
  assert.equal(added.title, 'Prepare the launch notes');
  assert.equal(added.owner, 'me');
  assert.equal(added.decision, 'preselected');

  plan = mutate(store, plan, 'item_later', { itemId: added.id }).plan;
  plan = mutate(store, plan, 'item_add', { taskId: 'task-c' }).plan;
  const restored = plan.items.find((item) => item.taskId === 'task-c');
  assert.equal(restored.id, added.id);
  assert.equal(restored.decision, 'preselected');
  assert.equal(plan.items.filter((item) => item.taskId === 'task-c').length, 1);
  assert.throws(
    () => mutate(store, plan, 'item_add', { taskId: 'task-c' }),
    /already in Today/,
  );
});

test('task-backed item_add stays after active work when completed items lead the array', (t) => {
  const { file, store } = isolatedStore(t);
  const db = new Database(file);
  createManagedBoardTables(db);
  const ids = ['done-a', 'done-b', 'task-x', 'task-y', 'task-z', 'task-new'];
  const insert = db.prepare(
    `INSERT INTO tasks
      (id, column_id, title, description, priority, tags, position,
       status, created_at, updated_at)
     VALUES (?, 'col-today', ?, ?, 'medium', '[]', ?, 'open', ?, ?)`,
  );
  ids.forEach((id, position) => insert.run(
    id,
    id.replace('task-', '').toUpperCase(),
    `Finish ${id}`,
    position,
    '2026-07-10T15:00:00.000Z',
    '2026-07-10T15:00:00.000Z',
  ));
  db.close();

  let plan = store.ensureDayPlan({
    localDate: '2026-07-10',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:completed-prefix',
    candidates: candidates(ids.slice(0, 3)),
  }).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  plan = mutate(store, plan, 'item_add', { taskId: 'task-y' }).plan;
  plan = mutate(store, plan, 'item_add', { taskId: 'task-z' }).plan;
  for (const taskId of ids.slice(0, 2)) {
    plan = mutate(store, plan, 'item_complete', {
      itemId: plan.items.find((item) => item.taskId === taskId).id,
    }).plan;
  }
  const activeBefore = plan.items
    .filter((item) => item.decision === 'preselected' || item.decision === 'accepted')
    .map((item) => item.taskId);
  assert.deepEqual(activeBefore, ['task-x', 'task-y', 'task-z']);

  plan = mutate(store, plan, 'item_add', { taskId: 'task-new' }).plan;
  const activeAfter = plan.items
    .filter((item) => item.decision === 'preselected' || item.decision === 'accepted')
    .map((item) => item.taskId);
  assert.deepEqual(activeAfter.slice(0, 3), ['task-x', 'task-y', 'task-z']);
  assert.deepEqual(activeAfter, ['task-x', 'task-y', 'task-z', 'task-new']);
  assert.throws(
    () => mutate(store, plan, 'item_add', { taskId: 'done-a' }),
    /already complete/,
  );
});

test('item_complete marks the board task done and legacy reopen falls back to Today', (t) => {
  const { file, store } = isolatedStore(t);
  const db = new Database(file);
  createManagedBoardTables(db);
  db.prepare(
    `INSERT INTO tasks
      (id, column_id, title, description, priority, tags, position,
       status, created_at, updated_at)
     VALUES ('task-a', 'col-today', 'Task task-a', 'Finish task-a', 'high', '[]', 0,
             'open', '2026-07-10T15:00:00.000Z', '2026-07-10T15:00:00.000Z')`,
  ).run();
  db.close();

  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  const queuedItem = plan.items.find((item) => item.taskId === 'task-a');
  const queuedDb = new Database(file);
  queuedDb.prepare(
    `INSERT INTO day_plan_execution_runs
      (id, day_plan_id, item_id, task_id, owner, mode, model_alias, status,
       idempotency_key, attempt, claude_session_id, brief_hash, authorization_hash,
       prompt_json, readiness_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'claude', 'plan_review', 'sonnet', 'queued', ?, 1, ?,
             'brief-before-complete', '', '{}', '{}', ?, ?)`,
  ).run(
    'run-before-complete',
    plan.id,
    queuedItem.id,
    queuedItem.taskId,
    'kickoff:before-complete',
    '11111111-1111-4111-8111-111111111111',
    '2026-07-10T15:30:00.000Z',
    '2026-07-10T15:30:00.000Z',
  );
  queuedDb.close();
  const completed = mutate(store, plan, 'item_complete', {
    itemId: queuedItem.id,
  }).plan;
  assert.equal(
    completed.items.find((item) => item.taskId === 'task-a').decision,
    'completed',
  );
  const verified = new Database(file);
  assert.deepEqual(
    verified.prepare("SELECT column_id, status FROM tasks WHERE id = 'task-a'").get(),
    { column_id: 'col-done', status: 'done' },
  );
  assert.deepEqual(
    verified.prepare(
      "SELECT status, error_code FROM day_plan_execution_runs WHERE id = 'run-before-complete'",
    ).get(),
    { status: 'cancelled', error_code: 'item_not_retained' },
  );
  const staleItems = structuredClone(completed.items);
  const staleItem = staleItems.find((item) => item.taskId === 'task-a');
  delete staleItem.preCompletionBoardPlacement;
  staleItem.settlementDecision = {
    disposition: 'carry',
    decidedAt: '2026-07-10T16:00:00.000Z',
  };
  verified.prepare('UPDATE day_plans SET items_json = ? WHERE id = ?')
    .run(JSON.stringify(staleItems), completed.id);
  verified.close();
  const completedWithSettlement = store.getPlan(completed.id);
  assert.equal(
    completedWithSettlement.items.find((item) => item.taskId === 'task-a')
      .preCompletionBoardPlacement,
    undefined,
  );
  const reopened = mutate(store, completedWithSettlement, 'item_reopen', {
    itemId: queuedItem.id,
  }).plan;
  const reopenedItem = reopened.items.find((item) => item.taskId === 'task-a');
  assert.equal(reopenedItem.decision, 'accepted');
  assert.equal(reopenedItem.settlementDecision, undefined);
  const reopenedDb = new Database(file);
  assert.deepEqual(
    reopenedDb.prepare("SELECT column_id, status, position FROM tasks WHERE id = 'task-a'").get(),
    { column_id: 'col-today', status: 'open', position: 0 },
  );
  reopenedDb.close();
});

test('item_complete moves the item to the end so the remaining Today items can reorder', (t) => {
  const { file, store } = isolatedStore(t);
  const db = new Database(file);
  createManagedBoardTables(db);
  const insert = db.prepare(
    `INSERT INTO tasks
      (id, column_id, title, description, priority, tags, position,
       status, created_at, updated_at)
     VALUES (?, 'col-today', ?, ?, 'medium', '[]', ?, 'open', ?, ?)`,
  );
  ['task-a', 'task-b', 'task-c'].forEach((taskId, position) => insert.run(
    taskId,
    `Task ${taskId}`,
    `Finish ${taskId}`,
    position,
    '2026-07-10T15:00:00.000Z',
    '2026-07-10T15:00:00.000Z',
  ));
  db.close();

  let plan = store.ensureDayPlan({
    localDate: '2026-07-10',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:complete-reorder',
    candidates: candidates(['task-a', 'task-b', 'task-c']),
  }).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  const firstItem = plan.items.find((item) => item.taskId === 'task-a');
  const thirdItem = plan.items.find((item) => item.taskId === 'task-c');
  plan = mutate(store, plan, 'item_complete', { itemId: firstItem.id }).plan;
  assert.deepEqual(
    [...plan.items].sort((left, right) => left.position - right.position).map((item) => item.taskId),
    ['task-b', 'task-c', 'task-a'],
  );

  plan = mutate(store, plan, 'item_reorder', { itemId: thirdItem.id, position: 0 }).plan;
  assert.deepEqual(
    [...plan.items]
      .filter((item) => item.decision !== 'completed')
      .sort((left, right) => left.position - right.position)
      .map((item) => item.taskId),
    ['task-c', 'task-b'],
  );
});

test('item_reopen restores the completed item to its prior plan position', (t) => {
  const { file, store } = isolatedStore(t);
  const db = new Database(file);
  createManagedBoardTables(db);
  const insert = db.prepare(
    `INSERT INTO tasks
      (id, column_id, title, description, priority, tags, position,
       status, created_at, updated_at)
     VALUES (?, 'col-today', ?, ?, 'medium', '[]', ?, 'open', ?, ?)`,
  );
  ['task-a', 'task-b', 'task-c'].forEach((taskId, position) => insert.run(
    taskId,
    `Task ${taskId}`,
    `Finish ${taskId}`,
    position,
    '2026-07-10T15:00:00.000Z',
    '2026-07-10T15:00:00.000Z',
  ));
  db.close();
  let plan = store.ensureDayPlan({
    localDate: '2026-07-10',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:reopen-plan-position',
    candidates: candidates(['task-a', 'task-b', 'task-c']),
  }).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  const originalOrder = [...plan.items]
    .sort((left, right) => left.position - right.position)
    .map((item) => item.id);
  const middleItem = plan.items.find((item) => item.taskId === 'task-b');

  plan = mutate(store, plan, 'item_complete', { itemId: middleItem.id }).plan;
  assert.deepEqual(
    [...plan.items].sort((left, right) => left.position - right.position).map((item) => item.taskId),
    ['task-a', 'task-c', 'task-b'],
  );
  plan = mutate(store, plan, 'item_reopen', { itemId: middleItem.id }).plan;

  assert.deepEqual(
    [...plan.items].sort((left, right) => left.position - right.position).map((item) => item.id),
    originalOrder,
  );
});

test('item_reopen restores the exact recorded board placement', (t) => {
  const { file, store } = isolatedStore(t);
  const db = new Database(file);
  createManagedBoardTables(db);
  const insert = db.prepare(
    `INSERT INTO tasks
      (id, column_id, title, description, priority, tags, position,
       status, created_at, updated_at)
     VALUES (?, 'col-today', ?, ?, 'medium', '[]', ?, 'open', ?, ?)`,
  );
  ['task-left', 'task-a', 'task-right'].forEach((taskId, position) => insert.run(
    taskId,
    `Task ${taskId}`,
    `Finish ${taskId}`,
    position,
    '2026-07-10T15:00:00.000Z',
    '2026-07-10T15:00:00.000Z',
  ));
  db.close();

  let plan = ensure(store, 'ensure:exact-reopen-placement').plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  const item = plan.items.find((candidate) => candidate.taskId === 'task-a');
  plan = mutate(store, plan, 'item_complete', { itemId: item.id }).plan;
  assert.deepEqual(
    plan.items.find((candidate) => candidate.id === item.id).preCompletionBoardPlacement,
    { columnId: 'col-today', position: 1, status: 'open' },
  );

  plan = mutate(store, plan, 'item_reopen', { itemId: item.id }).plan;
  assert.equal(
    plan.items.find((candidate) => candidate.id === item.id).preCompletionBoardPlacement,
    undefined,
  );
  const verified = new Database(file);
  assert.deepEqual(
    verified.prepare("SELECT column_id, position, status FROM tasks WHERE id = 'task-a'").get(),
    { column_id: 'col-today', position: 1, status: 'open' },
  );
  assert.deepEqual(
    verified.prepare(
      "SELECT id, position FROM tasks WHERE column_id = 'col-today' ORDER BY position, id",
    ).all(),
    [
      { id: 'task-left', position: 0 },
      { id: 'task-a', position: 1 },
      { id: 'task-right', position: 2 },
    ],
  );
  verified.close();

  plan = mutate(store, plan, 'item_complete', { itemId: item.id }).plan;
  const collisionDb = new Database(file);
  collisionDb.prepare(
    `INSERT INTO tasks
      (id, column_id, title, description, priority, tags, position,
       status, created_at, updated_at)
     VALUES ('task-new', 'col-today', 'Task task-new', 'Finish task-new', 'medium', '[]', 1,
             'open', '2026-07-10T15:30:00.000Z', '2026-07-10T15:30:00.000Z')`,
  ).run();
  collisionDb.prepare(
    `INSERT INTO tasks
      (id, column_id, title, description, priority, tags, position,
       status, created_at, updated_at)
     VALUES ('task-done', 'col-today', 'Task task-done', 'Finish task-done', 'medium', '[]', 1,
             'done', '2026-07-10T15:45:00.000Z', '2026-07-10T15:45:00.000Z')`,
  ).run();
  collisionDb.close();
  plan = mutate(store, plan, 'item_reopen', { itemId: item.id }).plan;
  const collisionVerified = new Database(file);
  assert.deepEqual(
    collisionVerified.prepare(
      `SELECT id, position, status, updated_at
       FROM tasks
       WHERE column_id = 'col-today'
       ORDER BY id`,
    ).all(),
    [
      {
        id: 'task-a',
        position: 1,
        status: 'open',
        updated_at: '2026-07-10T16:00:00.000Z',
      },
      {
        id: 'task-done',
        position: 1,
        status: 'done',
        updated_at: '2026-07-10T15:45:00.000Z',
      },
      {
        id: 'task-left',
        position: 0,
        status: 'open',
        updated_at: '2026-07-10T15:00:00.000Z',
      },
      {
        id: 'task-new',
        position: 2,
        status: 'open',
        updated_at: '2026-07-10T15:30:00.000Z',
      },
      {
        id: 'task-right',
        position: 3,
        status: 'open',
        updated_at: '2026-07-10T15:00:00.000Z',
      },
    ],
  );
  collisionVerified.close();
});

test('item_complete rolls the board task back when the enclosing mutation fails', (t) => {
  const { file, store } = isolatedStore(t);
  const db = new Database(file);
  createManagedBoardTables(db);
  db.prepare(
    `INSERT INTO tasks
      (id, column_id, title, description, priority, tags, position,
       status, created_at, updated_at)
     VALUES ('task-a', 'col-today', 'Task task-a', 'Finish task-a', 'high', '[]', 0,
             'open', '2026-07-10T15:00:00.000Z', '2026-07-10T15:00:00.000Z')`,
  ).run();
  db.close();

  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  const versionBefore = plan.version;
  const triggerDb = new Database(file);
  triggerDb.exec(`
    CREATE TRIGGER fail_item_complete_plan_persist
    BEFORE UPDATE ON day_plans
    WHEN NEW.last_mutation_id LIKE 'item_complete:%'
    BEGIN
      SELECT RAISE(ABORT, 'forced plan persist failure');
    END;
  `);
  triggerDb.close();

  assert.throws(
    () => mutate(store, plan, 'item_complete', {
      itemId: plan.items.find((item) => item.taskId === 'task-a').id,
    }),
    /forced plan persist failure/,
  );
  const verified = new Database(file);
  assert.deepEqual(
    verified.prepare("SELECT column_id, status FROM tasks WHERE id = 'task-a'").get(),
    { column_id: 'col-today', status: 'open' },
  );
  verified.close();
  assert.equal(store.getPlan(plan.id).version, versionBefore);
  assert.equal(
    store.getPlan(plan.id).items.find((item) => item.taskId === 'task-a').decision,
    'preselected',
  );
});

test('item_add accepts an eleventh and twelfth plan item', (t) => {
  const { store } = isolatedStore(t);
  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  for (let index = plan.items.length; index < 10; index += 1) {
    plan = mutate(store, plan, 'item_add', {
      title: `Additional item ${index}`,
      outcome: `Outcome ${index}`,
      why: `Reason ${index}`,
      owner: 'me',
    }).plan;
  }
  plan = mutate(store, plan, 'item_add', {
      title: 'Eleventh item',
      outcome: 'This is accepted.',
      why: 'The plan can grow.',
      owner: 'me',
    }).plan;
  plan = mutate(store, plan, 'item_add', {
    title: 'Twelfth item',
    outcome: 'This is also accepted.',
    why: 'The plan has no item cap.',
    owner: 'me',
  }).plan;

  assert.equal(plan.items.length, 12);
  assert.deepEqual(plan.items.slice(-2).map((item) => item.title), [
    'Eleventh item',
    'Twelfth item',
  ]);
});

test('an arrival addition remains exactly identifiable after the plan is reopened', (t) => {
  const { file, store } = isolatedStore(t);
  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  const addition = {
    title: 'Prepare the client follow-up',
    outcome: 'A send-ready follow-up is drafted.',
    why: 'The client is waiting on the next step.',
    suggestedOwner: 'together',
  };
  plan = mutate(store, plan, 'item_add', {
    ...addition,
    owner: addition.suggestedOwner,
  }).plan;

  const reopenedStore = createDayPlanStore({ dbPath: file });
  t.after(() => reopenedStore.close());
  const reopenedPlan = reopenedStore.getPlan(plan.id);
  const matchingItems = reopenedPlan.items.filter((item) =>
    matchesArrivalAddition(item, addition),
  );

  assert.equal(matchingItems.length, 1);
  assert.equal(matchingItems[0].outcomeKey, arrivalAdditionOutcomeKey(addition));
  const backing = new Database(file, { readonly: true });
  const origin = backing.prepare('SELECT origin FROM tasks WHERE id = ?').pluck().get(matchingItems[0].taskId);
  backing.close();
  assert.equal(
    origin,
    'You added this during Morning Arrival on Jul 10, 2026. Your reason: "The client is waiting on the next step."',
  );
});

test('an unsupported mutation throws without bumping the plan version', (t) => {
  const { store } = isolatedStore(t);
  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  const previousVersion = plan.version;

  assert.throws(
    () => mutate(store, plan, 'unsupported_action'),
    (error) =>
      error instanceof DayPlanInvalidTransition &&
      error.message === 'Unsupported day-plan action: unsupported_action',
  );
  assert.equal(store.getPlan(plan.id).version, previousVersion);
});

test('Start My Day is strict, durable, and idempotent', (t) => {
  const { file, store } = isolatedStore(t);
  let plan = ensure(store).plan;
  assert.throws(
    () => mutate(store, plan, 'start_day'),
    (error) => error instanceof DayPlanInvalidTransition,
  );
  plan = mutate(store, plan, 'arrival_open').plan;
  const mutationId = `start-day:${plan.id}`;
  const started = store.mutateDayPlan({
    planId: plan.id,
    mutationId,
    expectedVersion: plan.version,
    action: 'start_day',
  });
  assert.equal(started.plan.state, 'active');
  assert.equal(started.plan.arrivalState, 'confirmed');
  assert.equal(started.plan.recommendedFirstTaskId, 'task-a');
  assert.equal(started.plan.items.every((item) => item.decision === 'accepted'), true);
  assert.equal(
    started.plan.items.every((item) => item.humanDecisionEventIds.includes(mutationId)),
    true,
  );
  assert.equal(
    store.mutateDayPlan({
      planId: plan.id,
      mutationId,
      expectedVersion: plan.version,
      action: 'start_day',
    }).replayed,
    true,
  );

  store.close();
  const reopened = createDayPlanStore({ dbPath: file });
  assert.equal(reopened.getReadModel().currentPlan.recommendedFirstTaskId, 'task-a');
  reopened.close();
});

test('active Today items can be reordered and positions are normalized', (t) => {
  const { store } = isolatedStore(t);
  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  plan = mutate(store, plan, 'item_add', {
    title: 'Third task',
    outcome: 'The third task is complete.',
    why: 'It belongs in today.',
    owner: 'me',
  }).plan;
  plan = mutate(store, plan, 'start_day').plan;

  plan = mutate(store, plan, 'item_reorder', {
    itemId: plan.items[2].id,
    position: 0,
  }).plan;

  assert.deepEqual(plan.items.map((item) => item.title), [
    'Third task',
    'Task task-a',
    'Task task-b',
  ]);
  assert.deepEqual(plan.items.map((item) => item.position), [0, 1, 2]);
});

test('active completion and undo restore the exact plan decisions and positions', (t) => {
  const { file, store } = isolatedStore(t);
  const taskIds = ['task-a', 'task-b', 'task-c', 'task-d', 'task-e'];
  const db = new Database(file);
  createManagedBoardTables(db);
  const insert = db.prepare(
    `INSERT INTO tasks
      (id, column_id, title, description, priority, tags, position,
       status, created_at, updated_at)
     VALUES (?, 'col-today', ?, ?, 'medium', '[]', ?, 'open', ?, ?)`,
  );
  taskIds.forEach((taskId, position) => insert.run(
    taskId,
    `Task ${taskId}`,
    `Finish ${taskId}`,
    position,
    '2026-07-10T15:00:00.000Z',
    '2026-07-10T15:00:00.000Z',
  ));
  db.close();

  let plan = store.ensureDayPlan({
    localDate: '2026-07-10',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:active-completion-undo',
    candidates: candidates(taskIds.slice(0, 3)),
  }).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  plan = mutate(store, plan, 'item_add', { taskId: 'task-d' }).plan;
  plan = mutate(store, plan, 'item_add', { taskId: 'task-e' }).plan;
  plan = mutate(store, plan, 'start_day').plan;
  const before = [...plan.items]
    .sort((left, right) => left.position - right.position)
    .map((item) => ({ id: item.id, decision: item.decision, position: item.position }));
  const completedItem = plan.items.find((item) => item.taskId === 'task-b');

  plan = mutate(store, plan, 'item_complete', { itemId: completedItem.id }).plan;
  plan = reorderPlanToItemIds(store, plan, [
    plan.items.find((item) => item.taskId === 'task-a').id,
    plan.items.find((item) => item.taskId === 'task-d').id,
    plan.items.find((item) => item.taskId === 'task-c').id,
    plan.items.find((item) => item.taskId === 'task-e').id,
    completedItem.id,
  ]);
  assert.equal(plan.items.find((item) => item.id === completedItem.id).decision, 'completed');
  assert.deepEqual(
    [...plan.items]
      .filter((item) => item.decision === 'accepted')
      .sort((left, right) => left.position - right.position)
      .map((item) => item.taskId),
    ['task-a', 'task-d', 'task-c', 'task-e'],
  );

  plan = mutate(store, plan, 'item_reopen', { itemId: completedItem.id }).plan;
  plan = reorderPlanToItemIds(store, plan, before.map((item) => item.id));

  assert.deepEqual(
    [...plan.items]
      .sort((left, right) => left.position - right.position)
      .map((item) => ({ id: item.id, decision: item.decision, position: item.position })),
    before,
  );
});

test('settlement cancel restores active item mutations and allows settlement to restart', (t) => {
  const { file, store } = isolatedStore(t);
  const db = new Database(file);
  createManagedBoardTables(db);
  const insert = db.prepare(
    `INSERT INTO tasks
      (id, column_id, title, description, priority, tags, position,
       status, created_at, updated_at)
     VALUES (?, 'col-today', ?, ?, 'medium', '[]', ?, 'open', ?, ?)`,
  );
  ['task-a', 'task-b'].forEach((taskId, position) => insert.run(
    taskId,
    `Task ${taskId}`,
    `Finish ${taskId}`,
    position,
    '2026-07-10T15:00:00.000Z',
    '2026-07-10T15:00:00.000Z',
  ));
  db.close();

  let plan = ensure(store, 'ensure:settlement-cancel').plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  plan = mutate(store, plan, 'start_day').plan;
  assert.throws(
    () => mutate(store, plan, 'settlement_cancel'),
    (error) => error instanceof DayPlanInvalidTransition && /active settlement/.test(error.message),
  );

  plan = mutate(store, plan, 'settlement_start').plan;
  const itemsBeforeCancel = structuredClone(plan.items);
  plan = mutate(store, plan, 'settlement_decide', {
    itemId: plan.items[1].id,
    disposition: 'carry',
  }).plan;
  assert.equal(plan.items[1].settlementDecision.disposition, 'carry');
  plan = mutate(store, plan, 'settlement_cancel').plan;
  assert.equal(plan.state, 'active');
  assert.equal(plan.settlementState, 'offered');
  assert.deepEqual(plan.items, itemsBeforeCancel);

  const firstItem = [...plan.items].sort((left, right) => left.position - right.position)[0];
  const secondItem = [...plan.items].sort((left, right) => left.position - right.position)[1];
  plan = mutate(store, plan, 'item_complete', { itemId: firstItem.id }).plan;
  assert.equal(plan.items.find((item) => item.id === firstItem.id).decision, 'completed');
  plan = mutate(store, plan, 'item_reopen', { itemId: firstItem.id }).plan;
  assert.equal(plan.items.find((item) => item.id === firstItem.id).decision, 'accepted');
  plan = mutate(store, plan, 'item_reorder', { itemId: secondItem.id, position: 0 }).plan;
  assert.deepEqual(
    [...plan.items]
      .sort((left, right) => left.position - right.position)
      .map((item) => item.id),
    [secondItem.id, firstItem.id],
  );
  assert.deepEqual(
    [...plan.items].sort((left, right) => left.position - right.position).map((item) => item.position),
    [0, 1],
  );

  plan = mutate(store, plan, 'settlement_start').plan;
  assert.equal(plan.state, 'settling');
  assert.equal(plan.settlementState, 'in_progress');
});

test('settlement cancel restores a bypassed active plan with its promoted items', (t) => {
  const { store } = isolatedStore(t);
  let plan = ensure(store, 'ensure:proposed-settlement-cancel').plan;
  plan = mutate(store, plan, 'arrival_bypass').plan;
  const before = structuredClone(plan);

  plan = mutate(store, plan, 'settlement_start').plan;
  assert.equal(plan.state, 'settling');
  assert.equal(plan.settlementState, 'in_progress');
  plan = mutate(store, plan, 'settlement_cancel').plan;

  assert.equal(plan.state, before.state);
  assert.equal(plan.state, 'active');
  assert.equal(plan.arrivalState, before.arrivalState);
  assert.equal(plan.arrivalState, 'bypassed');
  assert.equal(plan.confirmedAt, before.confirmedAt);
  assert.equal(plan.settlementState, 'offered');
  assert.deepEqual(plan.items, before.items);
  assert.ok(plan.items.every((item) => item.decision === 'accepted'));
  const movedId = plan.items[1].id;
  plan = mutate(store, plan, 'item_reorder', { itemId: movedId, position: 0 }).plan;
  assert.equal(
    [...plan.items].sort((left, right) => left.position - right.position)[0].id,
    movedId,
  );
});

test('an accepted item can be completed and reopened while settlement is in progress', (t) => {
  const { file, store } = isolatedStore(t);
  const db = new Database(file);
  createManagedBoardTables(db);
  db.prepare(
    `INSERT INTO tasks
      (id, column_id, title, description, priority, tags, position,
       status, created_at, updated_at)
     VALUES ('task-a', 'col-today', 'Task task-a', 'Finish task-a', 'high', '[]', 0,
             'open', '2026-07-10T15:00:00.000Z', '2026-07-10T15:00:00.000Z')`,
  ).run();
  db.close();

  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  plan = mutate(store, plan, 'start_day').plan;
  plan = mutate(store, plan, 'settlement_start').plan;
  const item = plan.items.find((candidate) => candidate.taskId === 'task-a');
  plan = mutate(store, plan, 'settlement_decide', {
    itemId: item.id,
    disposition: 'carry',
  }).plan;

  plan = mutate(store, plan, 'item_complete', { itemId: item.id }).plan;
  const completedItem = plan.items.find((candidate) => candidate.id === item.id);
  assert.equal(completedItem.decision, 'completed');
  assert.equal(completedItem.settlementDecision, undefined);
  let verified = new Database(file);
  assert.deepEqual(
    verified.prepare("SELECT column_id, status FROM tasks WHERE id = 'task-a'").get(),
    { column_id: 'col-done', status: 'done' },
  );
  verified.close();

  plan = mutate(store, plan, 'item_reopen', { itemId: item.id }).plan;
  const reopenedItem = plan.items.find((candidate) => candidate.id === item.id);
  assert.equal(reopenedItem.decision, 'accepted');
  assert.equal(reopenedItem.settlementDecision, undefined);
  verified = new Database(file);
  assert.deepEqual(
    verified.prepare("SELECT column_id, status, position FROM tasks WHERE id = 'task-a'").get(),
    { column_id: 'col-today', status: 'open', position: 0 },
  );
  verified.close();
});

test('reordering stays forbidden while settlement is in progress', (t) => {
  const { store } = isolatedStore(t);
  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  plan = mutate(store, plan, 'start_day').plan;
  plan = mutate(store, plan, 'settlement_start').plan;

  assert.throws(
    () => mutate(store, plan, 'item_reorder', {
      itemId: plan.items[1].id,
      position: 0,
    }),
    (error) => error instanceof DayPlanInvalidTransition,
  );
});

test('completion and reopen mutations are forbidden after settlement', (t) => {
  const { store } = isolatedStore(t);
  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  plan = mutate(store, plan, 'start_day').plan;
  plan = mutate(store, plan, 'settlement_start').plan;
  plan = mutate(store, plan, 'settlement_commit', {
    completedHumanTaskIds: plan.items.map((item) => item.taskId),
  }).plan;
  const itemId = plan.items[0].id;

  assert.throws(
    () => mutate(store, plan, 'item_complete', { itemId }),
    (error) => error instanceof DayPlanInvalidTransition && /settled/.test(error.message),
  );
  assert.throws(
    () => mutate(store, plan, 'item_reopen', { itemId }),
    (error) => error instanceof DayPlanInvalidTransition && /settled/.test(error.message),
  );
  assert.throws(
    () => mutate(store, plan, 'settlement_cancel'),
    (error) => error instanceof DayPlanInvalidTransition && /settled/.test(error.message),
  );
});

test('active Today accepts a new item at the end of the current order', (t) => {
  const { store } = isolatedStore(t);
  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  plan = mutate(store, plan, 'start_day').plan;

  plan = mutate(store, plan, 'item_add', {
    title: 'Call the client',
    outcome: 'The client has the answer.',
    why: 'The decision is needed today.',
    owner: 'together',
  }).plan;

  assert.equal(plan.items.at(-1).title, 'Call the client');
  assert.equal(plan.items.at(-1).decision, 'accepted');
  assert.equal(plan.items.at(-1).position, 2);
  assert.deepEqual(plan.items.map((item) => item.position), [0, 1, 2]);
});

test('active Today revives later and dismissed task-backed items as accepted', (t) => {
  const { file, store } = isolatedStore(t);
  const db = new Database(file);
  createManagedBoardTables(db);
  const insert = db.prepare(
    `INSERT INTO tasks
      (id, column_id, title, description, priority, tags, position,
       status, created_at, updated_at)
     VALUES (?, 'col-ns', ?, ?, 'medium', '[]', ?, 'open', ?, ?)`,
  );
  ['task-later', 'task-dismissed'].forEach((taskId, position) => insert.run(
    taskId,
    `Task ${taskId}`,
    `Finish ${taskId}`,
    position,
    '2026-07-10T15:00:00.000Z',
    '2026-07-10T15:00:00.000Z',
  ));
  db.close();

  let plan = ensure(store, 'ensure:active-revival').plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  plan = mutate(store, plan, 'item_add', { taskId: 'task-later' }).plan;
  plan = mutate(store, plan, 'item_add', { taskId: 'task-dismissed' }).plan;
  const laterItem = plan.items.find((item) => item.taskId === 'task-later');
  const dismissedItem = plan.items.find((item) => item.taskId === 'task-dismissed');
  plan = mutate(store, plan, 'item_later', { itemId: laterItem.id }).plan;
  plan = mutate(store, plan, 'item_dismiss', { itemId: dismissedItem.id }).plan;
  plan = mutate(store, plan, 'start_day').plan;

  plan = mutate(store, plan, 'item_add', { taskId: 'task-later' }).plan;
  plan = mutate(store, plan, 'item_add', { taskId: 'task-dismissed' }).plan;

  const revivedLater = plan.items.find((item) => item.taskId === 'task-later');
  const revivedDismissed = plan.items.find((item) => item.taskId === 'task-dismissed');
  assert.equal(revivedLater.id, laterItem.id);
  assert.equal(revivedLater.decision, 'accepted');
  assert.equal(revivedDismissed.id, dismissedItem.id);
  assert.equal(revivedDismissed.decision, 'accepted');
  assert.equal(plan.items.filter((item) => item.taskId === 'task-later').length, 1);
  assert.equal(plan.items.filter((item) => item.taskId === 'task-dismissed').length, 1);
});

test('settled Today items cannot be reordered', (t) => {
  const { store } = isolatedStore(t);
  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  plan = mutate(store, plan, 'start_day').plan;
  plan = mutate(store, plan, 'settlement_start').plan;
  plan = mutate(store, plan, 'settlement_commit', {
    completedHumanTaskIds: plan.items.map((item) => item.taskId),
  }).plan;

  assert.equal(plan.state, 'settled');
  assert.throws(
    () => mutate(store, plan, 'item_reorder', {
      itemId: plan.items[0].id,
      position: 1,
    }),
    (error) => error instanceof DayPlanInvalidTransition && /settled/.test(error.message),
  );
});

test('Morning Arrival reviews an active day without resetting its confirmation', (t) => {
  const { store } = isolatedStore(t);
  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  plan = mutate(store, plan, 'start_day').plan;
  const versionBeforeReopen = plan.version;
  const confirmedAt = plan.confirmedAt;
  const firstItemId = plan.recommendedFirstItemId;

  const reopened = mutate(store, plan, 'arrival_reopen');
  plan = reopened.plan;
  assert.equal(plan.state, 'active');
  assert.equal(plan.arrivalState, 'opened');
  assert.equal(plan.settlementState, 'not_due');
  assert.equal(plan.version, versionBeforeReopen + 1);
  assert.equal(plan.recommendedFirstItemId, firstItemId);
  assert.equal(plan.recommendedFirstTaskId, 'task-a');
  assert.equal(plan.confirmedAt, confirmedAt);
  const reopenEvent = store.listEvents(plan.id).find(
    (event) => event.id === plan.lastMutationId,
  );
  assert.equal(reopenEvent.eventType, 'arrival_reopen');
  assert.equal(reopenEvent.resultVersion, plan.version);

  plan = mutate(store, plan, 'start_day').plan;
  assert.equal(plan.state, 'active');
  assert.equal(plan.arrivalState, 'confirmed');
  assert.equal(plan.recommendedFirstTaskId, 'task-a');
});

test('Morning Arrival cancels an in-progress settlement but never reopens a settled day', (t) => {
  const { store } = isolatedStore(t);
  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  plan = mutate(store, plan, 'start_day').plan;
  plan = mutate(store, plan, 'settlement_start').plan;
  plan = mutate(store, plan, 'settlement_decide', {
    itemId: plan.items[1].id,
    disposition: 'carry',
  }).plan;

  plan = mutate(store, plan, 'arrival_reopen').plan;
  assert.equal(plan.state, 'proposed');
  assert.equal(plan.arrivalState, 'opened');
  assert.equal(plan.settlementState, 'not_due');
  assert.equal(plan.items.every((item) => item.settlementDecision === undefined), true);

  plan = mutate(store, plan, 'start_day').plan;
  plan = mutate(store, plan, 'settlement_start').plan;
  plan = mutate(store, plan, 'settlement_commit', {
    completedHumanTaskIds: plan.items.map((item) => item.taskId),
  }).plan;
  const settledVersion = plan.version;
  assert.throws(
    () => mutate(store, plan, 'arrival_reopen'),
    (error) => error instanceof DayPlanInvalidTransition && /already settled/.test(error.message),
  );
  assert.equal(store.getPlan(plan.id).version, settledVersion);
});

test('Morning Arrival never reopens an abandoned day', (t) => {
  const { file, store } = isolatedStore(t);
  const plan = ensure(store).plan;
  const db = new Database(file);
  db.prepare(
    "UPDATE day_plans SET plan_state = 'abandoned', open_slot = NULL WHERE id = ?",
  ).run(plan.id);
  db.close();
  const abandoned = store.getPlan(plan.id);

  assert.equal(abandoned.state, 'abandoned');
  assert.throws(
    () => mutate(store, abandoned, 'arrival_reopen'),
    (error) => error instanceof DayPlanInvalidTransition && /already abandoned/.test(error.message),
  );
  assert.equal(store.getPlan(plan.id).version, abandoned.version);
});

test('Not today removes a preselected outcome without changing the underlying task', (t) => {
  const { store } = isolatedStore(t);
  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  const dismissedId = plan.items[0].id;
  plan = mutate(store, plan, 'item_dismiss', { itemId: dismissedId }).plan;
  assert.equal(plan.items.at(-1).id, dismissedId);
  assert.equal(plan.items.at(-1).decision, 'dismissed');

  plan = mutate(store, plan, 'start_day').plan;
  assert.equal(plan.recommendedFirstTaskId, 'task-b');
  assert.equal(plan.items.find((item) => item.id === dismissedId).decision, 'dismissed');
});

test('an all-Claude local plan selects handoff preparation without the gated batch', (t) => {
  const { store } = isolatedStore(t);
  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  for (const item of plan.items) {
    plan = mutate(store, plan, 'item_owner', {
      itemId: item.id,
      owner: 'claude',
    }).plan;
  }
  plan = mutate(store, plan, 'start_day').plan;
  assert.equal(plan.recommendedFirstTaskId, 'task-a');
  assert.equal(plan.items.every((item) => item.owner === 'claude'), true);
  assert.equal(store.listExecutionRuns(plan.id).length, 0);
  // Local owner chips use task sessions instead of the gated unattended lane.
  assert.equal(store.listEvents(plan.id).some((event) => event.eventType.includes('run')), false);
});

test('Start My Day recommends the first human-owned item beyond the focus band', (t) => {
  const { store } = isolatedStore(t);
  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  plan = mutate(store, plan, 'item_add', {
    title: 'Third Claude task',
    outcome: 'Third Claude task is ready.',
    why: 'It belongs in the focus band.',
    owner: 'claude',
  }).plan;
  plan = mutate(store, plan, 'item_add', {
    title: 'Operator task',
    outcome: 'Operator task is complete.',
    why: 'It needs the operator after the focus band.',
    owner: 'me',
  }).plan;
  for (const item of plan.items.slice(0, 2)) {
    plan = mutate(store, plan, 'item_owner', { itemId: item.id, owner: 'claude' }).plan;
  }
  const operatorItem = [...plan.items]
    .sort((left, right) => left.position - right.position)
    .find((item) => item.owner === 'me');
  assert.equal(operatorItem.position, 3);

  plan = mutate(store, plan, 'start_day').plan;
  assert.equal(plan.recommendedFirstItemId, operatorItem.id);
  assert.equal(plan.recommendedFirstTaskId, operatorItem.taskId);
});

test('a human-confirmed Done task can close even when its planned owner was Claude', (t) => {
  const { store } = isolatedStore(t);
  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  plan = mutate(store, plan, 'item_owner', {
    itemId: plan.items[0].id,
    owner: 'claude',
  }).plan;
  plan = mutate(store, plan, 'start_day').plan;
  plan = mutate(store, plan, 'settlement_start').plan;
  plan = mutate(store, plan, 'settlement_decide', {
    itemId: plan.items[1].id,
    disposition: 'carry',
  }).plan;

  const committed = mutate(store, plan, 'settlement_commit', {
    completedHumanTaskIds: [plan.items[0].taskId],
  });
  assert.equal(committed.plan.state, 'settled');
  assert.deepEqual(committed.snapshot.body.completedHumanTaskIds, [plan.items[0].taskId]);
  assert.deepEqual(committed.snapshot.body.overnightQueue, []);
});

test('settlement saves decisions immediately and writes one factual snapshot', (t) => {
  const { store, setClock } = isolatedStore(t);
  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  plan = mutate(store, plan, 'start_day').plan;
  plan = mutate(store, plan, 'settlement_start').plan;
  assert.equal(plan.state, 'settling');

  setClock('2026-07-10T23:00:00.000Z');
  plan = mutate(store, plan, 'settlement_decide', {
    itemId: plan.items[1].id,
    disposition: 'carry',
  }).plan;
  assert.equal(plan.items[1].settlementDecision.disposition, 'carry');

  const commitInput = {
    planId: plan.id,
    mutationId: `settlement-commit:${plan.id}`,
    expectedVersion: plan.version,
    action: 'settlement_commit',
    completedHumanTaskIds: ['task-a'],
    nextDayNote: 'Begin with the carry.',
  };
  const committed = store.mutateDayPlan(commitInput);
  assert.equal(committed.plan.state, 'settled');
  assert.equal(committed.plan.settlementState, 'settled');
  assert.deepEqual(committed.snapshot.body.completedHumanTaskIds, ['task-a']);
  assert.deepEqual(committed.snapshot.body.overnightQueue, []);
  assert.equal(committed.snapshot.body.unresolvedItems[0].disposition, 'carry');
  assert.equal(committed.snapshot.body.nextDayRecommendationSeed.taskId, 'task-b');
  assert.equal(store.getReadModel().currentPlan, undefined);

  const replay = store.mutateDayPlan(commitInput);
  assert.equal(replay.replayed, true);
  assert.equal(replay.snapshot.id, committed.snapshot.id);
});

test('progress stores bounded continuity details, seeds before carry, and writes no reconciliation', (t) => {
  const { store } = isolatedStore(t);
  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  plan = mutate(store, plan, 'start_day').plan;
  plan = mutate(store, plan, 'settlement_start').plan;
  plan = mutate(store, plan, 'settlement_decide', {
    itemId: plan.items[0].id,
    disposition: 'carry',
  }).plan;
  plan = mutate(store, plan, 'settlement_decide', {
    itemId: plan.items[1].id,
    disposition: 'progress',
    progressNote: '  Finished the first draft.  ',
    nextStep: '  Review the pricing section.  ',
  }).plan;

  assert.deepEqual(
    {
      disposition: plan.items[1].settlementDecision.disposition,
      progressNote: plan.items[1].settlementDecision.progressNote,
      nextStep: plan.items[1].settlementDecision.nextStep,
    },
    {
      disposition: 'progress',
      progressNote: 'Finished the first draft.',
      nextStep: 'Review the pricing section.',
    },
  );
  const committed = mutate(store, plan, 'settlement_commit', {
    completedHumanTaskIds: [],
  });
  const progress = committed.snapshot.body.unresolvedItems.find(
    (item) => item.disposition === 'progress',
  );
  assert.equal(progress.progressNote, 'Finished the first draft.');
  assert.equal(progress.nextStep, 'Review the pricing section.');
  assert.equal(committed.snapshot.body.nextDayRecommendationSeed.taskId, 'task-b');
  assert.deepEqual(committed.pendingReconciliations, []);
});

test('settlement rejects progress details on carry and preserves the exact completion gate copy', (t) => {
  const { store } = isolatedStore(t);
  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  plan = mutate(store, plan, 'start_day').plan;
  plan = mutate(store, plan, 'settlement_start').plan;

  assert.throws(
    () => mutate(store, plan, 'settlement_decide', {
      itemId: plan.items[0].id,
      disposition: 'carry',
      progressNote: 'This does not belong on Carry.',
    }),
    (error) =>
      error instanceof DayPlanInvalidTransition &&
      error.message === 'Progress details are only valid for a Progress decision.',
  );
  assert.throws(
    () => mutate(store, plan, 'settlement_commit', { completedHumanTaskIds: [] }),
    (error) =>
      error instanceof DayPlanInvalidTransition &&
      error.message === 'Every unfinished accepted item needs Progress, Carry, Defer, or Drop.',
  );
});

test('settlement evidence marks only same-local-date gated execution rows as worked today', (t) => {
  const previousRuntime = process.env.NEXT_PUBLIC_COVE_RUNTIME;
  process.env.NEXT_PUBLIC_COVE_RUNTIME = 'supabase';
  t.after(() => {
    if (previousRuntime === undefined) delete process.env.NEXT_PUBLIC_COVE_RUNTIME;
    else process.env.NEXT_PUBLIC_COVE_RUNTIME = previousRuntime;
  });
  const { store } = isolatedStore(t);
  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  plan = mutate(store, plan, 'item_owner', {
    itemId: plan.items[0].id,
    owner: 'claude',
  }).plan;
  plan = mutate(store, plan, 'start_day').plan;
  plan = mutate(store, plan, 'settlement_start').plan;

  const settlement = store.withSettlementEvidence(plan);
  assert.equal(settlement.items[0].workedToday, true);
  assert.equal(settlement.items[1].workedToday, false);
  assert.equal(store.getPlan(plan.id).items[0].workedToday, undefined);
});

test('old snapshot bodies without progress fields still parse', (t) => {
  const { file, store } = isolatedStore(t);
  const plan = ensure(store).plan;
  const body = {
    completedHumanTaskIds: [],
    returnedAgentWork: [],
    unresolvedItems: [{
      dayPlanItemId: plan.items[0].id,
      taskId: plan.items[0].taskId,
      title: plan.items[0].title,
      owner: 'me',
      disposition: 'carry',
    }],
    humanDecisionEventIds: [],
    overnightQueue: [],
  };
  const db = new Database(file);
  db.prepare(
    `INSERT INTO day_snapshots
      (id, day_plan_id, local_date, timezone, version, body_json, created_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
  ).run('legacy-snapshot', plan.id, plan.localDate, plan.timezone, JSON.stringify(body), plan.createdAt);
  db.close();

  const [snapshot] = store.listRecentSnapshots(1);
  assert.equal(snapshot.body.unresolvedItems[0].disposition, 'carry');
  assert.equal(snapshot.body.unresolvedItems[0].progressNote, undefined);
  assert.equal(snapshot.body.unresolvedItems[0].nextStep, undefined);
});

test('settlement start reconciles canonical completion evidence and repeated refreshes are idempotent', (t) => {
  const { store } = isolatedStore(t);
  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  plan = mutate(store, plan, 'start_day').plan;

  plan = mutate(store, plan, 'settlement_start', {
    completedHumanTaskIds: ['task-a'],
  }).plan;
  assert.equal(plan.items.find((item) => item.taskId === 'task-a').decision, 'completed');
  assert.equal(plan.items.find((item) => item.taskId === 'task-b').decision, 'accepted');
  const version = plan.version;
  const eventCount = store.listEvents(plan.id).length;

  const repeated = mutate(store, plan, 'settlement_start', {
    completedHumanTaskIds: ['task-a'],
  }).plan;
  assert.equal(repeated.version, version);
  assert.equal(store.listEvents(plan.id).length, eventCount);

  plan = mutate(store, repeated, 'settlement_start', {
    completedHumanTaskIds: ['task-a', 'task-b'],
  }).plan;
  assert.equal(plan.version, version + 1);
  assert.equal(plan.items.every((item) => item.decision === 'completed'), true);

  const committed = mutate(store, plan, 'settlement_commit', {
    completedHumanTaskIds: ['task-a', 'task-b'],
  });
  assert.equal(committed.plan.state, 'settled');
  assert.deepEqual(committed.snapshot.body.completedHumanTaskIds, ['task-a', 'task-b']);
});

test('settlement writes a durable task reconciliation ledger before external task updates', (t) => {
  const { store, setClock } = isolatedStore(t);
  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  plan = mutate(store, plan, 'start_day').plan;
  plan = mutate(store, plan, 'settlement_start').plan;
  plan = mutate(store, plan, 'settlement_decide', {
    itemId: plan.items[1].id,
    disposition: 'defer',
    deferUntil: '2026-07-17T23:00:00.000Z',
  }).plan;

  const committed = mutate(store, plan, 'settlement_commit', {
    completedHumanTaskIds: ['task-a'],
  });
  assert.equal(committed.pendingReconciliations.length, 1);
  const pending = committed.pendingReconciliations[0];
  assert.equal(pending.taskId, 'task-b');
  assert.equal(pending.action, 'defer');
  assert.equal(store.getReadModel().pendingReconciliations.length, 1);

  setClock('2026-07-18T00:00:00.000Z');
  const overdue = store.listPendingReconciliations();
  assert.deepEqual(overdue.map((entry) => entry.action), ['defer', 'resurface']);

  const applied = store.acknowledgeReconciliation(pending.id);
  assert.equal(applied.reconciliation.state, 'applied');
  assert.equal(applied.replayed, false);
  assert.equal(store.acknowledgeReconciliation(pending.id).replayed, true);

  const resurface = store.listPendingReconciliations();
  assert.equal(resurface.length, 1);
  assert.equal(resurface[0].action, 'resurface');
  assert.equal(resurface[0].taskId, 'task-b');
  store.acknowledgeReconciliation(resurface[0].id);
  assert.deepEqual(store.listPendingReconciliations(), []);
});

test('failed settlement commit rolls back without a partial snapshot', (t) => {
  const { store } = isolatedStore(t);
  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  plan = mutate(store, plan, 'start_day').plan;
  plan = mutate(store, plan, 'settlement_start').plan;
  const version = plan.version;

  assert.throws(
    () =>
      mutate(store, plan, 'settlement_commit', {
        completedHumanTaskIds: ['task-a'],
      }),
    /Every unfinished accepted item/,
  );
  assert.equal(store.getPlan(plan.id).version, version);
  assert.equal(store.getSnapshot(plan.id), undefined);
});

test('a brief still attaches when some picks vanished and only resolving picks carry rationale', (t) => {
  const { store } = isolatedStore(t);
  ensure(store, 'ensure:partial-brief-picks:baseline');
  const artifact = store.enqueueMorningBrief('2026-07-10', {
    modelAlias: 'opus', effort: 'high', budgetUsd: 1.5,
  }).brief;
  store.claimNextMorningBrief();
  store.completeMorningBrief(artifact.id, JSON.stringify({
    headline: 'Focus.', narrativeParagraphs: ['Do the work.'], lensNarrative: 'Focus.\n\nDo the work.',
    existingTaskCandidates: [
      {
        taskId: 'task-vanished', whyToday: 'This card vanished.', suggestedOwner: 'me',
        whatClaudeCanStart: '', evidenceRefs: [],
      },
      {
        taskId: 'task-a', whyToday: 'This is the live priority.', suggestedOwner: 'claude',
        whatClaudeCanStart: 'Draft the first pass.', evidenceRefs: [],
      },
    ],
    watchItems: [], boardActions: [],
  }));

  const plan = store.ensureDayPlan({
    localDate: '2026-07-10',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:partial-brief-picks:attach',
    candidates: candidates(),
    attachOnly: true,
  }).plan;
  assert.equal(plan.briefId, artifact.id);
  assert.deepEqual(plan.items.map((item) => item.taskId), ['task-a', 'task-b']);
  assert.equal(plan.items.find((item) => item.taskId === 'task-a').brief.whyToday,
    'This is the live priority.');
  assert.equal(plan.items.find((item) => item.taskId === 'task-b').brief, undefined);
});

test('brief board actions stage once, activate atomically, preserve human edits, and receipt outcomes', (t) => {
  const { file, store, setClock } = isolatedStore(t, '2026-07-10T05:00:00.000Z');
  const db = new Database(file);
  db.exec(`
    DELETE FROM tasks;
    DELETE FROM task_columns;
    INSERT INTO task_columns (id, name, position) VALUES
      ('col-ns', 'Not Started', 0),
      ('col-today', 'Must happen today', 10),
      ('col-flight', 'In Flight / Waiting', 20);
  `);
  const insertTask = db.prepare(`
    INSERT INTO tasks
      (id, column_id, title, description, priority, tags, project, position,
       status, recurring_template_id, created_at, updated_at)
    VALUES (?, 'col-ns', ?, ?, 'medium', ?, 'Atlas', ?, 'open', ?, ?, ?)
  `);
  const snapshotAt = '2026-07-10T04:00:00.000Z';
  insertTask.run('task-a', 'Old title', 'Full old description', '[]', 0, null, snapshotAt, snapshotAt);
  insertTask.run('task-b', 'Human edits me', 'Keep it', '[]', 1, null, snapshotAt, snapshotAt);
  insertTask.run('task-r', 'Recurring', 'Protected', JSON.stringify(['recurring']), 2, 'template-1', snapshotAt, snapshotAt);
  insertTask.run('task-dupe', 'Duplicate', 'Duplicate description', '[]', 3, null, snapshotAt, snapshotAt);
  insertTask.run('task-survivor', 'Survivor', 'Canonical description', '[]', 4, null, snapshotAt, snapshotAt);

  const queued = store.enqueueMorningBrief('2026-07-10', {
    modelAlias: 'opus', effort: 'high', budgetUsd: 1.5,
  }).brief;
  store.claimNextMorningBrief();
  const boardActions = [
    {
      op: 'retitle', taskId: 'task-a', title: 'Clear title', why: 'Clarify.',
      evidenceRefs: [], expectedTaskUpdatedAt: snapshotAt,
    },
    {
      op: 'set_priority', taskId: 'task-b', priority: 'high', why: 'Goal fit.',
      evidenceRefs: [], expectedTaskUpdatedAt: snapshotAt,
    },
    {
      op: 'archive', taskId: 'task-r', why: 'Stale.', evidenceRefs: [],
      expectedTaskUpdatedAt: snapshotAt,
    },
    {
      op: 'archive_duplicate', taskId: 'task-dupe', duplicateOfTaskId: 'task-survivor',
      why: 'Duplicate.', evidenceRefs: [], expectedTaskUpdatedAt: snapshotAt,
    },
  ];
  const completed = store.completeMorningBrief(queued.id, JSON.stringify({
    headline: 'Focus.', narrativeParagraphs: ['Do the work.'], lensNarrative: 'Focus.\n\nDo the work.',
    existingTaskCandidates: [], watchItems: [],
    boardActions,
  }));
  assert.ok(completed);
  assert.equal(store.stageMorningBriefBoardActions(completed.id), 4);
  assert.equal(store.stageMorningBriefBoardActions(completed.id), 0);
  assert.equal(store.latestEligibleMorningBrief('2026-07-10'), undefined);
  assert.deepEqual(
    store.activateBriefBoardActions('2026-07-10', new Date('2026-07-10T05:00:00.000Z')),
    { activated: false, applied: 0, skippedConflict: 0, skippedOfflimits: 0 },
  );

  db.prepare("UPDATE tasks SET title = 'Human title', updated_at = ? WHERE id = 'task-b'")
    .run('2026-07-10T15:00:00.000Z');
  setClock('2026-07-10T16:00:00.000Z');
  const result = store.activateBriefBoardActions(
    '2026-07-10',
    new Date('2026-07-10T16:00:00.000Z'),
  );
  assert.deepEqual(result, {
    activated: true,
    artifactId: completed.id,
    applied: 2,
    skippedConflict: 1,
    skippedOfflimits: 1,
  });
  assert.equal(db.prepare("SELECT title FROM tasks WHERE id = 'task-a'").get().title, 'Clear title');
  assert.equal(db.prepare("SELECT priority FROM tasks WHERE id = 'task-b'").get().priority, 'medium');
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id = 'task-r'").get().status, 'open');
  assert.equal(db.prepare("SELECT status FROM tasks WHERE id = 'task-dupe'").get().status, 'archived');
  const actionRows = db.prepare(
    'SELECT state, before_json, after_json FROM day_plan_brief_actions ORDER BY action_index',
  ).all();
  assert.deepEqual(actionRows.map((row) => row.state), [
    'applied', 'skipped_conflict', 'skipped_offlimits', 'applied',
  ]);
  assert.ok(actionRows.every((row) => row.before_json && row.after_json));
  assert.ok(store.latestEligibleMorningBrief('2026-07-10'));
  assert.equal(store.morningBriefManagementSummary(completed.id),
    'Cove reorganized the board this morning: 2 board changes applied, 1 change left alone because you edited the card, 1 protected card left alone.');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM cove_receipts WHERE source = 'morning-brief-management'").get().count, 1);
  assert.equal(store.activateBriefBoardActions('2026-07-10').activated, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM cove_receipts WHERE source = 'morning-brief-management'").get().count, 1);
  db.close();
  assert.equal(MORNING_BRIEF_PROMPT_VERSION, 25);
  assert.equal(MORNING_BRIEF_SCHEMA_VERSION, 8);
});

test('grounded brief task creation writes one real Today task and deduplicates live titles', (t) => {
  const { file, store } = isolatedStore(t, '2026-07-10T16:00:00.000Z');
  const db = new Database(file);
  createManagedBoardTables(db);
  const queued = store.enqueueMorningBrief('2026-07-10', {
    modelAlias: 'opus', effort: 'high', budgetUsd: 1.5,
  }).brief;
  store.claimNextMorningBrief();
  const boardActions = [
    {
      op: 'create_task',
      title: "Review Asher's founders agreement",
      description: 'Read the agreement and record the clauses that need a decision.',
      priority: 'high',
      dueLocalDate: '2026-07-10',
      why: 'Concrete work from the brief.',
      evidenceRefs: ['sprint_memo:asher'],
    },
    {
      op: 'create_task',
      title: "  review   ASHER'S founders agreement ",
      description: 'Duplicate wording should not create another card.',
      priority: 'medium',
      dueLocalDate: null,
      why: 'Duplicate test.',
      evidenceRefs: ['sprint_memo'],
    },
  ];
  const completed = store.completeMorningBrief(queued.id, JSON.stringify({
    headline: 'Focus.', narrativeParagraphs: ['Do the work.'], lensNarrative: 'Focus.\n\nDo the work.',
    existingTaskCandidates: [], watchItems: [], boardActions,
  }));
  assert.ok(completed);
  assert.equal(store.stageMorningBriefBoardActions(completed.id), 2);

  const result = store.activateBriefBoardActions(
    '2026-07-10',
    new Date('2026-07-10T16:00:00.000Z'),
  );
  assert.equal(result.applied, 1);
  assert.equal(result.skippedConflict, 1);
  const created = db.prepare(
    `SELECT tasks.*, task_columns.name AS column_name
     FROM tasks JOIN task_columns ON task_columns.id = tasks.column_id`,
  ).all();
  assert.equal(created.length, 1);
  assert.match(created[0].id, /^morning-brief-[a-f0-9]{32}$/);
  assert.equal(created[0].title, "Review Asher's founders agreement");
  assert.equal(created[0].column_name, 'Must happen today');
  assert.equal(created[0].priority, 'high');
  assert.equal(created[0].due_date, '2026-07-10');
  assert.equal(
    created[0].origin,
    'Suggested by your Morning Brief on Jul 10, 2026. Cove created it when the brief was applied: Concrete work from the brief.',
  );
  assert.deepEqual(
    db.prepare('SELECT state FROM day_plan_brief_actions ORDER BY action_index').pluck().all(),
    ['applied', 'skipped_conflict'],
  );
  assert.deepEqual(store.morningBriefCreatedTaskPicks(completed.id), [{
    taskId: created[0].id,
    whyToday: 'Concrete work from the brief.',
  }]);
  assert.equal(store.activateBriefBoardActions('2026-07-10').activated, false);
  assert.equal(db.prepare('SELECT COUNT(*) FROM tasks').pluck().get(), 1);
  db.close();
});

test('brief task creation reuses the real id of an existing matching task', (t) => {
  const { file, store } = isolatedStore(t, '2026-07-10T16:00:00.000Z');
  const db = new Database(file);
  createManagedBoardTables(db);
  db.prepare(
    `INSERT INTO tasks
      (id, column_id, title, description, priority, tags, position, status, created_at, updated_at)
     VALUES ('existing-agreement', 'col-ns', ?, '', 'medium', '[]', 0, 'open', ?, ?)`,
  ).run(
    "Review Asher's founders agreement",
    '2026-07-09T16:00:00.000Z',
    '2026-07-09T16:00:00.000Z',
  );
  const queued = store.enqueueMorningBrief('2026-07-10', {
    modelAlias: 'opus', effort: 'high', budgetUsd: 1.5,
  }).brief;
  store.claimNextMorningBrief();
  const completed = store.completeMorningBrief(queued.id, JSON.stringify({
    headline: 'Focus.',
    narrativeParagraphs: ['Review the agreement.'],
    lensNarrative: 'Focus.\n\nReview the agreement.',
    existingTaskCandidates: [],
    watchItems: [],
    boardActions: [{
      op: 'create_task',
      title: "Review Asher's founders agreement",
      description: 'Read the agreement and record the clauses that need a decision.',
      priority: 'high',
      dueLocalDate: null,
      why: 'The agreement needs a decision today.',
      evidenceRefs: ['sprint_memo:asher'],
    }],
  }));
  assert.ok(completed);
  assert.equal(store.stageMorningBriefBoardActions(completed.id), 1);
  assert.deepEqual(store.activateBriefBoardActions('2026-07-10'), {
    activated: true,
    artifactId: completed.id,
    applied: 0,
    skippedConflict: 1,
    skippedOfflimits: 0,
  });
  assert.equal(db.prepare('SELECT COUNT(*) FROM tasks').pluck().get(), 1);
  assert.deepEqual(store.morningBriefCreatedTaskPicks(completed.id), [{
    taskId: 'existing-agreement',
    whyToday: 'The agreement needs a decision today.',
  }]);
  db.close();
});

test('refused brief board activation terminal-marks actions without changing tasks', (t) => {
  const { file, store } = isolatedStore(t, '2026-07-10T16:00:00.000Z');
  const plan = ensure(store, 'ensure:activation-pristine').plan;
  store.markArrivalInteraction(plan.id, 'interact:activation-pristine');
  const db = new Database(file);
  db.exec(`
    DELETE FROM tasks;
    DELETE FROM task_columns;
    INSERT INTO task_columns VALUES ('col-ns', 'Not Started', 0);
    INSERT INTO tasks
      (id, column_id, title, tags, status, updated_at)
    VALUES ('task-a', 'col-ns', 'Human board', '[]', 'open', '2026-07-10T15:00:00.000Z');
  `);
  const queued = store.enqueueMorningBrief('2026-07-10', {
    modelAlias: 'opus', effort: 'high', budgetUsd: 1.5,
  }).brief;
  store.claimNextMorningBrief();
  store.completeMorningBrief(queued.id, JSON.stringify({
    headline: 'Focus.', narrativeParagraphs: ['Work.'], lensNarrative: 'Focus.\n\nWork.',
    existingTaskCandidates: [], watchItems: [],
    boardActions: [{
      op: 'retitle', taskId: 'task-a', title: 'Agent title', why: 'Clarify.',
      evidenceRefs: [], expectedTaskUpdatedAt: '2026-07-10T15:00:00.000Z',
    }],
  }));
  store.stageMorningBriefBoardActions(queued.id);
  assert.equal(store.activateBriefBoardActions('2026-07-10').activated, false);
  assert.equal(db.prepare("SELECT title FROM tasks WHERE id = 'task-a'").get().title, 'Human board');
  assert.deepEqual(
    db.prepare("SELECT state, terminal_at FROM day_plan_brief_actions").get(),
    { state: 'skipped_late', terminal_at: '2026-07-10T16:00:00.000Z' },
  );
  assert.equal(store.latestEligibleMorningBrief('2026-07-10').id, queued.id);
  assert.equal(store.morningBriefManagementSummary(queued.id), undefined);
  assert.equal(store.forceAttachMorningBrief('2026-07-10', queued.id), true);
  assert.equal(store.getPlan(plan.id).briefId, queued.id);
  db.close();
});

test('activation fails closed when either side of the task timestamp guard is missing', (t) => {
  const { file, store } = isolatedStore(t);
  const db = new Database(file);
  createManagedBoardTables(db);
  db.prepare(
    `INSERT INTO tasks
      (id, column_id, title, description, priority, tags, position, status, updated_at)
     VALUES (?, 'col-ns', ?, '', 'medium', '[]', ?, 'open', ?)`,
  ).run('task-empty-expected', 'Keep empty expected', 0, '2026-07-10T15:00:00.000Z');
  db.prepare(
    `INSERT INTO tasks
      (id, column_id, title, description, priority, tags, position, status, updated_at)
     VALUES (?, 'col-ns', ?, '', 'medium', '[]', ?, 'open', NULL)`,
  ).run('task-null-live', 'Keep null live', 1);

  const artifact = store.enqueueMorningBrief('2026-07-10', {
    modelAlias: 'opus', effort: 'high', budgetUsd: 1.5,
  }).brief;
  store.claimNextMorningBrief();
  store.completeMorningBrief(artifact.id, JSON.stringify({
    headline: 'Focus.', narrativeParagraphs: ['Work.'], lensNarrative: 'Focus.\n\nWork.',
    existingTaskCandidates: [], watchItems: [],
    boardActions: [
      {
        op: 'retitle', taskId: 'task-empty-expected', title: 'Do not apply', why: 'Clarify.',
        evidenceRefs: [], expectedTaskUpdatedAt: '',
      },
      {
        op: 'retitle', taskId: 'task-null-live', title: 'Also do not apply', why: 'Clarify.',
        evidenceRefs: [], expectedTaskUpdatedAt: '2026-07-10T15:00:00.000Z',
      },
    ],
  }));
  store.stageMorningBriefBoardActions(artifact.id);

  const result = store.activateBriefBoardActions('2026-07-10');
  assert.deepEqual(result, {
    activated: true,
    artifactId: artifact.id,
    applied: 0,
    skippedConflict: 2,
    skippedOfflimits: 0,
  });
  assert.deepEqual(
    db.prepare('SELECT title FROM tasks ORDER BY position').pluck().all(),
    ['Keep empty expected', 'Keep null live'],
  );
  assert.deepEqual(
    db.prepare('SELECT state FROM day_plan_brief_actions ORDER BY action_index').pluck().all(),
    ['skipped_conflict', 'skipped_conflict'],
  );
  assert.equal(store.morningBriefManagementSummary(artifact.id), undefined);
  db.close();
});

test('activation rejects unsafe stored due dates and an empty sanitized title', (t) => {
  const { file, store } = isolatedStore(t);
  const db = new Database(file);
  createManagedBoardTables(db);
  const snapshotAt = '2026-07-10T15:00:00.000Z';
  const insert = db.prepare(
    `INSERT INTO tasks
      (id, column_id, title, description, priority, tags, position, status, updated_at)
     VALUES (?, 'col-ns', ?, '', 'medium', '[]', ?, 'open', ?)`,
  );
  insert.run('task-bad-date', 'Keep malformed due', 0, snapshotAt);
  insert.run('task-far-date', 'Keep out-of-range due', 1, snapshotAt);
  insert.run('task-empty-title', 'Keep real title', 2, snapshotAt);

  const artifact = store.enqueueMorningBrief('2026-07-10', {
    modelAlias: 'opus', effort: 'high', budgetUsd: 1.5,
  }).brief;
  store.claimNextMorningBrief();
  store.completeMorningBrief(artifact.id, JSON.stringify({
    headline: 'Focus.', narrativeParagraphs: ['Work.'], lensNarrative: 'Focus.\n\nWork.',
    existingTaskCandidates: [], watchItems: [],
    boardActions: [
      {
        op: 'set_due', taskId: 'task-bad-date', dueLocalDate: 'not-a-date', why: 'Deadline.',
        evidenceRefs: ['calendar'], expectedTaskUpdatedAt: snapshotAt,
      },
      {
        op: 'set_due', taskId: 'task-far-date', dueLocalDate: '2037-01-01', why: 'Deadline.',
        evidenceRefs: ['calendar'], expectedTaskUpdatedAt: snapshotAt,
      },
      {
        op: 'retitle', taskId: 'task-empty-title', title: '\u0000\u0007\n\t\u007f',
        why: 'Clarify.', evidenceRefs: [], expectedTaskUpdatedAt: snapshotAt,
      },
    ],
  }));
  store.stageMorningBriefBoardActions(artifact.id);

  assert.deepEqual(store.activateBriefBoardActions('2026-07-10'), {
    activated: true,
    artifactId: artifact.id,
    applied: 0,
    skippedConflict: 0,
    skippedOfflimits: 3,
  });
  assert.deepEqual(
    db.prepare('SELECT title, due_at, due_date FROM tasks ORDER BY position').all(),
    [
      { title: 'Keep malformed due', due_at: null, due_date: null },
      { title: 'Keep out-of-range due', due_at: null, due_date: null },
      { title: 'Keep real title', due_at: null, due_date: null },
    ],
  );
  assert.deepEqual(
    db.prepare('SELECT state FROM day_plan_brief_actions ORDER BY action_index').pluck().all(),
    ['skipped_offlimits', 'skipped_offlimits', 'skipped_offlimits'],
  );
  db.close();
});

test('activation clamps relay text and bounds full before and after receipt snapshots', (t) => {
  const { file, store } = isolatedStore(t);
  const db = new Database(file);
  createManagedBoardTables(db);
  const snapshotAt = '2026-07-10T15:00:00.000Z';
  db.prepare(
    `INSERT INTO tasks
      (id, column_id, title, description, priority, tags, project, position, status, updated_at)
     VALUES ('task-large', 'col-ns', 'Original', ?, 'medium', ?, ?, 0, 'open', ?)`,
  ).run('b'.repeat(10_000), 'tag'.repeat(4_000), 'project'.repeat(2_000), snapshotAt);
  const unsafeTitle = `Clear\u0000\u0007title\n${'t'.repeat(300)}`;
  const unsafeDescription = `Useful\u0000\u001fdescription\n\t${'d'.repeat(5_000)}`;
  const boardActions = [
    {
      op: 'retitle', taskId: 'task-large', title: unsafeTitle, why: 'w'.repeat(7_000),
      evidenceRefs: [], expectedTaskUpdatedAt: snapshotAt,
    },
    ...Array.from({ length: 14 }, () => ({
      op: 'edit_description', taskId: 'task-large', description: unsafeDescription,
      why: 'w'.repeat(7_000), evidenceRefs: [], expectedTaskUpdatedAt: snapshotAt,
    })),
  ];
  const artifact = store.enqueueMorningBrief('2026-07-10', {
    modelAlias: 'opus', effort: 'high', budgetUsd: 1.5,
  }).brief;
  store.claimNextMorningBrief();
  store.completeMorningBrief(artifact.id, JSON.stringify({
    headline: 'Focus.', narrativeParagraphs: ['Work.'], lensNarrative: 'Focus.\n\nWork.',
    existingTaskCandidates: [], watchItems: [],
    boardActions,
  }));
  store.stageMorningBriefBoardActions(artifact.id);

  assert.equal(store.activateBriefBoardActions('2026-07-10').applied, 15);
  const task = db.prepare("SELECT title, description FROM tasks WHERE id = 'task-large'").get();
  assert.equal(task.title.length, 240);
  assert.equal(task.description.length, 4_000);
  assert.equal(containsAsciiControl(task.title), false);
  assert.equal(containsAsciiControl(task.description, { preserveFormatting: true }), false);
  assert.ok(task.description.includes('description\n\t'));
  const actionRows = db.prepare(
    'SELECT before_json, after_json FROM day_plan_brief_actions ORDER BY action_index',
  ).all();
  for (const row of actionRows) {
    for (const snapshot of [JSON.parse(row.before_json), JSON.parse(row.after_json)]) {
      assert.ok((snapshot.description ?? '').length <= 2_000);
      if ((snapshot.description ?? '').length === 2_000) {
        assert.ok(snapshot.description.endsWith('… [truncated]'));
      }
    }
  }
  const receiptJson = db.prepare(
    "SELECT actions_json FROM cove_receipts WHERE source = 'morning-brief-management'",
  ).pluck().get();
  assert.ok(receiptJson.length < 100_000);
  const receipt = JSON.parse(receiptJson);
  assert.equal(receipt.snapshotsOmitted, true);
  assert.equal(receipt.outcomes.length, 15);
  assert.ok(receipt.outcomes.every((outcome) =>
    outcome.before === undefined && outcome.after === undefined && outcome.why.length === 500
  ));
  db.close();
});

test('staging a replacement brief terminal-marks staged actions from older artifacts', (t) => {
  const { file, store, setClock } = isolatedStore(t, '2026-07-10T05:00:00.000Z');
  const makeBrief = (taskId) => JSON.stringify({
    headline: 'Focus.', narrativeParagraphs: ['Work.'], lensNarrative: 'Focus.\n\nWork.',
    existingTaskCandidates: [], watchItems: [],
    boardActions: [{
      op: 'set_priority', taskId, priority: 'high', why: 'Goal fit.', evidenceRefs: [],
      expectedTaskUpdatedAt: '2026-07-10T04:00:00.000Z',
    }],
  });
  const first = store.enqueueMorningBrief('2026-07-10', {
    modelAlias: 'opus', effort: 'high', budgetUsd: 1.5,
  }).brief;
  store.claimNextMorningBrief();
  store.completeMorningBrief(first.id, makeBrief('task-first'));
  store.stageMorningBriefBoardActions(first.id);

  setClock('2026-07-10T06:00:00.000Z');
  const second = store.enqueueMorningBrief('2026-07-10', {
    modelAlias: 'opus', effort: 'high', budgetUsd: 1.5,
  }).brief;
  store.claimNextMorningBrief();
  store.completeMorningBrief(second.id, makeBrief('task-second'));
  store.stageMorningBriefBoardActions(second.id);

  const db = new Database(file);
  const rows = db.prepare(
    'SELECT artifact_id, state, terminal_at FROM day_plan_brief_actions',
  ).all();
  assert.deepEqual(rows.find((row) => row.artifact_id === first.id), {
    artifact_id: first.id,
    state: 'skipped_late',
    terminal_at: '2026-07-10T06:00:00.000Z',
  });
  assert.deepEqual(rows.find((row) => row.artifact_id === second.id), {
    artifact_id: second.id,
    state: 'staged',
    terminal_at: null,
  });
  assert.equal(store.getMorningBrief(first.id).boardActionsPending, undefined);
  assert.equal(store.getMorningBrief(second.id).boardActionsPending, true);
  db.close();
});

test('staging an older artifact preserves the newer actions and leaves the GET pre-check idle', (t) => {
  const { file, store, setClock } = isolatedStore(t, '2026-07-10T05:00:00.000Z');
  const makeBrief = (taskId) => JSON.stringify({
    headline: 'Focus.', narrativeParagraphs: ['Work.'], lensNarrative: 'Focus.\n\nWork.',
    existingTaskCandidates: [], watchItems: [],
    boardActions: [{
      op: 'set_priority', taskId, priority: 'high', why: 'Goal fit.', evidenceRefs: [],
      expectedTaskUpdatedAt: '2026-07-10T04:00:00.000Z',
    }],
  });
  const older = store.enqueueMorningBrief('2026-07-10', {
    modelAlias: 'opus', effort: 'high', budgetUsd: 1.5,
  }).brief;
  store.claimNextMorningBrief();
  store.completeMorningBrief(older.id, makeBrief('task-older'));

  setClock('2026-07-10T06:00:00.000Z');
  const newer = store.enqueueMorningBrief('2026-07-10', {
    modelAlias: 'opus', effort: 'high', budgetUsd: 1.5,
  }).brief;
  store.claimNextMorningBrief();
  store.completeMorningBrief(newer.id, makeBrief('task-newer'));
  store.stageMorningBriefBoardActions(newer.id);
  store.stageMorningBriefBoardActions(older.id);

  const db = new Database(file);
  createManagedBoardTables(db);
  db.prepare(
    `INSERT INTO tasks
      (id, column_id, title, description, priority, tags, position, status, updated_at)
     VALUES ('task-newer', 'col-ns', 'Winning task', '', 'medium', '[]', 0, 'open', ?)`,
  ).run('2026-07-10T04:00:00.000Z');
  const staged = db.prepare(
    'SELECT artifact_id, state, terminal_at FROM day_plan_brief_actions',
  ).all();
  assert.deepEqual(staged.find((row) => row.artifact_id === older.id), {
    artifact_id: older.id,
    state: 'skipped_late',
    terminal_at: '2026-07-10T06:00:00.000Z',
  });
  assert.deepEqual(staged.find((row) => row.artifact_id === newer.id), {
    artifact_id: newer.id,
    state: 'staged',
    terminal_at: null,
  });

  setClock('2026-07-10T16:00:00.000Z');
  assert.equal(store.activateBriefBoardActions('2026-07-10').artifactId, newer.id);
  assert.equal(db.prepare("SELECT priority FROM tasks WHERE id = 'task-newer'").pluck().get(), 'high');
  assert.deepEqual(
    db.prepare('SELECT state FROM day_plan_brief_actions ORDER BY artifact_id').pluck().all().sort(),
    ['applied', 'skipped_late'],
  );

  // This mirrors an idle GET initialize: the read-only pre-check must not request a write lock.
  db.exec('BEGIN IMMEDIATE');
  assert.doesNotThrow(() => store.initialize());
  db.exec('ROLLBACK');
  db.close();
});

test('brief task creation treats a title finished two days ago as a conflict', (t) => {
  const { file, store } = isolatedStore(t, '2026-07-10T16:00:00.000Z');
  const db = new Database(file);
  createManagedBoardTables(db);
  db.prepare(
    `INSERT INTO tasks
      (id, column_id, title, description, priority, tags, position, status, created_at, updated_at)
     VALUES ('done-agreement', 'col-ns', ?, '', 'medium', '[]', 0, 'done', ?, ?)`,
  ).run(
    "Review Asher's founders agreement",
    '2026-07-01T16:00:00.000Z',
    '2026-07-08T16:00:00.000Z',
  );
  const queued = store.enqueueMorningBrief('2026-07-10', {
    modelAlias: 'opus', effort: 'high', budgetUsd: 1.5,
  }).brief;
  store.claimNextMorningBrief();
  const completed = store.completeMorningBrief(queued.id, JSON.stringify({
    headline: 'Focus.',
    narrativeParagraphs: ['Review the agreement.'],
    lensNarrative: 'Focus.\n\nReview the agreement.',
    existingTaskCandidates: [],
    watchItems: [],
    boardActions: [{
      op: 'create_task',
      title: "review asher's founders agreement",
      description: 'Already finished this week, so no new card.',
      priority: 'high',
      dueLocalDate: '2026-07-10',
      why: 'Duplicate of finished work.',
      evidenceRefs: ['sprint_memo:asher'],
    }],
  }));
  assert.ok(completed);
  assert.equal(store.stageMorningBriefBoardActions(completed.id), 1);
  assert.deepEqual(store.activateBriefBoardActions('2026-07-10'), {
    activated: true,
    artifactId: completed.id,
    applied: 0,
    skippedConflict: 1,
    skippedOfflimits: 0,
  });
  assert.equal(db.prepare('SELECT COUNT(*) FROM tasks').pluck().get(), 1);
  const actionRow = db.prepare(
    'SELECT state, after_json FROM day_plan_brief_actions WHERE artifact_id = ?',
  ).get(completed.id);
  assert.equal(actionRow.state, 'skipped_conflict');
  const resolved = JSON.parse(actionRow.after_json);
  assert.equal(resolved.id, 'done-agreement');
  assert.equal(resolved.status, 'done');
  // A finished task blocks the duplicate but never becomes a Today pick.
  assert.deepEqual(store.morningBriefCreatedTaskPicks(completed.id), []);
  db.close();
});

test('mid-day brief review and bypass preserve completed, pending and confirmed choices', (t) => {
  const { store, file } = isolatedStore(t);
  const backing = new Database(file);
  backing.prepare("INSERT INTO tasks(id,title,description,priority,tags,status,column_id,position,created_at,updated_at) VALUES('task-a','Task task-a','Finish task-a','high','[]','open','col-today',0,'2026-07-10T15:00:00.000Z','2026-07-10T15:00:00.000Z')").run();
  backing.close();
  let plan = ensure(store).plan;
  plan = mutate(store, plan, 'arrival_open').plan;
  plan = mutate(store, plan, 'start_day').plan;
  plan = mutate(store, plan, 'item_complete', { itemId: plan.items[0].id }).plan;
  // Historical/current plan can retain unaccepted work beyond its focus band.
  const pending = plan.items.find(item => item.decision === 'accepted');
  pending.decision = 'pending';
  const db = new Database(file);
  db.prepare('UPDATE day_plans SET items_json=? WHERE id=?').run(JSON.stringify(plan.items), plan.id);
  db.close();
  const before = structuredClone(plan);
  plan = mutate(store, plan, 'arrival_reopen').plan;
  assert.equal(plan.state, 'active');
  assert.equal(plan.confirmedAt, before.confirmedAt);
  assert.equal(plan.recommendedFirstItemId, before.recommendedFirstItemId);
  assert.deepEqual(plan.items, before.items);
  plan = mutate(store, plan, 'arrival_bypass').plan;
  assert.equal(plan.state, 'active');
  assert.equal(plan.confirmedAt, before.confirmedAt);
  assert.deepEqual(plan.items, before.items);
  plan = mutate(store, plan, 'arrival_reopen').plan;
  const result = mutate(store, plan, 'start_day');
  assert.equal(result.plan.arrivalState, 'confirmed');
  assert.deepEqual(result.plan.items, before.items);
  assert.equal((result.executionRuns ?? []).length, 0);
});
