import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { buildDayPlanCandidates } from '../src/lib/day-plan/candidates.ts';
import {
  MORNING_BRIEF_PROMPT_VERSION,
  MORNING_BRIEF_SCHEMA_VERSION,
} from '../src/lib/day-plan/brief.ts';
import { createDayPlanStore } from '../src/lib/day-plan/store.ts';
import {
  assertRecurringCarryAllowed,
  GET,
  includeBriefCreatedEnsureCandidates,
  POST,
  parseDayPlanPostBody,
} from '../src/app/api/day-plan/implementation.ts';
import { hasDayPlanRouteAccess, isLoopbackCoveRequest } from '../src/lib/request-security.ts';
import { getQuietCurrentCsrfToken } from '../src/lib/quiet-current/store.ts';
import { openLocalDatabase } from '../src/lib/local/database.ts';

// Every path that falls back to coveDataDir() must land in a scratch directory,
// never in <cwd>/data: a fresh checkout's verify run must not mint a database,
// a CSRF token or relay files the setup playbook would then treat as existing.
import { mkdtempSync as isolatedMkdtemp } from 'node:fs';
const ISOLATED_DATA_DIR = isolatedMkdtemp(path.join(os.tmpdir(), 'cove-test-data-'));
process.env.COVE_DATA_DIR = ISOLATED_DATA_DIR;
delete process.env.COVE_DB_PATH;
test.after(() => rmSync(ISOLATED_DATA_DIR, { recursive: true, force: true }));

function candidate() {
  return buildDayPlanCandidates({
    localDate: '2026-07-10',
    timezone: 'America/Los_Angeles',
    tasks: [
      {
        id: 'task-a',
        title: 'Finish the proposal',
        priority: 'high',
        position: 0,
        column: 'today',
        status: 'open',
        updatedAt: '2026-07-10T15:00:00.000Z',
        refreshedAt: '2026-07-10T16:00:00.000Z',
      },
    ],
  })[0];
}

test('parses a bounded task-backed ensure request', () => {
  const parsed = parseDayPlanPostBody({
    action: 'ensure',
    localDate: '2026-07-10',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:2026-07-10',
    candidates: [candidate()],
  });
  assert.equal(parsed.action, 'ensure');
  assert.equal(parsed.input.candidates[0].taskId, 'task-a');
  assert.equal(parsed.input.creation, 'automatic');
});

test('server candidate repair inserts a just-created brief task ahead of a stale browser pool', (t) => {
  const dir = path.join(os.tmpdir(), `cove-route-brief-created-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'cove.db');
  const store = createDayPlanStore({ dbPath, now: () => new Date('2026-07-10T16:00:00.000Z') });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const db = openLocalDatabase(dbPath);
  db.exec(`
    INSERT INTO task_columns (id, name, position) VALUES ('col-today', 'Must happen today', 0);
    INSERT INTO tasks
      (id, column_id, title, description, priority, tags, project, position, status,
       created_at, updated_at)
    VALUES
      ('created-task', 'col-today', 'Review Asher agreement',
       'Read the agreement and record every clause that needs a decision.',
       'high', '[]', 'Atlas', 0, 'open',
       '2026-07-10T16:00:00.000Z', '2026-07-10T16:00:00.000Z');
  `);
  db.close();
  const artifact = store.enqueueMorningBrief('2026-07-10', {
    modelAlias: 'opus', effort: 'high', budgetUsd: 1.5,
  }).brief;
  store.claimNextMorningBrief();
  store.completeMorningBrief(artifact.id, JSON.stringify({
    headline: 'Focus.',
    narrativeParagraphs: ['Review the agreement.'],
    lensNarrative: 'Focus.\n\nReview the agreement.',
    existingTaskCandidates: [],
    watchItems: [],
    boardActions: [{
      op: 'create_task',
      title: 'Review Asher agreement',
      description: 'Read the agreement and record every clause that needs a decision.',
      priority: 'high',
      dueLocalDate: null,
      why: 'A decision is needed today.',
      evidenceRefs: ['sprint_memo:asher'],
    }],
  }));
  store.stageMorningBriefBoardActions(artifact.id);
  const actionDb = openLocalDatabase(dbPath);
  actionDb.prepare(
    `UPDATE day_plan_brief_actions
     SET state = 'applied', after_json = ?, terminal_at = ?
     WHERE artifact_id = ?`,
  ).run(
    JSON.stringify(actionDb.prepare('SELECT * FROM tasks WHERE id = ?').get('created-task')),
    '2026-07-10T16:00:00.000Z',
    artifact.id,
  );
  actionDb.close();

  const staleBrowserCandidate = candidate();
  const repaired = includeBriefCreatedEnsureCandidates(store, {
    localDate: '2026-07-10',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:repaired-created-task',
    candidates: [staleBrowserCandidate],
    creation: 'automatic',
  }, dbPath);

  assert.deepEqual(repaired.candidates.map((entry) => entry.taskId), [
    'created-task',
    staleBrowserCandidate.taskId,
  ]);
  const plan = store.ensureDayPlan(repaired).plan;
  assert.equal(plan.briefId, artifact.id);
  assert.ok(plan.items.some((item) => item.taskId === 'created-task'));
});

test('parses an honestly labeled due-backlog candidate', () => {
  const backlog = buildDayPlanCandidates({
    localDate: '2026-08-03',
    timezone: 'America/Los_Angeles',
    tasks: [{
      id: 'backlog-due',
      title: 'Evening backlog deadline',
      priority: 'medium',
      dueAt: '2026-08-04T02:00:00.000Z',
      position: 0,
      column: 'due_backlog',
      status: 'open',
      updatedAt: '2026-08-03T15:00:00.000Z',
      refreshedAt: '2026-08-03T16:00:00.000Z',
    }],
  })[0];
  const parsed = parseDayPlanPostBody({
    action: 'ensure',
    localDate: '2026-08-03',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:due-backlog',
    candidates: [backlog],
  });

  assert.equal(parsed.input.candidates[0].whyToday, 'This is due today and still open.');
  assert.ok(parsed.input.candidates[0].rankReasons.includes('due_backlog'));
  assert.equal(parsed.input.candidates[0].rankReasons.includes('accepted_today'), false);
});

// The regression that stranded the 2026-08-05 brief: the brief picked an open
// backlog task, the candidate builder labeled it brief_pick_transport, and this
// validator had never been taught the reason. Every late-attach POST 400'd, so a
// brief that was written, paid for, and sitting in the database never reached
// the arrival, which sat on "Finishing up…" until it timed out.
test('parses a brief-picked backlog candidate that carries no deadline', () => {
  const picked = buildDayPlanCandidates({
    localDate: '2026-08-05',
    timezone: 'America/Los_Angeles',
    tasks: [{
      id: 'backlog-picked',
      title: 'Open work the brief chose',
      priority: 'medium',
      position: 0,
      column: 'due_backlog',
      status: 'open',
      briefPicked: true,
      updatedAt: '2026-08-05T15:00:00.000Z',
      refreshedAt: '2026-08-05T15:27:54.096Z',
    }],
  })[0];
  const parsed = parseDayPlanPostBody({
    action: 'ensure',
    localDate: '2026-08-05',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:late-brief:brief-pick',
    candidates: [picked],
    attachOnly: true,
  });

  assert.equal(
    parsed.input.candidates[0].whyToday,
    "This open task was selected for today's plan.",
  );
  assert.ok(parsed.input.candidates[0].rankReasons.includes('brief_pick_transport'));
  assert.equal(parsed.input.candidates[0].rankReasons.includes('due_backlog'), false);
  assert.equal(parsed.input.attachOnly, true);
});

test('parses a brief-picked backlog candidate that is also overdue', () => {
  const picked = buildDayPlanCandidates({
    localDate: '2026-08-05',
    timezone: 'America/Los_Angeles',
    tasks: [{
      id: 'backlog-picked-overdue',
      title: 'Overdue work the brief chose',
      priority: 'medium',
      dueAt: '2026-07-17T16:00:00.000Z',
      position: 0,
      column: 'due_backlog',
      status: 'open',
      briefPicked: true,
      updatedAt: '2026-08-05T15:00:00.000Z',
      refreshedAt: '2026-08-05T15:27:54.096Z',
    }],
  })[0];
  const parsed = parseDayPlanPostBody({
    action: 'ensure',
    localDate: '2026-08-05',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:late-brief:brief-pick-overdue',
    candidates: [picked],
    attachOnly: true,
  });

  assert.equal(parsed.input.candidates[0].whyToday, 'This is overdue and still open.');
  assert.ok(parsed.input.candidates[0].rankReasons.includes('brief_pick_transport'));
  assert.ok(parsed.input.candidates[0].rankReasons.includes('verified_overdue'));
});

test('rejects a brief-pick reason smuggled onto an accepted-column candidate', () => {
  const accepted = candidate();
  assert.throws(
    () =>
      parseDayPlanPostBody({
        action: 'ensure',
        localDate: '2026-07-10',
        timezone: 'America/Los_Angeles',
        mutationId: 'ensure:smuggled-brief-pick',
        candidates: [{
          ...accepted,
          whyToday: "This open task was selected for today's plan.",
        }],
      }),
    /open deadline reason/,
  );
});

test('parses manual creation intent and rejects unknown creation intent', () => {
  const parsed = parseDayPlanPostBody({
    action: 'ensure',
    localDate: '2026-08-01',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:weekend',
    candidates: [],
    creation: 'manual',
  });
  assert.equal(parsed.input.creation, 'manual');
  assert.throws(
    () => parseDayPlanPostBody({
      action: 'ensure',
      localDate: '2026-08-01',
      timezone: 'America/Los_Angeles',
      mutationId: 'ensure:weekend',
      candidates: [],
      creation: 'scheduled',
    }),
    /creation must be automatic or manual/,
  );
});

test('rejects unstructured, stale, duplicate, and oversized candidates', () => {
  const base = candidate();
  assert.throws(
    () =>
      parseDayPlanPostBody({
        action: 'ensure',
        localDate: '2026-07-10',
        timezone: 'America/Los_Angeles',
        mutationId: 'ensure:2026-07-10',
        candidates: [{ ...base, sourceRefs: [] }],
      }),
    /requires one source/,
  );
  assert.throws(
    () =>
      parseDayPlanPostBody({
        action: 'ensure',
        localDate: '2026-07-10',
        timezone: 'America/Los_Angeles',
        mutationId: 'ensure:2026-07-10',
        candidates: [
          { ...base, sourceRefs: [{ ...base.sourceRefs[0], freshness: 'stale' }] },
        ],
      }),
    /current task evidence/,
  );
  assert.throws(
    () =>
      parseDayPlanPostBody({
        action: 'ensure',
        localDate: '2026-07-10',
        timezone: 'America/Los_Angeles',
        mutationId: 'ensure:2026-07-10',
        candidates: [base, base],
      }),
    /distinct tasks/,
  );
  assert.throws(
    () =>
      parseDayPlanPostBody({
        action: 'ensure',
        localDate: '2026-07-10',
        timezone: 'America/Los_Angeles',
        mutationId: 'ensure:2026-07-10',
        candidates: Array.from({ length: 11 }, () => base),
      }),
    /at most ten/,
  );
  assert.throws(
    () =>
      parseDayPlanPostBody({
        action: 'ensure',
        localDate: '2026-07-10',
        timezone: 'America/Los_Angeles',
        mutationId: 'ensure:2026-07-10',
        candidates: [{ ...base, whyToday: 'A person is urgently waiting.' }],
      }),
    /deterministic evidence/,
  );
  assert.throws(
    () =>
      parseDayPlanPostBody({
        action: 'ensure',
        localDate: '2026-07-10',
        timezone: 'America/Los_Angeles',
        mutationId: 'ensure:2026-07-10',
        candidates: [{
          ...base,
          newestSourceRefreshAt: undefined,
          sourceRefs: [{ ...base.sourceRefs[0], refreshedAt: undefined }],
        }],
      }),
    /refreshedAt is required/,
  );
});

test('requires positive expected versions and allowlisted actions', () => {
  assert.throws(
    () =>
      parseDayPlanPostBody({
        action: 'item_owner',
        planId: 'plan-a',
        mutationId: 'owner:1',
        expectedVersion: 0,
        owner: 'me',
      }),
    /positive integer/,
  );
  assert.throws(
    () =>
      parseDayPlanPostBody({
        action: 'run_autonomously',
        planId: 'plan-a',
        mutationId: 'run:1',
        expectedVersion: 1,
      }),
    /Unknown day-plan action/,
  );
  const reconciliation = parseDayPlanPostBody({
    action: 'reconciliation_applied',
    reconciliationId: 'reconciliation-a',
  });
  assert.equal(reconciliation.action, 'reconciliation_applied');
});

test('settlement truncates oversized day dumps without blocking the mutation and still validates type', () => {
  const parsed = parseDayPlanPostBody({
    action: 'settlement_commit',
    planId: 'plan-a',
    mutationId: 'settlement:1',
    expectedVersion: 1,
    completedHumanTaskIds: [],
    nextDayNote: `${'x'.repeat(8000)}discarded`,
  });
  assert.equal(parsed.input.nextDayNote.length, 8000);
  assert.equal(parsed.input.nextDayNote, 'x'.repeat(8000));
  assert.throws(
    () => parseDayPlanPostBody({
      action: 'settlement_commit',
      planId: 'plan-a',
      mutationId: 'settlement:2',
      expectedVersion: 1,
      completedHumanTaskIds: [],
      nextDayNote: 42,
    }),
    /nextDayNote must be text/,
  );
});

test('settlement accepts completed work beyond the initial ten arrival candidates', () => {
  for (const count of [10, 11, 25, 150]) {
    const ids = Array.from({ length: count }, (_, index) => `task-${index + 1}`);
    const parsed = parseDayPlanPostBody({
      action: 'settlement_commit', planId: 'plan-a',
      mutationId: `settlement:${count}`, expectedVersion: 1,
      completedHumanTaskIds: ids,
    });
    assert.deepEqual(parsed.input.completedHumanTaskIds, ids);
  }
  for (const invalid of ['task-a', [42], [''], ['x'.repeat(201)]]) {
    assert.throws(() => parseDayPlanPostBody({
      action: 'settlement_commit', planId: 'plan-a',
      mutationId: 'settlement:invalid', expectedVersion: 1,
      completedHumanTaskIds: invalid,
    }), /completedHumanTaskIds/);
  }
});

test('day-plan route rejects Carry for recurring rhythm task cards', (t) => {
  const dir = path.join(
    os.tmpdir(),
    `cove-recurring-carry-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'cove.db');
  const db = openLocalDatabase(dbPath);
  try {
    db.prepare(
      `INSERT INTO tasks
         (id, title, tags, status, recurring_template_id, occurrence_local_date,
          created_at, updated_at)
       VALUES ('task-rhythm', 'Daily reset', '["recurring"]', 'open',
               'template-rhythm', '2026-07-10', ?, ?)`,
    ).run(
      '2026-07-10T16:00:00.000Z',
      '2026-07-10T16:00:00.000Z',
    );
  } finally {
    db.close();
  }
  const store = {
    getPlan: () => ({
      items: [{ id: 'item-rhythm', taskId: 'task-rhythm' }],
    }),
  };
  assert.throws(
    () => assertRecurringCarryAllowed(
      store,
      { planId: 'plan-rhythm', itemId: 'item-rhythm' },
      dbPath,
    ),
    /cannot be carried/,
  );
});

test('settlement decision parses trimmed progress fields and enforces their caps', () => {
  const parsed = parseDayPlanPostBody({
    action: 'settlement_decide',
    planId: 'plan-a',
    mutationId: 'settlement-progress:1',
    expectedVersion: 3,
    itemId: 'item-a',
    disposition: 'progress',
    progressNote: '  Drafted the core argument.  ',
    nextStep: '  Tighten the opening.  ',
  });
  assert.equal(parsed.input.disposition, 'progress');
  assert.equal(parsed.input.progressNote, 'Drafted the core argument.');
  assert.equal(parsed.input.nextStep, 'Tighten the opening.');
  assert.throws(
    () => parseDayPlanPostBody({
      action: 'settlement_decide',
      planId: 'plan-a',
      mutationId: 'settlement-progress:2',
      expectedVersion: 3,
      itemId: 'item-a',
      disposition: 'progress',
      progressNote: 'x'.repeat(501),
    }),
    /progressNote is too long/,
  );
  assert.throws(
    () => parseDayPlanPostBody({
      action: 'settlement_decide',
      planId: 'plan-a',
      mutationId: 'settlement-progress:3',
      expectedVersion: 3,
      itemId: 'item-a',
      disposition: 'progress',
      nextStep: 'x'.repeat(201),
    }),
    /nextStep is too long/,
  );
  assert.throws(
    () => parseDayPlanPostBody({
      action: 'settlement_decide',
      planId: 'plan-a',
      mutationId: 'settlement-progress:4',
      expectedVersion: 3,
      itemId: 'item-a',
      disposition: 'carry',
      progressNote: 'This field does not belong on Carry.',
    }),
    /must use the Progress choice/,
  );
});

test('POST returns 400 for invalid settlement progress fields', async () => {
  const post = (body) => POST(new NextRequest('http://localhost:3200/api/day-plan', {
    method: 'POST',
    headers: {
      host: 'localhost:3200',
      origin: 'http://localhost:3200',
      'content-type': 'application/json',
      'x-cove-csrf': getQuietCurrentCsrfToken(),
    },
    body: JSON.stringify(body),
  }));
  const oversized = await post({
    action: 'settlement_decide',
    planId: 'plan-a',
    mutationId: 'settlement-progress:oversized',
    expectedVersion: 3,
    itemId: 'item-a',
    disposition: 'progress',
    progressNote: 'x'.repeat(501),
  });
  assert.equal(oversized.status, 400);
  assert.match((await oversized.json()).error, /progressNote is too long/);

  const wrongDisposition = await post({
    action: 'settlement_decide',
    planId: 'plan-a',
    mutationId: 'settlement-progress:wrong-disposition',
    expectedVersion: 3,
    itemId: 'item-a',
    disposition: 'carry',
    progressNote: 'This field does not belong on Carry.',
  });
  assert.equal(wrongDisposition.status, 400);
  assert.match(
    (await wrongDisposition.json()).error,
    /Progress details must use the Progress choice/,
  );
});

test('parses a complete item_add mutation and requires its bounded payload', () => {
  const parsed = parseDayPlanPostBody({
    action: 'item_add',
    planId: 'plan-a',
    mutationId: 'add:1',
    expectedVersion: 2,
    title: 'Prepare the client follow-up',
    outcome: 'A send-ready follow-up is drafted.',
    why: 'The client is waiting on the next step.',
    owner: 'claude',
  });
  assert.equal(parsed.action, 'item_add');
  assert.equal(parsed.input.owner, 'claude');
  assert.equal(parsed.input.why, 'The client is waiting on the next step.');
  assert.throws(
    () => parseDayPlanPostBody({
      action: 'item_add',
      planId: 'plan-a',
      mutationId: 'add:2',
      expectedVersion: 2,
      title: 'Missing fields',
    }),
    /required/,
  );
  const taskBacked = parseDayPlanPostBody({
    action: 'item_add',
    planId: 'plan-a',
    mutationId: 'add:task',
    expectedVersion: 2,
    taskId: 'task-a',
  });
  assert.equal(taskBacked.input.taskId, 'task-a');
  assert.equal(taskBacked.input.title, undefined);
  const completed = parseDayPlanPostBody({
    action: 'item_complete',
    planId: 'plan-a',
    mutationId: 'complete:task',
    expectedVersion: 2,
    itemId: 'item-a',
  });
  assert.equal(completed.action, 'item_complete');
  const reopened = parseDayPlanPostBody({
    action: 'item_reopen',
    planId: 'plan-a',
    mutationId: 'reopen:task',
    expectedVersion: 3,
    itemId: 'item-a',
  });
  assert.equal(reopened.action, 'item_reopen');
  const settlementCancelled = parseDayPlanPostBody({
    action: 'settlement_cancel',
    planId: 'plan-a',
    mutationId: 'settlement-cancel:1',
    expectedVersion: 4,
  });
  assert.equal(settlementCancelled.action, 'settlement_cancel');
});

test('POST rejects untrusted hosts and missing CSRF before touching state', async () => {
  const untrusted = await POST(
    new NextRequest('http://evil.example/api/day-plan', {
      method: 'POST',
      headers: {
        host: 'evil.example',
        origin: 'http://evil.example',
        'content-type': 'application/json',
      },
      body: '{}',
    }),
  );
  assert.equal(untrusted.status, 403);

  const missingToken = await POST(
    new NextRequest('http://localhost:3200/api/day-plan', {
      method: 'POST',
      headers: {
        host: 'localhost:3200',
        origin: 'http://localhost:3200',
        'content-type': 'application/json',
      },
      body: '{}',
    }),
  );
  assert.equal(missingToken.status, 403);
});

test('route returns the weekend gate for automatic creation and honors manual creation', async (t) => {
  const dir = path.join(os.tmpdir(), `cove-route-weekend-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const store = createDayPlanStore({ dbPath: path.join(dir, 'cove.db') });
  const globalRef = globalThis;
  const previousStore = globalRef.__coveDayPlanStore;
  const previousAccess = process.env.COVE_DAY_PLAN_ACCESS_MODE;
  globalRef.__coveDayPlanStore = store;
  process.env.COVE_DAY_PLAN_ACCESS_MODE = 'loopback';
  t.after(() => {
    if (previousStore === undefined) delete globalRef.__coveDayPlanStore;
    else globalRef.__coveDayPlanStore = previousStore;
    if (previousAccess === undefined) delete process.env.COVE_DAY_PLAN_ACCESS_MODE;
    else process.env.COVE_DAY_PLAN_ACCESS_MODE = previousAccess;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const csrfToken = (await (await GET(new NextRequest(
    'http://localhost:3200/api/day-plan',
    { headers: { host: 'localhost:3200', 'x-forwarded-for': '127.0.0.1' } },
  ))).json()).csrfToken;
  const post = (creation) => POST(new NextRequest('http://localhost:3200/api/day-plan', {
    method: 'POST',
    headers: {
      host: 'localhost:3200',
      origin: 'http://localhost:3200',
      'content-type': 'application/json',
      'x-cove-csrf': csrfToken,
    },
    body: JSON.stringify({
      action: 'ensure',
      localDate: '2026-08-01',
      timezone: 'America/Los_Angeles',
      mutationId: 'ensure:route-weekend',
      candidates: [],
      creation,
    }),
  }));

  const automatic = await post('automatic');
  assert.equal(automatic.status, 200);
  assert.deepEqual(await automatic.json(), {
    weekendGate: { localDate: '2026-08-01', weekday: 'Saturday' },
    replayed: false,
  });
  assert.equal(store.getReadModel().currentPlan, undefined);

  const manual = await post('manual');
  assert.equal(manual.status, 201);
  const manualBody = await manual.json();
  assert.equal(manualBody.plan.localDate, '2026-08-01');
  assert.equal(store.listEvents(manualBody.plan.id)[0].after.creation, 'manual');
});

test('GET skips failed day-plan initialization instead of returning 500', async (t) => {
  const dir = path.join(os.tmpdir(), `cove-route-initialize-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const store = createDayPlanStore({ dbPath: path.join(dir, 'cove.db') });
  const globalRef = globalThis;
  const previousStore = globalRef.__coveDayPlanStore;
  const previousAccess = process.env.COVE_DAY_PLAN_ACCESS_MODE;
  globalRef.__coveDayPlanStore = store;
  process.env.COVE_DAY_PLAN_ACCESS_MODE = 'loopback';
  store.initialize = () => {
    throw new Error('simulated weekend cleanup failure');
  };
  const errors = [];
  const originalError = console.error;
  console.error = (...values) => errors.push(values);
  t.after(() => {
    console.error = originalError;
    if (previousStore === undefined) delete globalRef.__coveDayPlanStore;
    else globalRef.__coveDayPlanStore = previousStore;
    if (previousAccess === undefined) delete process.env.COVE_DAY_PLAN_ACCESS_MODE;
    else process.env.COVE_DAY_PLAN_ACCESS_MODE = previousAccess;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const response = await GET(new NextRequest(
    'http://localhost:3200/api/day-plan',
    { headers: { host: 'localhost:3200', 'x-forwarded-for': '127.0.0.1' } },
  ));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).currentPlan, undefined);
  assert.match(errors[0][0], /initialization skipped/);
  assert.match(errors[0][1].message, /simulated weekend cleanup failure/);
});

test('GET exposes briefGeneration on loopback and strips it for a remote session', async (t) => {
  const dir = path.join(os.tmpdir(), `cove-route-gen-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const store = createDayPlanStore({ dbPath: path.join(dir, 'cove.db') });
  const globalRef = globalThis;
  const previousStore = globalRef.__coveDayPlanStore;
  const previousEnv = {
    access: process.env.COVE_DAY_PLAN_ACCESS_MODE,
    token: process.env.COVE_DAY_PLAN_REMOTE_TOKEN,
    hosts: process.env.COVE_ALLOWED_HOSTS,
  };
  globalRef.__coveDayPlanStore = store;
  t.after(() => {
    if (previousStore === undefined) delete globalRef.__coveDayPlanStore;
    else globalRef.__coveDayPlanStore = previousStore;
    for (const [key, value] of [
      ['COVE_DAY_PLAN_ACCESS_MODE', previousEnv.access],
      ['COVE_DAY_PLAN_REMOTE_TOKEN', previousEnv.token],
      ['COVE_ALLOWED_HOSTS', previousEnv.hosts],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // An open plan for the date, with a brief still queued (never consumed): the
  // in-flight scenario the arrival cares about.
  store.ensureDayPlan({
    localDate: '2026-07-10',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:2026-07-10',
    candidates: [candidate()],
  });
  const queued = store.enqueueMorningBrief(
    '2026-07-10',
    { modelAlias: 'opus', effort: 'high', budgetUsd: 1.5 },
  ).brief;

  process.env.COVE_DAY_PLAN_ACCESS_MODE = 'loopback';
  const loopback = await GET(
    new NextRequest('http://localhost:3200/api/day-plan', {
      headers: { host: 'localhost:3200', 'x-forwarded-for': '127.0.0.1' },
    }),
  );
  assert.equal(loopback.status, 200);
  const loopbackBody = await loopback.json();
  assert.equal(loopbackBody.briefGeneration.state, 'queued');
  assert.ok(loopbackBody.currentPlan);

  store.claimNextMorningBrief();
  store.recordMorningBriefInputs(queued.id, {
    inputHash: 'route-succeeded-brief',
    sourceManifest: { sources: [], coverage: {}, trims: [], totalChars: 0 },
    promptVersion: MORNING_BRIEF_PROMPT_VERSION,
    schemaVersion: MORNING_BRIEF_SCHEMA_VERSION,
  });
  store.completeMorningBrief(queued.id, '{}');
  const completed = await GET(
    new NextRequest('http://localhost:3200/api/day-plan', {
      headers: { host: 'localhost:3200', 'x-forwarded-for': '127.0.0.1' },
    }),
  );
  assert.equal(completed.status, 200);
  const completedBody = await completed.json();
  assert.equal(completedBody.briefGeneration.state, 'succeeded');
  assert.equal('briefId' in completedBody.currentPlan, false);
  assert.equal('arrivalInteractedAt' in completedBody.currentPlan, false);

  // The same store over a remote session strips briefGeneration exactly like
  // brief content: a remote caller never learns a brief exists or is being written.
  process.env.COVE_DAY_PLAN_ACCESS_MODE = 'session';
  process.env.COVE_DAY_PLAN_REMOTE_TOKEN = 'secret-value';
  process.env.COVE_ALLOWED_HOSTS = 'cove.example.test';
  const remote = await GET(
    new NextRequest('https://cove.example.test/api/day-plan', {
      headers: {
        host: 'cove.example.test',
        origin: 'https://cove.example.test',
        'x-cove-day-plan-session': 'secret-value',
      },
    }),
  );
  assert.equal(remote.status, 200);
  const remoteBody = await remote.json();
  assert.equal(remoteBody.briefGeneration, undefined);
  assert.ok(remoteBody.currentPlan);
  assert.equal(remoteBody.currentPlan.briefId, undefined);
});

test('settlement opens with last-known state on a REST hiccup, then reconciles on reopen', async (t) => {
  const dir = path.join(os.tmpdir(), `cove-route-settlement-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const store = createDayPlanStore({
    dbPath: path.join(dir, 'cove.db'),
    now: () => new Date('2026-07-10T18:00:00.000Z'),
  });
  const globalRef = globalThis;
  const previousStore = globalRef.__coveDayPlanStore;
  const previousFetch = globalRef.fetch;
  const previousAccess = process.env.COVE_DAY_PLAN_ACCESS_MODE;
  const previousDataDir = process.env.COVE_DATA_DIR;
  process.env.COVE_DATA_DIR = dir;
  const previousWebUrl = process.env.COVE_BRIEF_WEB_BASE;
  globalRef.__coveDayPlanStore = store;
  process.env.COVE_DAY_PLAN_ACCESS_MODE = 'loopback';
  process.env.COVE_BRIEF_WEB_BASE = 'http://cove.test';
  t.after(() => {
    if (previousStore === undefined) delete globalRef.__coveDayPlanStore;
    else globalRef.__coveDayPlanStore = previousStore;
    globalRef.fetch = previousFetch;
    if (previousAccess === undefined) delete process.env.COVE_DAY_PLAN_ACCESS_MODE;
    else process.env.COVE_DAY_PLAN_ACCESS_MODE = previousAccess;
    if (previousWebUrl === undefined) delete process.env.COVE_BRIEF_WEB_BASE;
    else process.env.COVE_BRIEF_WEB_BASE = previousWebUrl;
    if (previousDataDir === undefined) delete process.env.COVE_DATA_DIR;
    else process.env.COVE_DATA_DIR = previousDataDir;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const board = openLocalDatabase(path.join(dir, 'cove.db'));
  board.exec(`
    INSERT INTO task_columns (id, name, position) VALUES
      ('col-today', 'Must happen today', 0), ('col-done', 'Done', 1);
    INSERT INTO tasks (id, title, column_id, status, position)
      VALUES ('task-a', 'Finish the proposal', 'col-today', 'open', 0);
  `);
  board.close();
  let plan = store.ensureDayPlan({
    localDate: '2026-07-10',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:settlement',
    candidates: [candidate()],
  }).plan;
  plan = store.mutateDayPlan({
    planId: plan.id,
    mutationId: 'open:settlement',
    expectedVersion: plan.version,
    action: 'arrival_open',
  }).plan;
  plan = store.mutateDayPlan({
    planId: plan.id,
    mutationId: 'owner:settlement',
    expectedVersion: plan.version,
    action: 'item_owner',
    itemId: plan.items[0].id,
    owner: 'claude',
  }).plan;
  plan = store.mutateDayPlan({
    planId: plan.id,
    mutationId: 'start:settlement',
    expectedVersion: plan.version,
    action: 'start_day',
  }).plan;
  assert.equal(plan.items[0].decision, 'accepted');
  // Completed items remain in history while new work takes their active seats.
  for (let index = 0; index < 11; index += 1) {
    plan = store.mutateDayPlan({
      planId: plan.id, mutationId: `complete:${index}`,
      expectedVersion: plan.version, action: 'item_complete',
      itemId: plan.items.at(-1).id,
    }).plan;
    plan = store.mutateDayPlan({
      planId: plan.id, mutationId: `add:${index}`,
      expectedVersion: plan.version, action: 'item_add',
      title: `Additional work ${index}`, outcome: `Finish work ${index}`,
      why: 'Added during the day', owner: 'me',
    }).plan;
  }
  assert.equal(plan.items.length, 12);

  const internalCalls = [];
  let restAvailable = false;
  globalRef.fetch = async (url) => {
    internalCalls.push(String(url));
    if (!restAvailable) return new Response('temporary failure', { status: 503 });
    if (String(url).includes('/api/cove-rest/tasks')) {
      return new Response(JSON.stringify(plan.items.map(item => ({
        id: item.taskId, status: 'done', column_id: 'done-column',
        updated_at: '2026-07-10T23:00:00.000Z',
      }))), { status: 200 });
    }
    if (String(url).includes('/api/cove-rest/task_columns')) {
      return new Response(JSON.stringify([{ id: 'done-column', name: 'Done' }]), { status: 200 });
    }
    throw new Error(`unexpected internal fetch: ${url}`);
  };

  const tokenResponse = await GET(new NextRequest('http://localhost:3200/api/day-plan', {
    headers: { host: 'localhost:3200', 'x-forwarded-for': '127.0.0.1' },
  }));
  const token = (await tokenResponse.json()).csrfToken;
  const response = await POST(new NextRequest('http://localhost:3200/api/day-plan', {
    method: 'POST',
    headers: {
      host: 'localhost:3200',
      origin: 'http://localhost:3200',
      'content-type': 'application/json',
      'x-cove-csrf': token,
    },
    body: JSON.stringify({
      action: 'settlement_start',
      planId: plan.id,
      mutationId: `settlement-start:${plan.id}:${plan.version}`,
      expectedVersion: plan.version,
    }),
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.plan.state, 'settling');
  assert.equal(body.plan.items.at(-1).decision, 'accepted');
  assert.equal(body.plan.items.at(-1).workedToday, false);
  assert.equal(internalCalls.some((url) => url.includes('/api/cove-rest/tasks')), true);
  assert.equal(internalCalls.some((url) => url.includes('/api/cove-rest/task_columns')), true);

  restAvailable = true;
  internalCalls.length = 0;
  const reopened = await POST(new NextRequest('http://localhost:3200/api/day-plan', {
    method: 'POST',
    headers: {
      host: 'localhost:3200',
      origin: 'http://localhost:3200',
      'content-type': 'application/json',
      'x-cove-csrf': token,
    },
    body: JSON.stringify({
      action: 'settlement_start',
      planId: body.plan.id,
      mutationId: `settlement-reopen:${body.plan.id}:${body.plan.version}`,
      expectedVersion: body.plan.version,
    }),
  }));
  assert.equal(reopened.status, 200);
  const reopenedBody = await reopened.json();
  assert.equal(reopenedBody.plan.state, 'settling');
  assert.equal(reopenedBody.plan.items.filter(item => item.decision === 'completed').length, 12);
  const completedHumanTaskIds = reopenedBody.plan.items.map(item => item.taskId);
  const commit = {
    action: 'settlement_commit', planId: plan.id,
    mutationId: 'settlement:many:commit', expectedVersion: reopenedBody.plan.version,
    completedHumanTaskIds, nextDayNote: 'Think through a partner ramp plan tomorrow.',
  };
  const invalid = await loopbackPost({ ...commit,
    mutationId: 'settlement:foreign-task',
    completedHumanTaskIds: [...completedHumanTaskIds, 'not-in-this-plan'],
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /Completed work must belong to this day plan/);
  assert.equal(store.getPlan(plan.id).state, 'settling');
  const committed = await loopbackPost(commit);
  assert.equal(committed.status, 200);
  const saved = await committed.json();
  assert.equal(saved.plan.state, 'settled');
  assert.deepEqual(saved.snapshot.body.completedHumanTaskIds, completedHumanTaskIds);
  assert.equal(store.getPlan(plan.id).nextDayNote, commit.nextDayNote);
  const replay = await loopbackPost(commit);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
});

test('non-loopback day-plan access requires the separate remote session secret', () => {
  const previous = {
    allowedHosts: process.env.COVE_ALLOWED_HOSTS,
    accessMode: process.env.COVE_DAY_PLAN_ACCESS_MODE,
    trustProxy: process.env.COVE_TRUST_PROXY,
  };
  process.env.COVE_ALLOWED_HOSTS = 'cove.example.test';
  delete process.env.COVE_DAY_PLAN_ACCESS_MODE;
  delete process.env.COVE_TRUST_PROXY;
  try {
    const request = (session) => new NextRequest('https://cove.example.test/api/day-plan', {
      headers: {
        host: 'cove.example.test',
        origin: 'https://cove.example.test',
        ...(session ? { 'x-cove-day-plan-session': session } : {}),
      },
    });
    const sessionOptions = { accessMode: 'session', sessionToken: 'secret-value' };
    assert.equal(hasDayPlanRouteAccess(request(), sessionOptions), false);
    assert.equal(hasDayPlanRouteAccess(request('wrong-value'), sessionOptions), false);
    assert.equal(hasDayPlanRouteAccess(request('secret-value'), sessionOptions), true);

    const spoofedForwardedHost = new NextRequest('http://cove.example.test/api/day-plan', {
      headers: {
        host: 'cove.example.test',
        'x-forwarded-host': 'localhost:3200',
      },
    });
    assert.equal(hasDayPlanRouteAccess(spoofedForwardedHost, sessionOptions), false);

    const spoofedDirectHost = new NextRequest('http://cove.example.test/api/day-plan', {
      headers: {
        host: 'localhost:3200',
        'x-forwarded-for': '203.0.113.10',
      },
    });
    assert.equal(hasDayPlanRouteAccess(spoofedDirectHost, sessionOptions), false);

    const localRequest = new NextRequest('http://localhost:3200/api/day-plan', {
      headers: {
        host: 'localhost:3200',
        'x-forwarded-for': '127.0.0.1',
      },
    });
    assert.equal(hasDayPlanRouteAccess(localRequest), true);
    assert.equal(
      hasDayPlanRouteAccess(localRequest, { accessMode: 'loopback' }),
      true,
    );

    const proxiedToLoopback = new NextRequest('http://127.0.0.1:3200/api/day-plan', {
      headers: {
        host: '127.0.0.1:3200',
        'x-forwarded-host': 'cove.example.test',
        'x-forwarded-proto': 'https',
      },
    });
    assert.equal(
      hasDayPlanRouteAccess(proxiedToLoopback, { accessMode: 'loopback' }),
      true,
    );
    process.env.COVE_TRUST_PROXY = '1';
    assert.equal(
      hasDayPlanRouteAccess(proxiedToLoopback, { accessMode: 'loopback' }),
      false,
    );
  } finally {
    for (const [key, value] of [
      ['COVE_ALLOWED_HOSTS', previous.allowedHosts],
      ['COVE_DAY_PLAN_ACCESS_MODE', previous.accessMode],
      ['COVE_TRUST_PROXY', previous.trustProxy],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('loopback mode admits designated tailnet hosts and nothing else', () => {
  const previous = process.env.COVE_TAILSCALE_TRUSTED_HOSTS;
  const tailnetHost = 'mini.example.ts.net';
  const viaTailnet = new NextRequest(`https://${tailnetHost}/api/day-plan`, {
    headers: { host: tailnetHost, origin: `https://${tailnetHost}` },
  });
  const viaImpostor = new NextRequest('https://evil.example.com/api/day-plan', {
    headers: { host: 'evil.example.com' },
  });
  try {
    delete process.env.COVE_TAILSCALE_TRUSTED_HOSTS;
    assert.equal(
      hasDayPlanRouteAccess(viaTailnet, { accessMode: 'loopback' }),
      false,
      'tailnet host is refused until it is explicitly designated',
    );

    process.env.COVE_TAILSCALE_TRUSTED_HOSTS = tailnetHost;
    assert.equal(
      hasDayPlanRouteAccess(viaTailnet, { accessMode: 'loopback' }),
      true,
    );
    // The designation is not a blanket opening: a rebinding page still arrives
    // carrying its own Host, which never matches the list.
    assert.equal(
      hasDayPlanRouteAccess(viaImpostor, { accessMode: 'loopback' }),
      false,
    );
    assert.equal(
      isLoopbackCoveRequest(viaTailnet),
      false,
      'the buddy delete-token endpoint stays loopback-only',
    );
  } finally {
    if (previous === undefined) delete process.env.COVE_TAILSCALE_TRUSTED_HOSTS;
    else process.env.COVE_TAILSCALE_TRUSTED_HOSTS = previous;
  }
});

test('unset and empty day-plan access mode default to loopback', () => {
  const previous = process.env.COVE_DAY_PLAN_ACCESS_MODE;
  const localRequest = new NextRequest('http://localhost:3200/api/day-plan', {
    headers: { host: 'localhost:3200', origin: 'http://localhost:3200' },
  });
  try {
    delete process.env.COVE_DAY_PLAN_ACCESS_MODE;
    assert.equal(hasDayPlanRouteAccess(localRequest), true);
    process.env.COVE_DAY_PLAN_ACCESS_MODE = '   ';
    assert.equal(hasDayPlanRouteAccess(localRequest), true);
  } finally {
    if (previous === undefined) delete process.env.COVE_DAY_PLAN_ACCESS_MODE;
    else process.env.COVE_DAY_PLAN_ACCESS_MODE = previous;
  }
});

// ---------------------------------------------------------------------------
// The brief gate over the wire: the read model that blocks, and the one action
// that writes past it.
// ---------------------------------------------------------------------------

function candidateFor(localDate) {
  return buildDayPlanCandidates({
    localDate,
    timezone: 'America/Los_Angeles',
    tasks: [
      {
        id: `task-${localDate}`,
        title: 'Finish the proposal',
        priority: 'high',
        position: 0,
        column: 'today',
        status: 'open',
        updatedAt: `${localDate}T15:00:00.000Z`,
        refreshedAt: `${localDate}T16:00:00.000Z`,
      },
    ],
  })[0];
}

function gateFixture(t) {
  const dir = path.join(os.tmpdir(), `cove-route-gate-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'cove.db');
  const store = createDayPlanStore({ dbPath });
  const globalRef = globalThis;
  const previousStore = globalRef.__coveDayPlanStore;
  const previousEnv = {
    access: process.env.COVE_DAY_PLAN_ACCESS_MODE,
    token: process.env.COVE_DAY_PLAN_REMOTE_TOKEN,
    hosts: process.env.COVE_ALLOWED_HOSTS,
  };
  globalRef.__coveDayPlanStore = store;
  process.env.COVE_DAY_PLAN_ACCESS_MODE = 'loopback';
  t.after(() => {
    if (previousStore === undefined) delete globalRef.__coveDayPlanStore;
    else globalRef.__coveDayPlanStore = previousStore;
    for (const [key, value] of [
      ['COVE_DAY_PLAN_ACCESS_MODE', previousEnv.access],
      ['COVE_DAY_PLAN_REMOTE_TOKEN', previousEnv.token],
      ['COVE_ALLOWED_HOSTS', previousEnv.hosts],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Yesterday: started and never closed. Today: a fresh plan with no brief.
  let yesterday = store.ensureDayPlan({
    localDate: '2026-07-09',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:2026-07-09',
    candidates: [candidateFor('2026-07-09')],
  }).plan;
  for (const action of ['arrival_open', 'start_day']) {
    yesterday = store.mutateDayPlan({
      planId: yesterday.id,
      mutationId: `${action}:2026-07-09`,
      expectedVersion: yesterday.version,
      action,
    }).plan;
  }
  const today = store.ensureDayPlan({
    localDate: '2026-07-10',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:2026-07-10',
    candidates: [candidateFor('2026-07-10')],
  }).plan;
  return { store, yesterday, today, dbPath };
}

const LOOPBACK_HEADERS = { host: 'localhost:3200', 'x-forwarded-for': '127.0.0.1' };

function loopbackGet() {
  return GET(new NextRequest('http://localhost:3200/api/day-plan', { headers: LOOPBACK_HEADERS }));
}

async function loopbackPost(body) {
  const token = (await (await loopbackGet()).json()).csrfToken;
  return POST(new NextRequest('http://localhost:3200/api/day-plan', {
    method: 'POST',
    headers: {
      host: 'localhost:3200',
      origin: 'http://localhost:3200',
      'content-type': 'application/json',
      'x-cove-csrf': token,
    },
    body: JSON.stringify(body),
  }));
}

test('an unclosed day keeps the open slot, so the read model never jumps ahead of it', async (t) => {
  const { store, yesterday } = gateFixture(t);
  // This is why the arrival needs no gate notice of its own: while a day is
  // unclosed it IS the current plan, and the client already force-routes it into
  // settlement. There is no state where today's arrival renders over an open
  // yesterday.
  const body = await (await loopbackGet()).json();
  assert.equal(body.currentPlan.localDate, '2026-07-09');
  assert.equal(body.currentPlan.id, yesterday.id);

  let plan = store.getPlan(yesterday.id);
  plan = store.mutateDayPlan({ planId: plan.id, mutationId: 'ss:1', expectedVersion: plan.version, action: 'settlement_start' }).plan;
  plan = store.mutateDayPlan({ planId: plan.id, mutationId: 'sd:1', expectedVersion: plan.version, action: 'settlement_decide', itemId: plan.items[0].id, disposition: 'carry' }).plan;
  store.mutateDayPlan({ planId: plan.id, mutationId: 'sc:1', expectedVersion: plan.version, action: 'settlement_commit', completedHumanTaskIds: [] });
  // Only once it is settled does the slot free up for the next day.
  const cleared = await (await loopbackGet()).json();
  assert.equal(cleared.currentPlan, undefined);
});

test('brief me anyway queues one blind brief, and a double tap never starts a second', async (t) => {
  const { store } = gateFixture(t);
  const first = await loopbackPost({ action: 'brief_force', localDate: '2026-07-10' });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).briefGeneration.state, 'queued');
  assert.equal(store.listMorningBriefs('2026-07-10').length, 1);

  // This is the button a frustrated person taps twice. Every extra tap costs a
  // paid generation if it is not idempotent.
  const second = await loopbackPost({ action: 'brief_force', localDate: '2026-07-10' });
  assert.equal(second.status, 200);
  assert.equal(store.listMorningBriefs('2026-07-10').length, 1);
});

test('brief me anyway supersedes an expired running claim before it queues a retry', async (t) => {
  const { store, dbPath } = gateFixture(t);
  const expired = store.enqueueMorningBrief('2026-07-10', {
    modelAlias: 'opus',
    effort: 'high',
    budgetUsd: 1.5,
  }).brief;
  store.claimNextMorningBrief();
  const db = openLocalDatabase(dbPath);
  db.prepare(
    "UPDATE day_plan_briefs SET started_at = ?, updated_at = ? WHERE id = ?",
  ).run(
    new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    expired.id,
  );
  db.close();

  const forced = await loopbackPost({ action: 'brief_force', localDate: '2026-07-10' });
  assert.equal(forced.status, 200);
  assert.equal((await forced.json()).briefGeneration.state, 'queued');
  const rows = store.listMorningBriefs('2026-07-10');
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.id === expired.id).status, 'failed');
  assert.equal(rows.find((row) => row.id !== expired.id).status, 'queued');
});

test('brief me anyway never buys a second brief once one is already written', async (t) => {
  const { store } = gateFixture(t);
  const queued = store.enqueueMorningBrief('2026-07-10', {
    modelAlias: 'sonnet',
    effort: 'medium',
    budgetUsd: 1,
  });
  const claimed = store.claimNextMorningBrief();
  store.completeMorningBrief(claimed.id, JSON.stringify({ lensNarrative: 'done' }));

  const forced = await loopbackPost({ action: 'brief_force', localDate: '2026-07-10' });
  assert.equal(forced.status, 200);
  const briefs = store.listMorningBriefs('2026-07-10');
  assert.equal(briefs.length, 1);
  assert.equal(briefs[0].id, queued.brief.id);
});

test('brief me anyway attaches a refused-management artifact without buying another brief', async (t) => {
  const { store, yesterday, dbPath } = gateFixture(t);
  let prior = store.getPlan(yesterday.id);
  prior = store.mutateDayPlan({
    planId: prior.id,
    mutationId: 'settlement:start:refused-management',
    expectedVersion: prior.version,
    action: 'settlement_start',
    completedHumanTaskIds: [prior.items[0].taskId],
  }).plan;
  store.mutateDayPlan({
    planId: prior.id,
    mutationId: 'settlement:commit:refused-management',
    expectedVersion: prior.version,
    action: 'settlement_commit',
    completedHumanTaskIds: [prior.items[0].taskId],
  });
  const today = store.ensureDayPlan({
    localDate: '2026-07-10',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:refused-management',
    candidates: [candidateFor('2026-07-10')],
  }).plan;
  store.markArrivalInteraction(today.id, 'interact:refused-management');

  const db = openLocalDatabase(dbPath);
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
    INSERT OR IGNORE INTO task_columns (id, name, position) VALUES ('col-ns', 'Not Started', 0);
    INSERT OR IGNORE INTO tasks
      (id, column_id, title, description, priority, tags, position, status, updated_at)
    VALUES
      ('task-managed', 'col-ns', 'Human title', '', 'medium', '[]', 0, 'open',
       '2026-07-10T15:00:00.000Z');
  `);
  db.close();
  const artifact = store.enqueueMorningBrief('2026-07-10', {
    modelAlias: 'opus', effort: 'high', budgetUsd: 1.5,
  }).brief;
  store.claimNextMorningBrief();
  store.completeMorningBrief(artifact.id, JSON.stringify({
    headline: 'Focus.', narrativeParagraphs: ['Work.'], lensNarrative: 'Focus.\n\nWork.',
    existingTaskCandidates: [], watchItems: [],
    boardActions: [{
      op: 'retitle', taskId: 'task-managed', title: 'Agent title', why: 'Clarify.',
      evidenceRefs: [], expectedTaskUpdatedAt: '2026-07-10T15:00:00.000Z',
    }],
  }));
  store.stageMorningBriefBoardActions(artifact.id);
  assert.equal(
    store.activateBriefBoardActions('2026-07-10', new Date('2026-07-10T16:00:00.000Z')).activated,
    false,
  );
  assert.equal(store.latestEligibleMorningBrief('2026-07-10').id, artifact.id);

  const forced = await loopbackPost({ action: 'brief_force', localDate: '2026-07-10' });
  assert.equal(forced.status, 200);
  assert.equal((await forced.json()).attached, true);
  assert.equal(store.getPlan(today.id).briefId, artifact.id);
  assert.equal(store.listMorningBriefs('2026-07-10').length, 1);
});

test('forcing a brief is loopback-only, like every other brief surface', async (t) => {
  const { store } = gateFixture(t);
  const token = (await (await loopbackGet()).json()).csrfToken;
  process.env.COVE_DAY_PLAN_ACCESS_MODE = 'session';
  process.env.COVE_DAY_PLAN_REMOTE_TOKEN = 'secret-value';
  process.env.COVE_ALLOWED_HOSTS = 'cove.example.test';
  const remote = await POST(new NextRequest('https://cove.example.test/api/day-plan', {
    method: 'POST',
    headers: {
      host: 'cove.example.test',
      origin: 'https://cove.example.test',
      'content-type': 'application/json',
      'x-cove-csrf': token,
      'x-cove-day-plan-session': 'secret-value',
    },
    body: JSON.stringify({ action: 'brief_force', localDate: '2026-07-10' }),
  }));
  assert.equal(remote.status, 403);
  assert.equal(store.listMorningBriefs('2026-07-10').length, 0);
});
