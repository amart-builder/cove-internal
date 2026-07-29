import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openLocalDatabase } from '../src/lib/local/database.ts';
import { handleLocalRest } from '../src/lib/local/db.ts';
import { JobScheduler } from '../src/lib/reliability/jobs.ts';
import {
  enqueueDailyTaskMaintenance,
  resetTaskMaintenanceScheduleForTests,
  scheduleTaskMaintenanceCatchup,
  TASK_JOB_TYPES,
} from '../src/lib/tasks/maintenance.ts';
import {
  cadenceOccursOn,
  confirmTaskRecurrence,
  createRecurringTemplate,
  detectRecurrenceIntent,
  expireRecurringInstances,
  recurringRhythmSnapshot,
  spawnRecurringTasks,
  syncRecurringOccurrenceForTask,
  updateRecurringTemplate,
} from '../src/lib/tasks/recurrence.ts';

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-recurrence-'));
  const dbPath = path.join(dir, 'forge.db');
  const db = openLocalDatabase(dbPath);
  db.close();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, dbPath };
}

test('cadences cover weekdays, weekly days, and monthly month-end clamping', () => {
  assert.equal(cadenceOccursOn('daily', '2026-02-01'), true);
  assert.equal(cadenceOccursOn('weekdays', '2026-02-02'), true);
  assert.equal(cadenceOccursOn('weekdays', '2026-02-01'), false);
  assert.equal(cadenceOccursOn('weekly:monday', '2026-02-02'), true);
  assert.equal(cadenceOccursOn('weekly:monday', '2026-02-03'), false);
  assert.equal(cadenceOccursOn('monthly:31', '2026-02-28'), true);
  assert.equal(cadenceOccursOn('monthly:31', '2028-02-29'), true);
  assert.equal(cadenceOccursOn('monthly:31', '2026-04-30'), true);
  assert.equal(cadenceOccursOn('monthly:15', '2026-04-30'), false);
});

test('two same-day spawner ticks materialize one structurally unique task', async (t) => {
  const { dbPath } = fixture(t);
  const now = new Date('2026-07-28T16:00:00.000Z');
  createRecurringTemplate({
    title: 'Post content',
    cadence: 'daily',
    dbPath,
    now,
    timezone: 'America/Los_Angeles',
    spawnToday: false,
  });

  const moduleUrl = new URL('../src/lib/tasks/recurrence.ts', import.meta.url).href;
  const tickInput = {
    dbPath,
    now: now.toISOString(),
    timezone: 'America/Los_Angeles',
    localDate: '2026-07-28',
  };
  const runTick = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      `const recurrence = await import(${JSON.stringify(moduleUrl)});
       const input = ${JSON.stringify(tickInput)};
       const run = recurrence.spawnRecurringTasks ?? recurrence.default.spawnRecurringTasks;
       run({ ...input, now: new Date(input.now) });`,
    ], {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`recurrence tick exited ${code}: ${stderr}`));
    });
  });
  await Promise.all([runTick(), runTick()]);

  const db = openLocalDatabase(dbPath);
  try {
    assert.equal(db.prepare('SELECT count(*) AS n FROM recurring_occurrences').get().n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM tasks WHERE source_type = 'recurring'").get().n, 1);
    const indexes = db.prepare('PRAGMA index_list("recurring_occurrences")').all();
    assert.ok(indexes.some((index) => index.unique === 1));
  } finally {
    db.close();
  }
});

test('settlement expires unfinished recurrence without Carry and records the miss', (t) => {
  const { dbPath } = fixture(t);
  const now = new Date('2026-07-28T16:00:00.000Z');
  createRecurringTemplate({
    title: 'Walk after lunch',
    cadence: 'daily',
    dbPath,
    now,
    timezone: 'America/Los_Angeles',
  });
  assert.deepEqual(expireRecurringInstances({
    dbPath,
    localDate: '2026-07-28',
    now: new Date('2026-07-29T03:00:00.000Z'),
  }), { expired: 1 });

  const db = openLocalDatabase(dbPath);
  try {
    assert.equal(db.prepare('SELECT state FROM recurring_occurrences').get().state, 'missed');
    const task = db.prepare("SELECT status, archived_at FROM tasks WHERE source_type = 'recurring'").get();
    assert.equal(task.status, 'archived');
    assert.ok(task.archived_at);
    assert.equal(
      db.prepare('SELECT last_missed_local_date FROM recurring_templates').get().last_missed_local_date,
      '2026-07-28',
    );
  } finally {
    db.close();
  }
  const rhythm = recurringRhythmSnapshot({
    dbPath,
    localDate: '2026-07-29',
    now: new Date('2026-07-29T16:00:00.000Z'),
    timezone: 'America/Los_Angeles',
  })[0];
  assert.equal(rhythm.currentStreak, 0);
  assert.deepEqual(rhythm.recentMisses, ['2026-07-28']);
});

test('streaks count completions and reset when a scheduled day is missed', (t) => {
  const { dbPath } = fixture(t);
  const jan1 = new Date('2026-01-01T18:00:00.000Z');
  createRecurringTemplate({
    title: 'Write',
    cadence: 'daily',
    dbPath,
    now: jan1,
    timezone: 'UTC',
  });
  const db = openLocalDatabase(dbPath);
  try {
    const taskId = db.prepare("SELECT id FROM tasks WHERE source_type = 'recurring'").get().id;
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(taskId);
    syncRecurringOccurrenceForTask(
      db,
      taskId,
      'done',
      new Date('2026-01-01T20:00:00.000Z').toISOString(),
    );
  } finally {
    db.close();
  }
  assert.equal(recurringRhythmSnapshot({
    dbPath,
    localDate: '2026-01-01',
    now: jan1,
    timezone: 'UTC',
  })[0].currentStreak, 1);

  spawnRecurringTasks({
    dbPath,
    now: new Date('2026-01-03T12:00:00.000Z'),
    timezone: 'UTC',
    localDate: '2026-01-03',
  });
  const rhythm = recurringRhythmSnapshot({
    dbPath,
    localDate: '2026-01-03',
    now: new Date('2026-01-03T12:00:00.000Z'),
    timezone: 'UTC',
  })[0];
  assert.equal(rhythm.currentStreak, 0);
  assert.deepEqual(rhythm.recentMisses, ['2026-01-02']);
});

test('recurrence intent creates only a proposal until explicit confirmation', (t) => {
  const { dbPath } = fixture(t);
  assert.equal(detectRecurrenceIntent('Post a clip every day'), 'daily');
  assert.equal(detectRecurrenceIntent('Review metrics each Monday'), 'weekly:monday');
  assert.equal(detectRecurrenceIntent('Review metrics next Monday'), undefined);

  const db = openLocalDatabase(dbPath);
  const taskId = 'proposal-task';
  try {
    const column = db.prepare("SELECT id FROM task_columns WHERE name = 'Must happen today'").get();
    db.prepare(
      `INSERT INTO tasks
         (id, column_id, title, tags, status, proposed_recurrence_cadence,
          created_at, updated_at)
       VALUES (?, ?, 'Post a clip every day', '["recurrence-proposed"]',
               'open', 'daily', ?, ?)`,
    ).run(
      taskId,
      column.id,
      new Date('2026-07-28T16:00:00.000Z').toISOString(),
      new Date('2026-07-28T16:00:00.000Z').toISOString(),
    );
    assert.equal(db.prepare('SELECT count(*) AS n FROM recurring_templates').get().n, 0);
  } finally {
    db.close();
  }

  const template = confirmTaskRecurrence({
    taskId,
    dbPath,
    now: new Date('2026-07-28T16:00:00.000Z'),
    timezone: 'America/Los_Angeles',
  });
  assert.equal(template.cadence, 'daily');
  const verified = openLocalDatabase(dbPath);
  try {
    assert.equal(verified.prepare('SELECT count(*) AS n FROM recurring_templates').get().n, 1);
    const task = verified.prepare('SELECT tags, proposed_recurrence_cadence FROM tasks WHERE id = ?').get(taskId);
    assert.equal(task.proposed_recurrence_cadence, null);
    assert.ok(JSON.parse(task.tags).includes('recurring'));
  } finally {
    verified.close();
  }
});

test('template pause, resume, cadence edit, deactivate, and timezone deferral stay small and deterministic', (t) => {
  const { dbPath } = fixture(t);
  const now = new Date('2026-07-28T16:00:00.000Z');
  const template = createRecurringTemplate({
    title: 'Daily check',
    cadence: 'daily',
    dbPath,
    now,
    timezone: 'America/Los_Angeles',
  });
  const paused = updateRecurringTemplate({
    id: template.id,
    cadence: 'weekly:tuesday',
    pausedUntil: '2026-08-04',
    dbPath,
    now,
  });
  assert.equal(paused.cadence, 'weekly:tuesday');
  assert.equal(paused.pausedUntil, '2026-08-04');
  assert.equal(updateRecurringTemplate({
    id: template.id,
    pausedUntil: null,
    active: false,
    dbPath,
    now,
  }).active, false);

  const daily = createRecurringTemplate({
    title: 'Timezone rhythm',
    cadence: 'daily',
    dbPath,
    now,
    timezone: 'America/Los_Angeles',
  });
  spawnRecurringTasks({
    dbPath,
    now,
    timezone: 'America/New_York',
    localDate: '2026-07-28',
  });
  spawnRecurringTasks({
    dbPath,
    now: new Date('2026-07-28T20:00:00.000Z'),
    timezone: 'America/New_York',
    localDate: '2026-07-28',
  });
  const db = openLocalDatabase(dbPath);
  try {
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM recurring_occurrences WHERE template_id = ?').get(daily.id).n,
      1,
    );
  } finally {
    db.close();
  }
  spawnRecurringTasks({
    dbPath,
    now: new Date('2026-07-29T16:00:00.000Z'),
    timezone: 'America/New_York',
    localDate: '2026-07-29',
  });
  const verified = openLocalDatabase(dbPath);
  try {
    assert.equal(
      verified.prepare('SELECT count(*) AS n FROM recurring_occurrences WHERE template_id = ?').get(daily.id).n,
      2,
    );
  } finally {
    verified.close();
  }
});

test('daily scheduler jobs use one local-date idempotency key apiece', (t) => {
  const { dbPath } = fixture(t);
  const scheduler = new JobScheduler({
    dbPath,
    now: () => new Date('2026-07-28T16:00:00.000Z'),
  });
  t.after(() => scheduler.close());
  const now = new Date('2026-07-28T16:00:00.000Z');
  enqueueDailyTaskMaintenance(scheduler, now);
  enqueueDailyTaskMaintenance(scheduler, now);
  const jobs = scheduler.listJobs('queued');
  assert.equal(jobs.length, 3);
  assert.deepEqual(
    jobs.map((job) => job.type).sort(),
    Object.values(TASK_JOB_TYPES).sort(),
  );
  assert.equal(new Set(jobs.map((job) => job.idempotencyKey)).size, 3);
});

test('wake catch-up expires past open cards, records misses, and spawns only today', (t) => {
  const { dbPath } = fixture(t);
  createRecurringTemplate({
    title: 'Morning pages',
    cadence: 'daily',
    dbPath,
    now: new Date('2026-07-21T16:00:00.000Z'),
    timezone: 'America/Los_Angeles',
  });
  const result = spawnRecurringTasks({
    dbPath,
    now: new Date('2026-07-24T16:00:00.000Z'),
    timezone: 'America/Los_Angeles',
    localDate: '2026-07-24',
  });
  assert.deepEqual(result, { spawned: 1, missed: 3, localDate: '2026-07-24' });

  const db = openLocalDatabase(dbPath);
  try {
    assert.deepEqual(
      db.prepare(
        'SELECT occurrence_local_date AS date, state FROM recurring_occurrences ORDER BY occurrence_local_date',
      ).all(),
      [
        { date: '2026-07-21', state: 'missed' },
        { date: '2026-07-22', state: 'missed' },
        { date: '2026-07-23', state: 'missed' },
        { date: '2026-07-24', state: 'open' },
      ],
    );
    assert.equal(
      db.prepare(
        "SELECT count(*) AS n FROM tasks WHERE occurrence_local_date < '2026-07-24' AND status = 'archived'",
      ).get().n,
      1,
    );
    assert.equal(
      db.prepare(
        "SELECT count(*) AS n FROM tasks WHERE occurrence_local_date = '2026-07-24' AND status = 'open'",
      ).get().n,
      1,
    );
  } finally {
    db.close();
  }
});

test('an evening creation seeds from operator-local date and uses date-only due semantics', (t) => {
  const { dbPath } = fixture(t);
  createRecurringTemplate({
    title: 'Evening reset',
    cadence: 'daily',
    dbPath,
    now: new Date('2026-07-29T01:00:00.000Z'),
    timezone: 'America/Los_Angeles',
  });
  const db = openLocalDatabase(dbPath);
  try {
    const task = db.prepare(
      "SELECT due_at, due_date, occurrence_local_date FROM tasks WHERE source_type = 'recurring'",
    ).get();
    assert.deepEqual(task, {
      due_at: '2026-07-28',
      due_date: '2026-07-28',
      occurrence_local_date: '2026-07-28',
    });
  } finally {
    db.close();
  }
});

test('timezone disagreement records the latest zone without holding a spawn', (t) => {
  const { dbPath } = fixture(t);
  createRecurringTemplate({
    title: 'No deadlock',
    cadence: 'daily',
    dbPath,
    now: new Date('2026-07-28T16:00:00.000Z'),
    timezone: 'America/Los_Angeles',
    spawnToday: false,
  });
  assert.equal(spawnRecurringTasks({
    dbPath,
    now: new Date('2026-07-28T16:00:00.000Z'),
    timezone: 'America/Los_Angeles',
    localDate: '2026-07-28',
  }).spawned, 1);
  assert.equal(spawnRecurringTasks({
    dbPath,
    now: new Date('2026-07-28T16:01:00.000Z'),
    timezone: 'America/New_York',
    localDate: '2026-07-28',
  }).spawned, 0);
  const db = openLocalDatabase(dbPath);
  try {
    assert.deepEqual(
      db.prepare(
        'SELECT timezone, local_date, timezone_hold_local_date FROM recurrence_runtime_state',
      ).get(),
      {
        timezone: 'America/New_York',
        local_date: '2026-07-28',
        timezone_hold_local_date: null,
      },
    );
    assert.equal(db.prepare('SELECT count(*) AS n FROM recurring_occurrences').get().n, 1);
  } finally {
    db.close();
  }
});

test('future rhythm snapshots do not mutate today streak state', (t) => {
  const { dbPath } = fixture(t);
  createRecurringTemplate({
    title: 'Pure preview',
    cadence: 'daily',
    dbPath,
    now: new Date('2026-07-28T16:00:00.000Z'),
    timezone: 'America/Los_Angeles',
  });
  const db = openLocalDatabase(dbPath);
  try {
    db.prepare('UPDATE recurring_templates SET current_streak = 7').run();
  } finally {
    db.close();
  }
  recurringRhythmSnapshot({
    dbPath,
    now: new Date('2026-07-28T16:00:00.000Z'),
    timezone: 'America/Los_Angeles',
    localDate: '2026-07-29',
  });
  const verified = openLocalDatabase(dbPath);
  try {
    assert.equal(
      verified.prepare('SELECT current_streak FROM recurring_templates').get().current_streak,
      7,
    );
  } finally {
    verified.close();
  }
});

test('pausing archives today open instance and prevents it becoming a miss', (t) => {
  const { dbPath } = fixture(t);
  const now = new Date('2026-07-28T16:00:00.000Z');
  const template = createRecurringTemplate({
    title: 'Pause me',
    cadence: 'daily',
    dbPath,
    now,
    timezone: 'America/Los_Angeles',
  });
  updateRecurringTemplate({
    id: template.id,
    pausedUntil: '9999-12-31',
    dbPath,
    now,
    timezone: 'America/Los_Angeles',
  });
  const db = openLocalDatabase(dbPath);
  try {
    assert.equal(
      db.prepare("SELECT status FROM tasks WHERE source_type = 'recurring'").get().status,
      'archived',
    );
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM recurring_occurrences').get().n,
      0,
    );
  } finally {
    db.close();
  }
});

test('app-open maintenance is scheduled once per local day without blocking render', (t) => {
  const { dbPath } = fixture(t);
  const deferred = [];
  resetTaskMaintenanceScheduleForTests();
  t.after(() => resetTaskMaintenanceScheduleForTests());
  assert.equal(scheduleTaskMaintenanceCatchup({
    dbPath,
    now: new Date('2026-07-28T16:00:00.000Z'),
    defer: (run) => deferred.push(run),
  }), true);
  assert.equal(scheduleTaskMaintenanceCatchup({
    dbPath,
    now: new Date('2026-07-28T20:00:00.000Z'),
    defer: (run) => deferred.push(run),
  }), false);
  assert.equal(scheduleTaskMaintenanceCatchup({
    dbPath,
    now: new Date('2026-07-29T16:00:00.000Z'),
    defer: (run) => deferred.push(run),
  }), true);
  assert.equal(deferred.length, 2);
});

test('bulk position-only task patches skip recurrence synchronization', (t) => {
  const { dbPath } = fixture(t);
  const previousDbPath = process.env.COVE_DB_PATH;
  const previousGlobalDb = globalThis.__forgeDb;
  process.env.COVE_DB_PATH = dbPath;
  delete globalThis.__forgeDb;
  t.after(() => {
    globalThis.__forgeDb?.close();
    if (previousGlobalDb === undefined) delete globalThis.__forgeDb;
    else globalThis.__forgeDb = previousGlobalDb;
    if (previousDbPath === undefined) delete process.env.COVE_DB_PATH;
    else process.env.COVE_DB_PATH = previousDbPath;
  });
  createRecurringTemplate({
    title: 'Stay synchronized',
    cadence: 'daily',
    dbPath,
    now: new Date('2026-07-28T16:00:00.000Z'),
    timezone: 'America/Los_Angeles',
  });
  const beforeDb = openLocalDatabase(dbPath);
  const taskId = beforeDb.prepare(
    "SELECT id FROM tasks WHERE source_type = 'recurring'",
  ).get().id;
  const occurrenceBefore = beforeDb.prepare(
    'SELECT updated_at FROM recurring_occurrences WHERE task_id = ?',
  ).get(taskId).updated_at;
  beforeDb.close();

  handleLocalRest(
    'tasks',
    'PATCH',
    new URLSearchParams({ id: `eq.${taskId}` }),
    JSON.stringify({ position: 9 }),
  );
  const verified = openLocalDatabase(dbPath);
  try {
    assert.equal(
      verified.prepare(
        'SELECT updated_at FROM recurring_occurrences WHERE task_id = ?',
      ).get(taskId).updated_at,
      occurrenceBefore,
    );
  } finally {
    verified.close();
  }
});
