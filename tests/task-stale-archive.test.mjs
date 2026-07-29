import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { handleLocalRest } from '../src/lib/local/db.ts';
import { openLocalDatabase } from '../src/lib/local/database.ts';
import { purgeArchivedTasks } from '../src/lib/tasks/archive.ts';
import { createRecurringTemplate } from '../src/lib/tasks/recurrence.ts';
import {
  detectStaleTasks,
  fileStaleTaskSuggestions,
} from '../src/lib/tasks/stale.ts';
import { writeTaskSettings } from '../src/lib/tasks/settings.ts';
import {
  getQuietCurrentSnapshot,
  setQuietCurrentStorePathForTests,
} from '../src/lib/quiet-current/store.ts';

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-stale-archive-'));
  const dbPath = path.join(dir, 'forge.db');
  const previous = process.env.COVE_DB_PATH;
  process.env.COVE_DB_PATH = dbPath;
  const db = openLocalDatabase(dbPath);
  t.after(() => {
    db.close();
    if (previous === undefined) delete process.env.COVE_DB_PATH;
    else process.env.COVE_DB_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, dbPath, db };
}

function insertTask(db, input) {
  const column = db.prepare('SELECT id FROM task_columns WHERE name = ?').get(input.column);
  db.prepare(
    `INSERT INTO tasks
       (id, column_id, title, tags, status, archived_at, created_at, updated_at)
     VALUES (?, ?, ?, '[]', ?, ?, ?, ?)`,
  ).run(
    input.id,
    column.id,
    input.title,
    input.status ?? 'open',
    input.archivedAt ?? null,
    input.updatedAt,
    input.updatedAt,
  );
}

test('stale watchdog uses exact age math and only Not Started or In Flight aliases', (t) => {
  const { dir, dbPath, db } = fixture(t);
  const now = new Date('2026-07-28T12:00:00.000Z');
  insertTask(db, {
    id: 'not-started-old',
    title: 'Old backlog',
    column: 'Not Started',
    updatedAt: '2026-07-14T12:00:00.000Z',
  });
  insertTask(db, {
    id: 'in-flight-old',
    title: 'Old flight',
    column: 'In Flight / Waiting',
    updatedAt: '2026-07-01T12:00:00.000Z',
  });
  insertTask(db, {
    id: 'today-old',
    title: 'Today is excluded',
    column: 'Must happen today',
    updatedAt: '2026-07-01T12:00:00.000Z',
  });
  insertTask(db, {
    id: 'done-old',
    title: 'Done is excluded',
    column: 'Done',
    status: 'done',
    updatedAt: '2026-07-01T12:00:00.000Z',
  });
  insertTask(db, {
    id: 'recent',
    title: 'Not old enough',
    column: 'Not Started',
    updatedAt: '2026-07-14T12:00:01.000Z',
  });
  insertTask(db, {
    id: 'archived-old',
    title: 'Archived is excluded',
    column: 'Not Started',
    status: 'archived',
    archivedAt: '2026-07-20T12:00:00.000Z',
    updatedAt: '2026-07-01T12:00:00.000Z',
  });

  assert.deepEqual(
    detectStaleTasks({ dbPath, dataDir: dir, now }).map((task) => [
      task.id,
      task.ageDays,
      task.column,
    ]),
    [
      ['in-flight-old', 27, 'in-progress'],
      ['not-started-old', 14, 'not-started'],
    ],
  );

  writeTaskSettings({ stale_after_days: 10 }, dir);
  assert.equal(detectStaleTasks({
    dbPath,
    dataDir: dir,
    now,
  }).some((task) => task.id === 'recent'), true);
});

test('stale watchdog files one pale Quiet Current check against the existing task', (t) => {
  const { dir, dbPath, db } = fixture(t);
  const quietCurrentFile = path.join(dir, 'quiet-current.json');
  setQuietCurrentStorePathForTests(quietCurrentFile);
  t.after(() => setQuietCurrentStorePathForTests());
  insertTask(db, {
    id: 'stale-for-suggestion',
    title: 'Revisit old landing page',
    column: 'Not Started',
    updatedAt: '2026-07-01T12:00:00.000Z',
  });

  const result = fileStaleTaskSuggestions({
    dbPath,
    dataDir: dir,
    now: new Date('2026-07-28T12:00:00.000Z'),
  });
  assert.equal(result.suggested, 1);
  const suggestion = getQuietCurrentSnapshot().suggestions[0];
  assert.equal(suggestion.kind, 'stale_task');
  assert.equal(suggestion.targetTaskId, 'stale-for-suggestion');
  assert.equal(suggestion.title, 'Still want “Revisit old landing page”?');
  assert.equal(
    fileStaleTaskSuggestions({
      dbPath,
      dataDir: dir,
      now: new Date('2026-07-28T12:05:00.000Z'),
    }).suggested,
    0,
  );
});

test('archive hides by default, explicit Recently deleted restores, and purge waits 30 days', (t) => {
  const { dbPath, db } = fixture(t);
  insertTask(db, {
    id: 'task-a',
    title: 'Recoverable task',
    column: 'Not Started',
    updatedAt: '2026-06-01T12:00:00.000Z',
  });

  const archiveAt = '2026-07-01T12:00:00.000Z';
  const archived = handleLocalRest(
    'tasks',
    'PATCH',
    new URLSearchParams({ id: 'eq.task-a' }),
    JSON.stringify({
      status: 'archived',
      archived_at: archiveAt,
      archived_from_status: 'open',
    }),
  );
  assert.equal(archived.status, 200);
  assert.equal(handleLocalRest(
    'tasks',
    'GET',
    new URLSearchParams({ id: 'eq.task-a' }),
    undefined,
  ).body.length, 0);
  assert.equal(handleLocalRest(
    'tasks',
    'GET',
    new URLSearchParams({ id: 'eq.task-a', status: 'eq.archived' }),
    undefined,
  ).body.length, 1);

  const restored = handleLocalRest(
    'tasks',
    'PATCH',
    new URLSearchParams({ id: 'eq.task-a' }),
    JSON.stringify({
      status: 'open',
      archived_at: null,
      archived_from_status: null,
    }),
  );
  assert.equal(restored.body[0].status, 'open');
  assert.equal(handleLocalRest(
    'tasks',
    'GET',
    new URLSearchParams({ id: 'eq.task-a' }),
    undefined,
  ).body.length, 1);

  db.prepare(
    "UPDATE tasks SET status = 'archived', archived_at = ? WHERE id = 'task-a'",
  ).run('2026-07-01T12:00:00.000Z');
  assert.equal(purgeArchivedTasks({
    dbPath,
    now: new Date('2026-07-31T11:59:59.000Z'),
  }).purged, 0);
  assert.equal(purgeArchivedTasks({
    dbPath,
    now: new Date('2026-07-31T12:00:01.000Z'),
  }).purged, 1);
});

test('every active task consumer either uses the shared hidden-by-default REST path or an explicit open-state guard', () => {
  const root = process.cwd();
  const tasksData = readFileSync(path.join(root, 'src/lib/data/tasks.ts'), 'utf8');
  const brief = readFileSync(path.join(root, 'src/lib/day-plan/brief-sources.ts'), 'utf8');
  const today = readFileSync(path.join(root, 'src/components/tasks/TodayView.tsx'), 'utf8');
  const buddy = readFileSync(path.join(root, 'scripts/cove-buddy-data.ts'), 'utf8');
  const reminders = readFileSync(path.join(root, 'scripts/cove-reminders.mjs'), 'utf8');
  const detail = readFileSync(path.join(root, 'src/components/tasks/TaskDetail.tsx'), 'utf8');
  const recentlyDeleted = readFileSync(
    path.join(root, 'src/components/tasks/RecentlyDeleted.tsx'),
    'utf8',
  );

  assert.match(tasksData, /status: "neq\.archived"/);
  assert.match(brief, /fetchRows\(fetchImpl, baseUrl, "tasks"/);
  assert.match(brief, /row\.status !== "open"/);
  assert.match(today, /task\.status !== 'archived'/);
  assert.match(today, /suggestion\.kind === 'stale_task'[\s\S]*source === 'explicit_accept'[\s\S]*updateTask\(targetTask\._id, \{\}\)/);
  assert.match(buddy, /api\/forge-rest/);
  assert.match(reminders, /status = 'open'/);
  assert.match(detail, /!localMode && !window\.confirm\(/);
  assert.match(detail, /localMode && task\.proposedRecurrenceCadence/);
  assert.match(recentlyDeleted, /confirm\(`Permanently delete/);
});

test('local Drop stamps archive time and legacy undated rows use updated time for display and purge', (t) => {
  const { dbPath, db } = fixture(t);
  insertTask(db, {
    id: 'drop-now',
    title: 'Drop now',
    column: 'Must happen today',
    updatedAt: '2026-07-28T12:00:00.000Z',
  });
  const dropped = handleLocalRest(
    'tasks',
    'PATCH',
    new URLSearchParams({ id: 'eq.drop-now' }),
    JSON.stringify({ status: 'archived' }),
  );
  assert.ok(dropped.body[0].archived_at);
  assert.equal(dropped.body[0].archived_from_status, 'open');

  insertTask(db, {
    id: 'legacy-drop',
    title: 'Legacy drop',
    column: 'Not Started',
    status: 'archived',
    archivedAt: null,
    updatedAt: '2026-06-01T12:00:00.000Z',
  });
  const archived = handleLocalRest(
    'tasks',
    'GET',
    new URLSearchParams({ status: 'eq.archived' }),
    undefined,
  ).body;
  const legacy = archived.find((task) => task.id === 'legacy-drop');
  assert.equal(legacy.archived_at, null);
  assert.equal(legacy.updated_at, '2026-06-01T12:00:00.000Z');
  assert.equal(purgeArchivedTasks({
    dbPath,
    now: new Date('2026-07-28T12:00:00.000Z'),
  }).purged, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tasks WHERE id = 'legacy-drop'").get().n, 0);
});

test('SQLite enables foreign keys and task purge nulls recurring occurrence links', (t) => {
  const { dbPath } = fixture(t);
  const pragmaDb = openLocalDatabase(dbPath);
  try {
    assert.equal(pragmaDb.pragma('foreign_keys', { simple: true }), 1);
  } finally {
    pragmaDb.close();
  }
  createRecurringTemplate({
    title: 'FK rhythm',
    cadence: 'daily',
    dbPath,
    now: new Date('2026-06-01T12:00:00.000Z'),
    timezone: 'UTC',
  });
  const db = openLocalDatabase(dbPath);
  try {
    const task = db.prepare(
      "SELECT id FROM tasks WHERE source_type = 'recurring'",
    ).get();
    db.prepare(
      `UPDATE tasks
       SET status = 'archived', archived_at = '2026-06-01T12:00:00.000Z',
           updated_at = '2026-06-01T12:00:00.000Z'
       WHERE id = ?`,
    ).run(task.id);
  } finally {
    db.close();
  }
  assert.equal(purgeArchivedTasks({
    dbPath,
    now: new Date('2026-07-28T12:00:00.000Z'),
  }).purged, 1);
  const verified = openLocalDatabase(dbPath);
  try {
    assert.equal(
      verified.prepare('SELECT task_id FROM recurring_occurrences').get().task_id,
      null,
    );
  } finally {
    verified.close();
  }
});
