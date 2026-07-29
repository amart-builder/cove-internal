import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createBuddyStore } from '../src/lib/buddy/store.ts';
import { createDayPlanStore } from '../src/lib/day-plan/store.ts';
import { openLocalDatabase } from '../src/lib/local/database.ts';
import {
  LOCAL_MIGRATIONS,
  localSchemaFingerprint,
  runLocalMigrations,
} from '../src/lib/local/migrations.ts';

function tempDatabase(t, name) {
  const file = path.join(
    os.tmpdir(),
    `cove-${name}-${process.pid}-${Date.now()}-${Math.random()}.db`,
  );
  t.after(() => {
    rmSync(file, { force: true });
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
  });
  return file;
}

function initializeAllStores(file) {
  createDayPlanStore({ dbPath: file }).close();
  createBuddyStore({ dbPath: file }).close();
  openLocalDatabase(file).close();
}

test('a populated pre-migration database reaches the same schema as a fresh install', (t) => {
  const existingPath = tempDatabase(t, 'migration-existing');
  const freshPath = tempDatabase(t, 'migration-fresh');

  const legacy = new Database(existingPath);
  legacy.exec(`
    CREATE TABLE columns (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      name TEXT NOT NULL,
      position REAL NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      column_id TEXT NOT NULL REFERENCES columns(id),
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
      due_date DATE,
      tags TEXT DEFAULT '[]',
      position REAL NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      company TEXT,
      role TEXT,
      linkedin TEXT,
      location TEXT,
      tier TEXT DEFAULT 'C',
      tags TEXT DEFAULT '[]',
      how_we_met TEXT,
      notes TEXT DEFAULT '',
      last_contact_date DATE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE contact_activities (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      contact_id TEXT NOT NULL REFERENCES contacts(id),
      activity_type TEXT NOT NULL,
      title TEXT,
      content TEXT,
      metadata TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE email_items (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      thread_id TEXT,
      message_id TEXT,
      sender_name TEXT,
      sender_email TEXT,
      subject TEXT,
      summary TEXT,
      context TEXT,
      recommended_action TEXT DEFAULT 'review',
      draft_response TEXT,
      priority INTEGER DEFAULT 2,
      status TEXT DEFAULT 'pending',
      actioned_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE email_actions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      email_item_id TEXT REFERENCES email_items(id),
      action_type TEXT NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE meeting_notes (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      contact_id TEXT NOT NULL REFERENCES contacts(id),
      date DATE,
      attendees TEXT DEFAULT '[]',
      summary TEXT,
      action_items TEXT DEFAULT '[]',
      source_email_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE app_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE day_plans (
      id TEXT PRIMARY KEY,
      local_date TEXT NOT NULL UNIQUE,
      timezone TEXT NOT NULL,
      open_slot INTEGER UNIQUE CHECK (open_slot IS NULL OR open_slot = 1),
      plan_state TEXT NOT NULL CHECK (plan_state IN ('draft','proposed','active','settling','settled','abandoned')),
      arrival_state TEXT NOT NULL CHECK (arrival_state IN ('not_due','due','opened','snoozed','skipped','confirmed','bypassed','failed')),
      settlement_state TEXT NOT NULL CHECK (settlement_state IN ('not_due','offered','in_progress','skipped','committed','settled')),
      version INTEGER NOT NULL CHECK (version > 0),
      last_mutation_id TEXT,
      items_json TEXT NOT NULL,
      recommended_first_item_id TEXT,
      recommended_first_task_id TEXT,
      snoozed_until TEXT,
      next_day_note TEXT,
      confirmed_at TEXT,
      settled_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      brief_id TEXT,
      arrival_interacted_at TEXT
    );
    CREATE TABLE day_plan_assistant_turns (
      id TEXT PRIMARY KEY,
      day_plan_id TEXT NOT NULL,
      base_version INTEGER NOT NULL CHECK (base_version > 0),
      user_text TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued','running','proposed','applied','conflict','failed','cancelled')),
      proposal_json TEXT,
      result_version INTEGER,
      error_code TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      applied_at TEXT,
      FOREIGN KEY (day_plan_id) REFERENCES day_plans(id)
    );
    CREATE TABLE day_plan_task_mutations (
      id TEXT PRIMARY KEY,
      day_plan_id TEXT NOT NULL,
      assistant_turn_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('create','update','complete')),
      payload_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','applied')),
      created_at TEXT NOT NULL,
      applied_at TEXT,
      sequence INTEGER NOT NULL DEFAULT 0,
      UNIQUE (assistant_turn_id, task_id, action),
      FOREIGN KEY (day_plan_id) REFERENCES day_plans(id),
      FOREIGN KEY (assistant_turn_id) REFERENCES day_plan_assistant_turns(id)
    );
    INSERT INTO columns (id, name, position) VALUES ('legacy-column', 'To Do', 0);
    INSERT INTO tasks
      (id, column_id, title, due_date, position)
    VALUES
      ('task-1', 'legacy-column', 'Preserve live work', '2026-07-31', 0);
    INSERT INTO contacts
      (id, name, company, last_contact_date)
    VALUES
      ('contact-1', 'Legacy Contact', 'Edge AI', '2026-07-20');
    INSERT INTO contact_activities
      (id, contact_id, activity_type, title, metadata)
    VALUES
      ('activity-1', 'contact-1', 'note', 'Legacy note', '{"kept":true}');
    INSERT INTO email_items
      (id, thread_id, subject, draft_response, actioned_at)
    VALUES
      ('email-1', 'thread-1', 'Legacy email', 'Keep this draft', '2026-07-21');
    INSERT INTO email_actions
      (id, email_item_id, action_type, description)
    VALUES
      ('email-action-1', 'email-1', 'triaged', 'Legacy action');
    INSERT INTO meeting_notes
      (id, contact_id, summary)
    VALUES
      ('meeting-1', 'contact-1', 'Legacy meeting');
    INSERT INTO day_plans
      (id, local_date, timezone, open_slot, plan_state, arrival_state,
       settlement_state, version, items_json, created_at, updated_at, brief_id,
       arrival_interacted_at)
    VALUES
      ('plan-1', '2026-07-28', 'America/Los_Angeles', 1, 'draft', 'opened',
       'not_due', 1, '[]', '2026-07-28T12:00:00.000Z',
       '2026-07-28T12:00:00.000Z', 'brief-1', '2026-07-28T12:01:00.000Z');
    INSERT INTO day_plan_assistant_turns
      (id, day_plan_id, base_version, user_text, state, created_at)
    VALUES
      ('turn-1', 'plan-1', 1, 'Keep this turn', 'queued',
       '2026-07-28T12:02:00.000Z');
    INSERT INTO day_plan_task_mutations
      (id, day_plan_id, assistant_turn_id, task_id, action, payload_json,
       state, created_at, sequence)
    VALUES
      ('mutation-1', 'plan-1', 'turn-1', 'task-1', 'update', '{}',
       'pending', '2026-07-28T12:03:00.000Z', 7);
  `);
  legacy.close();

  // Build the other stores around the exact original local REST shape.
  initializeAllStores(existingPath);
  initializeAllStores(freshPath);
  const upgraded = openLocalDatabase(existingPath);
  const fresh = openLocalDatabase(freshPath);
  try {
    assert.equal(
      localSchemaFingerprint(upgraded),
      localSchemaFingerprint(fresh),
    );
    assert.equal(
      upgraded.prepare("SELECT title FROM tasks WHERE id = 'task-1'").pluck().get(),
      'Preserve live work',
    );
    assert.deepEqual(
      upgraded.prepare(
        `SELECT due_at, due_date, project, status, source_type
         FROM tasks WHERE id = 'task-1'`,
      ).get(),
      {
        due_at: '2026-07-31',
        due_date: '2026-07-31',
        project: 'Atlas',
        status: 'open',
        source_type: 'manual',
      },
    );
    assert.deepEqual(
      upgraded.prepare(
        "SELECT name, position FROM task_columns ORDER BY position, name",
      ).all(),
      [
        { name: 'Not Started', position: 0 },
        { name: 'Must happen today', position: 10 },
        { name: 'In Flight / Waiting', position: 20 },
        { name: 'Done', position: 30 },
      ],
    );
    assert.equal(
      upgraded.prepare(
        `SELECT task_columns.name
         FROM tasks
         JOIN task_columns ON task_columns.id = tasks.column_id
         WHERE tasks.id = 'task-1'`,
      ).pluck().get(),
      'Not Started',
    );
    assert.equal(
      upgraded.prepare(
        "SELECT company FROM contacts WHERE id = 'contact-1'",
      ).pluck().get(),
      'Edge AI',
    );
    assert.equal(
      upgraded.prepare(
        "SELECT metadata FROM contact_activities WHERE id = 'activity-1'",
      ).pluck().get(),
      '{"kept":true}',
    );
    assert.equal(
      upgraded.prepare(
        "SELECT draft_response FROM email_items WHERE id = 'email-1'",
      ).pluck().get(),
      'Keep this draft',
    );
    assert.equal(
      upgraded.prepare("SELECT COUNT(*) FROM email_actions").pluck().get(),
      1,
    );
    assert.equal(
      upgraded.prepare("SELECT COUNT(*) FROM meeting_notes").pluck().get(),
      1,
    );
    assert.deepEqual(
      upgraded.prepare(
        `SELECT brief_id, arrival_interacted_at
         FROM day_plans WHERE id = 'plan-1'`,
      ).get(),
      {
        brief_id: 'brief-1',
        arrival_interacted_at: '2026-07-28T12:01:00.000Z',
      },
    );
    assert.deepEqual(
      upgraded.prepare(
        `SELECT id, sequence
         FROM day_plan_task_mutations WHERE id = 'mutation-1'`,
      ).get(),
      { id: 'mutation-1', sequence: 7 },
    );
    assert.equal(
      upgraded.prepare(
        `SELECT dflt_value
         FROM pragma_table_info('day_plan_task_mutations')
         WHERE name = 'sequence'`,
      ).pluck().get(),
      null,
    );
    assert.deepEqual(
      upgraded.prepare(
        'SELECT version, name FROM forge_schema_migrations ORDER BY version',
      ).all(),
      [
        ...LOCAL_MIGRATIONS.map(({ version, name }) => ({ version, name })),
        { version: 100, name: 'day-plan-baseline' },
        { version: 101, name: 'day-plan-execution-columns' },
        { version: 102, name: 'day-plan-fable-model' },
        { version: 103, name: 'day-plan-late-columns' },
        { version: 104, name: 'day-plan-canonical-schema' },
        { version: 200, name: 'buddy-baseline' },
        { version: 201, name: 'buddy-required-columns' },
        { version: 202, name: 'buddy-indexes' },
      ],
    );
  } finally {
    upgraded.close();
    fresh.close();
  }
});

test('schema fingerprint ignores index creation order', (t) => {
  const firstPath = tempDatabase(t, 'fingerprint-index-first');
  const secondPath = tempDatabase(t, 'fingerprint-index-second');
  const first = new Database(firstPath);
  const second = new Database(secondPath);
  try {
    first.exec(`
      CREATE TABLE example (id TEXT PRIMARY KEY, first TEXT, second TEXT);
      CREATE INDEX example_first_idx ON example(first, second);
      CREATE INDEX example_second_idx ON example(second, first);
    `);
    second.exec(`
      CREATE TABLE example (id TEXT PRIMARY KEY, first TEXT, second TEXT);
      CREATE INDEX example_second_idx ON example(second, first);
      CREATE INDEX example_first_idx ON example(first, second);
    `);
    assert.equal(
      localSchemaFingerprint(first),
      localSchemaFingerprint(second),
    );
  } finally {
    first.close();
    second.close();
  }
});

test('forward migration canonicalizes columns after the first ledger was applied', (t) => {
  const file = tempDatabase(t, 'migration-forward-columns');
  const initial = openLocalDatabase(file);
  initial.prepare(
    "DELETE FROM task_columns WHERE name = 'Must happen today'",
  ).run();
  initial.prepare(
    "UPDATE task_columns SET name = 'To Do' WHERE name = 'Not Started'",
  ).run();
  initial.prepare(
    "UPDATE task_columns SET name = 'In Progress' WHERE name = 'In Flight / Waiting'",
  ).run();
  initial.prepare(
    "DELETE FROM forge_schema_migrations WHERE version = 4",
  ).run();
  initial.close();

  const upgraded = openLocalDatabase(file);
  try {
    assert.deepEqual(
      upgraded.prepare(
        "SELECT name FROM task_columns ORDER BY position, name",
      ).pluck().all(),
      [
        'Not Started',
        'Must happen today',
        'In Flight / Waiting',
        'Done',
      ],
    );
  } finally {
    upgraded.close();
  }
});

test('migrations are transactional and idempotent', (t) => {
  const file = tempDatabase(t, 'migration-idempotent');
  const db = openLocalDatabase(file);
  try {
    const before = localSchemaFingerprint(db);
    runLocalMigrations(db);
    runLocalMigrations(db);
    assert.equal(localSchemaFingerprint(db), before);
    assert.equal(
      db.prepare('SELECT COUNT(*) FROM forge_schema_migrations').pluck().get(),
      LOCAL_MIGRATIONS.length,
    );
  } finally {
    db.close();
  }
});
