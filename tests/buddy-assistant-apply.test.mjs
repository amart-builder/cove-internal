import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import {
  POST,
  deterministicCreateId,
} from '../src/app/api/day-plan/assistant-apply/implementation.ts';
import {
  BUDDY_STORE_API_VERSION,
  createBuddyStore,
} from '../src/lib/buddy/store.ts';
import { buildDayPlanCandidates } from '../src/lib/day-plan/candidates.ts';
import {
  DayPlanInvalidTransition,
  DayPlanVersionConflict,
  createDayPlanStore,
} from '../src/lib/day-plan/store.ts';
import { getQuietCurrentCsrfToken } from '../src/lib/quiet-current/store.ts';
import { getEvent } from '../src/lib/intake/inbox.ts';

function setupAssistantApply(t) {
  const root = path.join(os.tmpdir(), `cove-buddy-atomicity-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(root, { recursive: true });
  const dbPath = path.join(root, 'cove.db');
  const boardDb = new Database(dbPath);
  boardDb.exec(`
    CREATE TABLE task_columns (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, column_id TEXT, title TEXT NOT NULL, description TEXT,
      priority TEXT, due_at TEXT, due_date TEXT, tags TEXT, project TEXT,
      position REAL, status TEXT, archived_at TEXT, archived_from_status TEXT,
      recurring_template_id TEXT, occurrence_local_date TEXT,
      created_at TEXT, updated_at TEXT
    );
    INSERT INTO task_columns (id, name, position) VALUES
      ('col-ns', 'Not Started', 0),
      ('col-today', 'Must happen today', 10),
      ('col-done', 'Done', 20);
  `);
  boardDb.close();
  const store = createDayPlanStore({
    dbPath,
    now: () => new Date('2026-07-15T16:00:00.000Z'),
  });
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  let plan = store.ensureDayPlan({
    localDate: '2026-07-15',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:buddy-atomicity',
    candidates: buildDayPlanCandidates({
      localDate: '2026-07-15',
      timezone: 'America/Los_Angeles',
      tasks: ['a', 'b'].map((id, position) => ({
        id: `task-${id}`,
        title: `Task ${id}`,
        description: `Original outcome ${id}`,
        priority: position === 0 ? 'high' : 'medium',
        position,
        column: 'today',
        status: 'open',
        updatedAt: '2026-07-15T15:00:00.000Z',
        refreshedAt: '2026-07-15T16:00:00.000Z',
      })),
    }),
  }).plan;
  plan = store.mutateDayPlan({
    planId: plan.id,
    expectedVersion: plan.version,
    mutationId: 'arrival-open:buddy-atomicity',
    action: 'arrival_open',
  }).plan;
  return { root, store, plan };
}

test('assistant-apply enforces access and CSRF, applies valid ops, and returns conflicts', async (t) => {
  const root = path.join(os.tmpdir(), `cove-buddy-apply-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const store = createDayPlanStore({ dbPath: path.join(root, 'cove.db') });
  const previousStore = globalThis.__coveDayPlanStore;
  const previousMode = process.env.COVE_DAY_PLAN_ACCESS_MODE;
  const previousQuietFile = process.env.COVE_QUIET_CURRENT_FILE;
  const quietFile = `buddy-apply-${process.pid}-${Date.now()}.json`;
  globalThis.__coveDayPlanStore = store;
  process.env.COVE_DAY_PLAN_ACCESS_MODE = 'loopback';
  process.env.COVE_QUIET_CURRENT_FILE = quietFile;
  t.after(() => {
    if (previousStore === undefined) delete globalThis.__coveDayPlanStore;
    else globalThis.__coveDayPlanStore = previousStore;
    if (previousMode === undefined) delete process.env.COVE_DAY_PLAN_ACCESS_MODE;
    else process.env.COVE_DAY_PLAN_ACCESS_MODE = previousMode;
    if (previousQuietFile === undefined) delete process.env.COVE_QUIET_CURRENT_FILE;
    else process.env.COVE_QUIET_CURRENT_FILE = previousQuietFile;
    store.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(path.join(process.cwd(), 'data', quietFile), { force: true });
    rmSync(path.join(process.cwd(), 'data', `${quietFile}.token`), { force: true });
  });

  const untrusted = await POST(new NextRequest('http://evil.example/api/day-plan/assistant-apply', {
    method: 'POST', headers: { host: 'evil.example', origin: 'http://evil.example' }, body: '{}',
  }));
  assert.equal(untrusted.status, 403);
  const missingCsrf = await POST(new NextRequest('http://localhost:3200/api/day-plan/assistant-apply', {
    method: 'POST', headers: { host: 'localhost:3200', origin: 'http://localhost:3200' }, body: '{}',
  }));
  assert.equal(missingCsrf.status, 403);

  let plan = store.ensureDayPlan({
    localDate: '2026-07-15', timezone: 'America/Los_Angeles', mutationId: 'ensure:buddy-apply',
    candidates: buildDayPlanCandidates({
      localDate: '2026-07-15', timezone: 'America/Los_Angeles',
      tasks: [{
        id: 'task-a', title: 'Write proposal', description: 'Finish the proposal.', priority: 'high',
        position: 0, column: 'today', status: 'open', updatedAt: '2026-07-15T15:00:00.000Z',
        refreshedAt: '2026-07-15T16:00:00.000Z',
      }],
    }),
  }).plan;
  plan = store.mutateDayPlan({
    planId: plan.id, expectedVersion: plan.version, mutationId: 'open:buddy-apply', action: 'arrival_open',
  }).plan;
  const body = {
    expectedVersion: plan.version,
    operations: [{ operation: 'set_owner', itemId: plan.items[0].id, owner: 'claude' }],
  };
  const request = () => new NextRequest('http://localhost:3200/api/day-plan/assistant-apply', {
    method: 'POST',
    headers: {
      host: 'localhost:3200', origin: 'http://localhost:3200', 'content-type': 'application/json',
      'x-cove-csrf': getQuietCurrentCsrfToken(),
    },
    body: JSON.stringify(body),
  });
  const applied = await POST(request());
  assert.equal(applied.status, 200);
  const appliedBody = await applied.json();
  assert.equal(appliedBody.plan.version, plan.version + 1);
  assert.equal(appliedBody.plan.items[0].owner, 'claude');
  assert.deepEqual(appliedBody.changes[0], {
    table: 'day_plan', action: 'update', id: plan.items[0].id,
    summary: "Assigned 'Write proposal' to Claude",
  });

  const conflict = await POST(request());
  assert.equal(conflict.status, 409);
  const conflictBody = await conflict.json();
  assert.equal(conflictBody.error, 'version_conflict');
  assert.equal(conflictBody.currentPlan.version, plan.version + 1);

  const originalApply = store.applyAssistantOperations;
  const originalConsoleError = console.error;
  store.applyAssistantOperations = () => { throw new Error('sqlite write failed'); };
  console.error = () => {};
  const failed = await POST(request());
  store.applyAssistantOperations = originalApply;
  console.error = originalConsoleError;
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: 'Assistant apply failed.' });
});

test('assistant apply creates, completes, updates, and reprioritizes task-backed work atomically', (t) => {
  const { root, store, plan } = setupAssistantApply(t);
  const completedItem = plan.items[0];
  const retainedItem = plan.items[1];

  const result = store.applyAssistantOperations({
    expectedVersion: plan.version,
    operations: [
      { operation: 'complete_item', itemId: completedItem.id },
      {
        operation: 'create_item',
        clientId: 'beacon',
        title: 'Finish the Beacon content generator',
        outcome: 'Finish the Twitter, LinkedIn, and newsletter generators; make the newsletter ready for client use.',
        definitionOfDone: 'All three generators work and the newsletter flow is client-ready.',
        project: 'beacon',
        priority: 'high',
        position: 0,
      },
      {
        operation: 'create_item',
        clientId: 'client-days',
        title: 'Standardize client call days',
        outcome: 'Decide whether Tuesday and Wednesday should be client days and create suitable Calendly links.',
        position: 1,
      },
      {
        operation: 'edit_item',
        itemId: retainedItem.id,
        title: 'Schedule client call days',
        position: 2,
      },
    ],
  });

  assert.equal(result.plan.version, plan.version + 1);
  assert.deepEqual(
    result.plan.items.filter((item) => item.decision !== 'completed').map((item) => item.title),
    ['Finish the Beacon content generator', 'Standardize client call days', 'Schedule client call days'],
  );
  assert.equal(result.plan.items.find((item) => item.id === completedItem.id).decision, 'completed');
  const mutations = store.listPendingTaskMutations();
  assert.deepEqual(mutations.map((mutation) => mutation.action), ['complete', 'update']);
  assert.equal(result.createdItemIds.length, 2);
  const verify = new Database(path.join(root, 'cove.db'), { readonly: true });
  const createdTasks = verify.prepare(
    `SELECT id, column_id, status FROM tasks
     WHERE id IN (?, ?) ORDER BY id`,
  ).all(...result.createdItemIds);
  verify.close();
  assert.equal(createdTasks.length, 2);
  assert.equal(createdTasks.every((task) => task.column_id === 'col-today'), true);
  assert.equal(createdTasks.every((task) => task.status === 'open'), true);
  assert.equal(
    result.plan.items
      .filter((item) => result.createdItemIds.includes(item.id))
      .every((item) => item.sourceRefs.some(
        (source) => source.sourceType === 'task' && source.recordId === item.taskId,
      )),
    true,
  );
  assert.equal(
    mutations.some((mutation) => result.createdItemIds.includes(mutation.taskId)),
    false,
    'new work enters through inbound_events instead of the legacy task mutation writer',
  );
  assert.equal(result.turn.state, 'applied');

  const active = store.mutateDayPlan({
    planId: result.plan.id,
    expectedVersion: result.plan.version,
    mutationId: 'start:active-replan',
    action: 'start_day',
  }).plan;
  assert.throws(
    () => store.applyAssistantOperations({
      expectedVersion: active.version,
      operations: [{
        operation: 'set_owner',
        itemId: retainedItem.id,
        owner: 'together',
      }],
    }),
    (error) =>
      error instanceof DayPlanInvalidTransition &&
      error.message === 'Arrival items can change only while arrival is open.',
  );
});

test('assistant create_item rolls back both the plan item and task when the transaction fails', (t) => {
  const { root, store, plan } = setupAssistantApply(t);
  const dbPath = path.join(root, 'cove.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TRIGGER fail_assistant_plan_event
    BEFORE INSERT ON day_plan_events
    WHEN NEW.event_type = 'assistant_patch'
    BEGIN
      SELECT RAISE(ABORT, 'forced assistant transaction failure');
    END;
  `);
  db.close();

  assert.throws(
    () => store.applyAssistantOperations({
      expectedVersion: plan.version,
      createdItemIds: ['atomic-create-id'],
      operations: [{
        operation: 'create_item',
        clientId: 'atomic-create',
        title: 'Atomic new work',
        outcome: 'Both records exist or neither record exists.',
        position: 0,
      }],
    }),
    /forced assistant transaction failure/,
  );

  assert.equal(store.getPlan(plan.id).items.some((item) => item.id === 'atomic-create-id'), false);
  const verify = new Database(dbPath, { readonly: true });
  assert.equal(
    verify.prepare("SELECT COUNT(*) FROM tasks WHERE id = 'atomic-create-id'").pluck().get(),
    0,
  );
  verify.close();
});

test('active-plan apply requires an exact finished Buddy preview and consumes it once', async (t) => {
  const { root, store, plan: arrivalPlan } = setupAssistantApply(t);
  const dbPath = path.join(root, 'cove.db');
  const buddyStore = createBuddyStore({ dbPath });
  let plan = store.mutateDayPlan({
    planId: arrivalPlan.id,
    expectedVersion: arrivalPlan.version,
    mutationId: 'start:proof-required',
    action: 'start_day',
  }).plan;
  const operations = [{
    operation: 'set_owner',
    itemId: plan.items[0].id,
    owner: 'together',
  }];
  const proposedReceipts = {
    changes: [],
    pendingDeletes: [],
    replan: {
      status: 'proposed',
      expectedVersion: plan.version,
      assistantText: 'I can move this to Together.',
      operations,
      preview: [],
    },
  };
  const turn = buddyStore.claimTurn({
    userText: 'reshuffle my afternoon',
    pageContext: { view: 'today' },
    model: 'sonnet',
    effort: 'medium',
    routerReason: 'Day replan preview',
  });
  buddyStore.finishTurn(turn.id, {
    state: 'succeeded',
    assistant_text: proposedReceipts.replan.assistantText,
    receipts_json: JSON.stringify(proposedReceipts),
  });

  const previousDayStore = globalThis.__coveDayPlanStore;
  const previousBuddyStore = globalThis.__coveBuddyStore;
  const previousBuddyVersion = globalThis.__coveBuddyStoreVersion;
  const previousRuntime = process.env.NEXT_PUBLIC_COVE_RUNTIME;
  const previousMode = process.env.COVE_DAY_PLAN_ACCESS_MODE;
  const previousQuietFile = process.env.COVE_QUIET_CURRENT_FILE;
  const quietFile = `buddy-proof-${process.pid}-${Date.now()}.json`;
  globalThis.__coveDayPlanStore = store;
  globalThis.__coveBuddyStore = buddyStore;
  globalThis.__coveBuddyStoreVersion = BUDDY_STORE_API_VERSION;
  process.env.NEXT_PUBLIC_COVE_RUNTIME = 'local';
  process.env.COVE_DAY_PLAN_ACCESS_MODE = 'loopback';
  process.env.COVE_QUIET_CURRENT_FILE = quietFile;
  t.after(() => {
    if (previousDayStore === undefined) delete globalThis.__coveDayPlanStore;
    else globalThis.__coveDayPlanStore = previousDayStore;
    if (previousBuddyStore === undefined) delete globalThis.__coveBuddyStore;
    else globalThis.__coveBuddyStore = previousBuddyStore;
    if (previousBuddyVersion === undefined) delete globalThis.__coveBuddyStoreVersion;
    else globalThis.__coveBuddyStoreVersion = previousBuddyVersion;
    if (previousRuntime === undefined) delete process.env.NEXT_PUBLIC_COVE_RUNTIME;
    else process.env.NEXT_PUBLIC_COVE_RUNTIME = previousRuntime;
    if (previousMode === undefined) delete process.env.COVE_DAY_PLAN_ACCESS_MODE;
    else process.env.COVE_DAY_PLAN_ACCESS_MODE = previousMode;
    if (previousQuietFile === undefined) delete process.env.COVE_QUIET_CURRENT_FILE;
    else process.env.COVE_QUIET_CURRENT_FILE = previousQuietFile;
    buddyStore.close();
    rmSync(path.join(process.cwd(), 'data', quietFile), { force: true });
    rmSync(path.join(process.cwd(), 'data', `${quietFile}.token`), { force: true });
  });

  const request = (extraHeaders = {}, bodyOperations = operations) =>
    new NextRequest('http://localhost:3200/api/day-plan/assistant-apply', {
      method: 'POST',
      headers: {
        host: 'localhost:3200',
        origin: 'http://localhost:3200',
        'content-type': 'application/json',
        'x-cove-csrf': getQuietCurrentCsrfToken(),
        ...extraHeaders,
      },
      body: JSON.stringify({
        expectedVersion: plan.version,
        operations: bodyOperations,
      }),
    });

  const toolPath = await POST(request());
  assert.equal(toolPath.status, 400);
  assert.deepEqual(await toolPath.json(), {
    error: 'Arrival items can change only while arrival is open.',
  });
  assert.equal(store.getPlan(plan.id).version, plan.version);

  process.env.NEXT_PUBLIC_COVE_RUNTIME = 'supabase';
  const nonLocal = await POST(request({ 'x-cove-buddy-turn': turn.id }));
  assert.equal(nonLocal.status, 400);
  assert.deepEqual(await nonLocal.json(), {
    error: 'Arrival items can change only while arrival is open.',
  });
  process.env.NEXT_PUBLIC_COVE_RUNTIME = 'local';

  const mismatch = await POST(request(
    { 'x-cove-buddy-turn': turn.id },
    [{ ...operations[0], owner: 'claude' }],
  ));
  assert.equal(mismatch.status, 400);
  assert.equal(
    JSON.parse(buddyStore.getTurn(turn.id).receipts_json).replan.status,
    'proposed',
  );

  const applied = await POST(request({ 'x-cove-buddy-turn': turn.id }));
  assert.equal(applied.status, 200);
  const appliedBody = await applied.json();
  assert.equal(appliedBody.plan.state, 'active');
  assert.equal(appliedBody.plan.items[0].owner, 'together');
  assert.equal(appliedBody.receipts.replan.status, 'applied');
  assert.equal(
    JSON.parse(buddyStore.getTurn(turn.id).receipts_json).replan.status,
    'applied',
  );

  const replay = await POST(request({ 'x-cove-buddy-turn': turn.id }));
  assert.equal(replay.status, 409);
});

test('a mid-day created item is accepted and survives settlement', (t) => {
  const { root, store, plan: arrivalPlan } = setupAssistantApply(t);
  const buddyStore = createBuddyStore({ dbPath: path.join(root, 'cove.db') });
  t.after(() => buddyStore.close());
  const previousRuntime = process.env.NEXT_PUBLIC_COVE_RUNTIME;
  process.env.NEXT_PUBLIC_COVE_RUNTIME = 'local';
  t.after(() => {
    if (previousRuntime === undefined) delete process.env.NEXT_PUBLIC_COVE_RUNTIME;
    else process.env.NEXT_PUBLIC_COVE_RUNTIME = previousRuntime;
  });
  let plan = store.mutateDayPlan({
    planId: arrivalPlan.id,
    expectedVersion: arrivalPlan.version,
    mutationId: 'start:midday-create',
    action: 'start_day',
  }).plan;
  const operations = [{
    operation: 'create_item',
    clientId: 'urgent-follow-up',
    title: 'Handle the urgent follow-up',
    outcome: 'Resolve the new client issue today.',
    position: 0,
  }];
  const proposed = {
    changes: [],
    pendingDeletes: [],
    replan: {
      status: 'proposed',
      expectedVersion: plan.version,
      assistantText: 'I can add the urgent follow-up.',
      operations,
      preview: [],
    },
  };
  const applied = {
    ...proposed,
    changes: [{
      table: 'day_plan',
      action: 'insert',
      id: 'urgent-created-id',
      summary: "Added 'Handle the urgent follow-up' to today",
    }],
    replan: {
      ...proposed.replan,
      status: 'applied',
      appliedChanges: [{
        table: 'day_plan',
        action: 'insert',
        id: 'urgent-created-id',
        summary: "Added 'Handle the urgent follow-up' to today",
      }],
    },
  };
  const turn = buddyStore.claimTurn({
    userText: 'new urgent thing, reshuffle my afternoon',
    pageContext: { view: 'today' },
    model: 'sonnet',
    effort: 'medium',
    routerReason: 'Day replan preview',
  });
  buddyStore.finishTurn(turn.id, {
    state: 'succeeded',
    assistant_text: proposed.replan.assistantText,
    receipts_json: JSON.stringify(proposed),
  });
  plan = store.applyAssistantOperations({
    expectedVersion: plan.version,
    operations,
    createdItemIds: ['urgent-created-id'],
    replanReceiptProof: {
      turnId: turn.id,
      expectedReceiptsJson: JSON.stringify(proposed),
      appliedReceiptsJson: JSON.stringify(applied),
    },
  }).plan;
  const created = plan.items.find((item) => item.id === 'urgent-created-id');
  assert.equal(created.decision, 'accepted');
  assert.equal(created.whyToday, 'Added during a mid-day replan.');

  const originalTaskIds = plan.items
    .filter((item) => item.id !== created.id)
    .map((item) => item.taskId);
  plan = store.mutateDayPlan({
    planId: plan.id,
    expectedVersion: plan.version,
    mutationId: 'settlement-start:midday-create',
    action: 'settlement_start',
    completedHumanTaskIds: originalTaskIds,
  }).plan;
  plan = store.mutateDayPlan({
    planId: plan.id,
    expectedVersion: plan.version,
    mutationId: 'settlement-decide:midday-create',
    action: 'settlement_decide',
    itemId: created.id,
    disposition: 'carry',
  }).plan;
  const committed = store.mutateDayPlan({
    planId: plan.id,
    expectedVersion: plan.version,
    mutationId: 'settlement-commit:midday-create',
    action: 'settlement_commit',
    completedHumanTaskIds: originalTaskIds,
  });
  assert.equal(
    committed.snapshot.body.unresolvedItems.some(
      (item) => item.dayPlanItemId === created.id && item.disposition === 'carry',
    ),
    true,
  );
});

test('assistant create_item records the deterministic plan item in inbound_events', async (t) => {
  const { root, store, plan } = setupAssistantApply(t);
  const previousStore = globalThis.__coveDayPlanStore;
  const previousDb = globalThis.__coveDb;
  const previousDbPath = process.env.COVE_DB_PATH;
  const previousRuntime = process.env.NEXT_PUBLIC_COVE_RUNTIME;
  const previousMode = process.env.COVE_DAY_PLAN_ACCESS_MODE;
  const previousQuietFile = process.env.COVE_QUIET_CURRENT_FILE;
  const inboxPath = path.join(root, 'inbox.db');
  const quietFile = `buddy-intake-${process.pid}-${Date.now()}.json`;
  globalThis.__coveDayPlanStore = store;
  delete globalThis.__coveDb;
  process.env.COVE_DB_PATH = inboxPath;
  process.env.NEXT_PUBLIC_COVE_RUNTIME = 'local';
  process.env.COVE_DAY_PLAN_ACCESS_MODE = 'loopback';
  process.env.COVE_QUIET_CURRENT_FILE = quietFile;
  const previousFetch = globalThis.fetch;
  const tasks = new Map();
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    if (value.includes('/api/cove-rest/tasks?')) {
      const id = new URL(value).searchParams.get('id')?.replace(/^eq\./, '');
      return new Response(JSON.stringify(id && tasks.has(id) ? [tasks.get(id)] : []));
    }
    if (value.includes('/api/cove-rest/task_columns')) {
      return new Response(JSON.stringify([
        { id: 'not-started', name: 'Not Started', position: 0 },
        { id: 'today', name: 'Must happen today', position: 1 },
      ]));
    }
    if (value.endsWith('/api/day-plan')) {
      return new Response('{"csrfToken":"task-writer-token"}');
    }
    if (value.endsWith('/api/cove-rest/tasks') && init.method === 'POST') {
      const task = JSON.parse(init.body);
      tasks.set(task.id, task);
      return new Response(JSON.stringify([task]), { status: 201 });
    }
    throw new Error(`Unexpected task-writer request: ${value}`);
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.__coveDb?.close();
    if (previousDb === undefined) delete globalThis.__coveDb;
    else globalThis.__coveDb = previousDb;
    if (previousStore === undefined) delete globalThis.__coveDayPlanStore;
    else globalThis.__coveDayPlanStore = previousStore;
    if (previousDbPath === undefined) delete process.env.COVE_DB_PATH;
    else process.env.COVE_DB_PATH = previousDbPath;
    if (previousRuntime === undefined) delete process.env.NEXT_PUBLIC_COVE_RUNTIME;
    else process.env.NEXT_PUBLIC_COVE_RUNTIME = previousRuntime;
    if (previousMode === undefined) delete process.env.COVE_DAY_PLAN_ACCESS_MODE;
    else process.env.COVE_DAY_PLAN_ACCESS_MODE = previousMode;
    if (previousQuietFile === undefined) delete process.env.COVE_QUIET_CURRENT_FILE;
    else process.env.COVE_QUIET_CURRENT_FILE = previousQuietFile;
    rmSync(path.join(process.cwd(), 'data', quietFile), { force: true });
    rmSync(path.join(process.cwd(), 'data', `${quietFile}.token`), { force: true });
  });
  const response = await POST(new NextRequest(
    'http://localhost:3200/api/day-plan/assistant-apply',
    {
      method: 'POST',
      headers: {
        host: 'localhost:3200',
        origin: 'http://localhost:3200',
        'content-type': 'application/json',
        'x-cove-csrf': getQuietCurrentCsrfToken(),
      },
      body: JSON.stringify({
        expectedVersion: plan.version,
        operations: [{
          operation: 'create_item',
          clientId: 'capture-one',
          title: 'Prepare the client kickoff',
          outcome: 'Make the kickoff ready for Jordan Rivers to review.',
          project: 'cove',
          priority: 'high',
          position: 0,
        }],
      }),
    },
  ));
  assert.equal(response.status, 200);
  const body = await response.json();
  const createdId = body.changes[0].id;
  const event = await getEvent(createdId);
  assert.equal(event.id, createdId);
  assert.equal(event.source, 'day-plan');
  assert.equal(event.state, 'triaged');
  assert.equal(event.task_id, createdId);
  assert.match(event.raw_text, /Outcome: Make the kickoff ready/);
  const taskDb = new Database(path.join(root, 'cove.db'), { readonly: true });
  const backingTask = taskDb.prepare(
    'SELECT id, column_id, title, description, priority, tags, status FROM tasks WHERE id = ?',
  ).get(createdId);
  taskDb.close();
  assert.equal(backingTask.title, 'Prepare the client kickoff');
  assert.equal(backingTask.column_id, 'col-today');
  assert.equal(backingTask.status, 'open');
  assert.deepEqual(JSON.parse(backingTask.tags), []);
  tasks.set(createdId, backingTask);
  assert.equal(store.listPendingTaskMutations().some((mutation) => mutation.action === 'create'), false);

  const editResponse = await POST(new NextRequest(
    'http://localhost:3200/api/day-plan/assistant-apply',
    {
      method: 'POST',
      headers: {
        host: 'localhost:3200',
        origin: 'http://localhost:3200',
        'content-type': 'application/json',
        'x-cove-csrf': getQuietCurrentCsrfToken(),
      },
      body: JSON.stringify({
        expectedVersion: body.plan.version,
        operations: [{
          operation: 'edit_item',
          itemId: createdId,
          title: 'Prepare the revised client kickoff',
        }],
      }),
    },
  ));
  assert.equal(editResponse.status, 200);
  const [mutation] = store.listPendingTaskMutations();
  assert.equal(mutation.action, 'update');
  assert.equal(mutation.taskId, createdId);
  assert.equal(tasks.has(mutation.taskId), true);
  Object.assign(tasks.get(mutation.taskId), {
    title: mutation.title,
    description: mutation.description,
  });
  store.acknowledgeTaskMutation(mutation.id);
  assert.equal(tasks.get(createdId).title, 'Prepare the revised client kickoff');
  assert.deepEqual(store.listPendingTaskMutations(), []);

  const editedBody = await editResponse.json();
  const completeResponse = await POST(new NextRequest(
    'http://localhost:3200/api/day-plan/assistant-apply',
    {
      method: 'POST',
      headers: {
        host: 'localhost:3200',
        origin: 'http://localhost:3200',
        'content-type': 'application/json',
        'x-cove-csrf': getQuietCurrentCsrfToken(),
      },
      body: JSON.stringify({
        expectedVersion: editedBody.plan.version,
        operations: [{
          operation: 'complete_item',
          itemId: createdId,
        }],
      }),
    },
  ));
  assert.equal(completeResponse.status, 200);
  const [completeMutation] = store.listPendingTaskMutations();
  assert.equal(completeMutation.action, 'complete');
  assert.equal(tasks.has(completeMutation.taskId), true);
  tasks.get(completeMutation.taskId).status = 'done';
  store.acknowledgeTaskMutation(completeMutation.id);
  assert.equal(tasks.get(createdId).status, 'done');
  assert.deepEqual(store.listPendingTaskMutations(), []);
});

test('assistant apply dismisses captured events when the plan write loses a race', async (t) => {
  const { root, store, plan } = setupAssistantApply(t);
  const previousStore = globalThis.__coveDayPlanStore;
  const previousDb = globalThis.__coveDb;
  const previousDbPath = process.env.COVE_DB_PATH;
  const previousRuntime = process.env.NEXT_PUBLIC_COVE_RUNTIME;
  const previousMode = process.env.COVE_DAY_PLAN_ACCESS_MODE;
  const previousQuietFile = process.env.COVE_QUIET_CURRENT_FILE;
  const quietFile = `buddy-race-${process.pid}-${Date.now()}.json`;
  globalThis.__coveDayPlanStore = store;
  delete globalThis.__coveDb;
  process.env.COVE_DB_PATH = path.join(root, 'race-inbox.db');
  process.env.NEXT_PUBLIC_COVE_RUNTIME = 'local';
  process.env.COVE_DAY_PLAN_ACCESS_MODE = 'loopback';
  process.env.COVE_QUIET_CURRENT_FILE = quietFile;
  const originalApply = store.applyAssistantOperations;
  store.applyAssistantOperations = () => {
    throw new DayPlanVersionConflict(store.getPlan(plan.id));
  };
  t.after(() => {
    store.applyAssistantOperations = originalApply;
    globalThis.__coveDb?.close();
    if (previousDb === undefined) delete globalThis.__coveDb;
    else globalThis.__coveDb = previousDb;
    if (previousStore === undefined) delete globalThis.__coveDayPlanStore;
    else globalThis.__coveDayPlanStore = previousStore;
    if (previousDbPath === undefined) delete process.env.COVE_DB_PATH;
    else process.env.COVE_DB_PATH = previousDbPath;
    if (previousRuntime === undefined) delete process.env.NEXT_PUBLIC_COVE_RUNTIME;
    else process.env.NEXT_PUBLIC_COVE_RUNTIME = previousRuntime;
    if (previousMode === undefined) delete process.env.COVE_DAY_PLAN_ACCESS_MODE;
    else process.env.COVE_DAY_PLAN_ACCESS_MODE = previousMode;
    if (previousQuietFile === undefined) delete process.env.COVE_QUIET_CURRENT_FILE;
    else process.env.COVE_QUIET_CURRENT_FILE = previousQuietFile;
    rmSync(path.join(process.cwd(), 'data', quietFile), { force: true });
    rmSync(path.join(process.cwd(), 'data', `${quietFile}.token`), { force: true });
  });
  const response = await POST(new NextRequest(
    'http://localhost:3200/api/day-plan/assistant-apply',
    {
      method: 'POST',
      headers: {
        host: 'localhost:3200',
        origin: 'http://localhost:3200',
        'content-type': 'application/json',
        'x-cove-csrf': getQuietCurrentCsrfToken(),
      },
      body: JSON.stringify({
        expectedVersion: plan.version,
        operations: [{
          operation: 'create_item',
          clientId: 'race-item',
          title: 'Do not resurrect this',
          outcome: 'This item loses the version race.',
          position: 0,
        }],
      }),
    },
  ));
  assert.equal(response.status, 409);
  const id = deterministicCreateId(plan.id, plan.version, 'race-item');
  const event = await getEvent(id);
  assert.equal(event.state, 'dismissed');
  assert.match(event.error, /day plan changed/i);
});

test('assistant apply rejects invalid operations and conflicts without mutating the plan', (t) => {
  const { store, plan } = setupAssistantApply(t);
  const beforeInvalid = JSON.stringify(store.getPlan(plan.id));
  assert.throws(
    () => store.applyAssistantOperations({
      expectedVersion: plan.version,
      operations: [{ operation: 'reorder', orderedItemIds: [plan.items[0].id] }],
    }),
    (error) => error instanceof DayPlanInvalidTransition,
  );
  assert.equal(JSON.stringify(store.getPlan(plan.id)), beforeInvalid);

  const changed = store.mutateDayPlan({
    planId: plan.id,
    expectedVersion: plan.version,
    mutationId: 'human-owner-change:buddy-atomicity',
    action: 'item_owner',
    itemId: plan.items[0].id,
    owner: 'together',
  }).plan;
  const beforeConflict = JSON.stringify(store.getPlan(plan.id));
  assert.throws(
    () => store.applyAssistantOperations({
      expectedVersion: plan.version,
      operations: [{ operation: 'set_owner', itemId: plan.items[1].id, owner: 'claude' }],
    }),
    (error) => error instanceof DayPlanVersionConflict,
  );
  assert.equal(JSON.stringify(store.getPlan(plan.id)), beforeConflict);
  assert.equal(store.getPlan(plan.id).version, changed.version);
});
