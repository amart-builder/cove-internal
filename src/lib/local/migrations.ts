import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { TASK_COLUMNS } from "../tasks/columns";

export type LocalMigration = {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
  foreignKeysOff?: boolean;
  legacyAlterTable?: boolean;
};

const CANONICAL_TASKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  column_id TEXT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  priority TEXT DEFAULT 'medium',
  due_at TEXT,
  due_date TEXT,
  tags TEXT DEFAULT '[]',
  project TEXT NOT NULL DEFAULT 'Atlas',
  position REAL DEFAULT 0,
  status TEXT DEFAULT 'open',
  source_type TEXT DEFAULT 'manual',
  remind_native INTEGER DEFAULT 1,
  remind_text INTEGER DEFAULT 0,
  notified_at TEXT,
  created_at TEXT,
  updated_at TEXT
);`;

const CANONICAL_CONTACTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  company_id TEXT,
  company TEXT,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  role TEXT,
  linkedin TEXT,
  location TEXT,
  how_we_met TEXT,
  tier TEXT DEFAULT 'C',
  tags TEXT DEFAULT '[]',
  notes TEXT DEFAULT '',
  last_interaction_at TEXT,
  last_contact_date TEXT,
  created_at TEXT,
  updated_at TEXT
);`;

const CANONICAL_CONTACT_ACTIVITIES_SCHEMA = `
CREATE TABLE IF NOT EXISTS contact_activities (
  id TEXT PRIMARY KEY,
  contact_id TEXT,
  company_id TEXT,
  activity_type TEXT,
  title TEXT,
  content TEXT,
  direction TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT,
  updated_at TEXT
);`;

const CANONICAL_EMAIL_ITEMS_SCHEMA = `
CREATE TABLE IF NOT EXISTS email_items (
  id TEXT PRIMARY KEY,
  contact_id TEXT,
  company_id TEXT,
  message_id TEXT,
  thread_id TEXT,
  classification TEXT,
  status TEXT DEFAULT 'pending',
  sender_name TEXT,
  sender_email TEXT,
  subject TEXT,
  body_excerpt TEXT,
  summary TEXT,
  context TEXT,
  source_payload TEXT,
  recommended_action TEXT,
  draft_response TEXT,
  priority INTEGER DEFAULT 0,
  received_at TEXT,
  account_email TEXT,
  actioned_at TEXT,
  created_at TEXT,
  updated_at TEXT
);`;

const COMPAT_EMAIL_ACTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS email_actions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  email_item_id TEXT REFERENCES email_items(id),
  action_type TEXT NOT NULL,
  description TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);`;

const COMPAT_MEETING_NOTES_SCHEMA = `
CREATE TABLE IF NOT EXISTS meeting_notes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  date DATE,
  attendees TEXT DEFAULT '[]',
  summary TEXT,
  action_items TEXT DEFAULT '[]',
  source_email_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);`;

// Frozen by the migration ledger: edits affect fresh installs only; changes require a new migration.
const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS task_columns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);
${CANONICAL_TASKS_SCHEMA}
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT,
  website TEXT,
  industry TEXT,
  location TEXT,
  linkedin TEXT,
  description TEXT,
  tags TEXT DEFAULT '[]',
  notes TEXT DEFAULT '',
  last_interaction_at TEXT,
  created_at TEXT,
  updated_at TEXT
);
${CANONICAL_CONTACTS_SCHEMA}
${CANONICAL_CONTACT_ACTIVITIES_SCHEMA}
${CANONICAL_EMAIL_ITEMS_SCHEMA}
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  email_item_id TEXT,
  subject TEXT,
  body TEXT DEFAULT '',
  status TEXT DEFAULT 'needs_review',
  voice_version TEXT,
  humanizer_version TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS email_action_log (
  id TEXT PRIMARY KEY,
  email_item_id TEXT,
  action_type TEXT,
  description TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS email_triage_runs (
  id TEXT PRIMARY KEY,
  summary TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS commitments (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('follow_up','promise','waiting_on','open_decision','overnight_request','idea')),
  title TEXT NOT NULL,
  details TEXT,
  counterparty TEXT,
  contact_id TEXT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('brain_dump','manual','chat','detector','brief')),
  source_quote TEXT,
  source_ref TEXT,
  due_at TEXT,
  review_at TEXT,
  confidence TEXT NOT NULL DEFAULT 'high' CHECK (confidence IN ('high','medium','low')),
  confirmed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dropped','expired')),
  evidence TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS commitments_status_due_at_idx
  ON commitments(status, due_at);
CREATE INDEX IF NOT EXISTS commitments_status_review_at_idx
  ON commitments(status, review_at);
CREATE TABLE IF NOT EXISTS inbound_events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  machine TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','triaged','failed','dismissed')),
  task_id TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS inbound_events_state_created_at_idx
  ON inbound_events(state, created_at);

-- Compatibility tables from the original local Cove database. They stay so
-- an existing install never loses a table during the in-place upgrade.
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS columns (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  name TEXT NOT NULL,
  position REAL NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
${COMPAT_EMAIL_ACTIONS_SCHEMA}
${COMPAT_MEETING_NOTES_SCHEMA}
`;

function columns(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[])
      .map((column) => column.name),
  );
}

function canonicalizeTaskColumns(
  db: Database.Database,
  seedMissing: boolean,
): void {
  const taskColumns = columns(db, "tasks");
  for (const canonical of TASK_COLUMNS) {
    const aliases = new Set(
      canonical.aliases.map((alias) => alias.toLowerCase()),
    );
    const matching = (db.prepare(
      "SELECT id, name FROM task_columns ORDER BY position, id",
    ).all() as Array<{ id: string; name: string }>).filter((row) =>
      aliases.has(row.name.toLowerCase())
    );
    if (matching.length === 0) {
      if (seedMissing) {
        db.prepare(
          `INSERT INTO task_columns
             (id, name, position, is_default, created_at, updated_at)
           VALUES (?, ?, ?, 1, NULL, NULL)`,
        ).run(randomUUID(), canonical.name, canonical.position);
      }
      continue;
    }
    const winner = matching.find((row) => row.name === canonical.name) ??
      matching[0];
    for (const duplicate of matching) {
      if (duplicate.id === winner.id) continue;
      if (taskColumns.has("column_id")) {
        db.prepare(
          "UPDATE tasks SET column_id = ? WHERE column_id = ?",
        ).run(winner.id, duplicate.id);
      }
      db.prepare("DELETE FROM task_columns WHERE id = ?").run(duplicate.id);
    }
    db.prepare(
      `UPDATE task_columns
       SET name = ?, position = ?, is_default = 1
       WHERE id = ?`,
    ).run(canonical.name, canonical.position, winner.id);
  }
}

export const LOCAL_MIGRATIONS: readonly LocalMigration[] = [
  {
    version: 1,
    name: "local-rest-baseline",
    up: (db) => db.exec(BASE_SCHEMA),
  },
  {
    version: 2,
    name: "local-rest-legacy-shape",
    foreignKeysOff: true,
    up: (db) => {
      const hasAll = (table: string, required: string[]) => {
        const existing = columns(db, table);
        return required.every((column) => existing.has(column));
      };
      const value = (
        existing: Set<string>,
        column: string,
        fallback = "NULL",
      ) => existing.has(column) ? `"${column}"` : fallback;

      const taskColumns = columns(db, "tasks");
      const canonicalColumn = (name: string) => TASK_COLUMNS.find((candidate) =>
        candidate.aliases.some(
          (alias) => alias.toLowerCase() === name.toLowerCase(),
        )
      );
      canonicalizeTaskColumns(db, false);

      // The first local database used `columns`; map its aliases through the
      // shared canonical lane vocabulary before rebuilding task rows.
      db.exec(`
        CREATE TEMP TABLE forge_legacy_column_map (
          legacy_id TEXT PRIMARY KEY,
          target_id TEXT NOT NULL
        )
      `);
      const legacyColumns = db.prepare(
        "SELECT id, name, position, created_at FROM columns ORDER BY position, id",
      ).all() as Array<{
        id: string;
        name: string;
        position: number;
        created_at: string | null;
      }>;
      const insertColumn = db.prepare(
        `INSERT INTO task_columns
           (id, name, position, is_default, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
      );
      const insertMap = db.prepare(
        "INSERT INTO forge_legacy_column_map (legacy_id, target_id) VALUES (?, ?)",
      );
      for (const legacy of legacyColumns) {
        const canonical = canonicalColumn(legacy.name);
        const name = canonical?.name ?? legacy.name;
        const position = canonical?.position ?? Math.trunc(legacy.position);
        let target = db.prepare(
          "SELECT id FROM task_columns WHERE lower(name) = lower(?) ORDER BY position, id LIMIT 1",
        ).get(name) as { id: string } | undefined;
        if (!target) {
          const idTaken = db.prepare(
            "SELECT 1 FROM task_columns WHERE id = ?",
          ).get(legacy.id);
          target = { id: idTaken ? randomUUID() : legacy.id };
          insertColumn.run(
            target.id,
            name,
            position,
            legacy.created_at,
            legacy.created_at,
          );
        }
        insertMap.run(legacy.id, target.id);
      }
      if (legacyColumns.length > 0) {
        canonicalizeTaskColumns(db, true);
      }
      if (taskColumns.has("column_id")) {
        db.exec(`
          UPDATE tasks
          SET column_id = (
            SELECT target_id
            FROM forge_legacy_column_map
            WHERE legacy_id = tasks.column_id
          )
          WHERE column_id IN (SELECT legacy_id FROM forge_legacy_column_map)
        `);
      }

      if (!hasAll("tasks", [
        "due_at", "due_date", "project", "status", "source_type",
        "remind_native", "remind_text", "notified_at",
      ])) {
        db.exec("ALTER TABLE tasks RENAME TO tasks_migration_legacy");
        db.exec(CANONICAL_TASKS_SCHEMA);
        db.exec(`
          INSERT INTO tasks
            (id, column_id, title, description, priority, due_at, due_date,
             tags, project, position, status, source_type, remind_native,
             remind_text, notified_at, created_at, updated_at)
          SELECT
            ${value(taskColumns, "id")},
            ${value(taskColumns, "column_id")},
            ${value(taskColumns, "title", "''")},
            ${value(taskColumns, "description", "''")},
            ${value(taskColumns, "priority", "'medium'")},
            ${value(taskColumns, "due_at", value(taskColumns, "due_date"))},
            ${value(taskColumns, "due_date", value(taskColumns, "due_at"))},
            ${value(taskColumns, "tags", "'[]'")},
            ${value(taskColumns, "project", "'Atlas'")},
            ${value(taskColumns, "position", "0")},
            ${value(taskColumns, "status", "'open'")},
            ${value(taskColumns, "source_type", "'manual'")},
            ${value(taskColumns, "remind_native", "1")},
            ${value(taskColumns, "remind_text", "0")},
            ${value(taskColumns, "notified_at")},
            ${value(taskColumns, "created_at")},
            ${value(taskColumns, "updated_at")}
          FROM tasks_migration_legacy;
          DROP TABLE tasks_migration_legacy;
        `);
      }
      db.exec("DROP TABLE forge_legacy_column_map");
      db.exec("UPDATE tasks SET project = 'Atlas' WHERE project IS NULL");
      db.exec(
        "CREATE INDEX IF NOT EXISTS tasks_project_status_idx ON tasks(project, status)",
      );

      const commitmentColumns = columns(db, "commitments");
      if (!commitmentColumns.has("confirmed")) {
        db.exec(
          "ALTER TABLE commitments ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0",
        );
      }

      const contactColumns = columns(db, "contacts");
      const rebuildContacts = !hasAll("contacts", [
        "company_id", "company", "last_interaction_at", "last_contact_date",
      ]);
      if (rebuildContacts) {
        db.exec("ALTER TABLE contacts RENAME TO contacts_migration_legacy");
        db.exec(CANONICAL_CONTACTS_SCHEMA);
        db.exec(`
          INSERT INTO contacts
            (id, company_id, company, name, email, phone, role, linkedin,
             location, how_we_met, tier, tags, notes, last_interaction_at,
             last_contact_date, created_at, updated_at)
          SELECT
            ${value(contactColumns, "id")},
            ${value(contactColumns, "company_id")},
            ${value(contactColumns, "company")},
            ${value(contactColumns, "name", "''")},
            ${value(contactColumns, "email")},
            ${value(contactColumns, "phone")},
            ${value(contactColumns, "role")},
            ${value(contactColumns, "linkedin")},
            ${value(contactColumns, "location")},
            ${value(contactColumns, "how_we_met")},
            ${value(contactColumns, "tier", "'C'")},
            ${value(contactColumns, "tags", "'[]'")},
            ${value(contactColumns, "notes", "''")},
            ${value(
              contactColumns,
              "last_interaction_at",
              value(contactColumns, "last_contact_date"),
            )},
            ${value(
              contactColumns,
              "last_contact_date",
              value(contactColumns, "last_interaction_at"),
            )},
            ${value(contactColumns, "created_at")},
            ${value(contactColumns, "updated_at")}
          FROM contacts_migration_legacy;
          DROP TABLE contacts_migration_legacy;
        `);
      }

      const activityColumns = columns(db, "contact_activities");
      if (!hasAll("contact_activities", [
        "company_id", "direction", "metadata", "updated_at",
      ])) {
        db.exec(
          "ALTER TABLE contact_activities RENAME TO contact_activities_migration_legacy",
        );
        db.exec(CANONICAL_CONTACT_ACTIVITIES_SCHEMA);
        db.exec(`
          INSERT INTO contact_activities
            (id, contact_id, company_id, activity_type, title, content,
             direction, metadata, created_at, updated_at)
          SELECT
            ${value(activityColumns, "id")},
            ${value(activityColumns, "contact_id")},
            ${value(activityColumns, "company_id")},
            ${value(activityColumns, "activity_type")},
            ${value(activityColumns, "title")},
            ${value(activityColumns, "content")},
            ${value(activityColumns, "direction")},
            ${value(activityColumns, "metadata", "'{}'")},
            ${value(activityColumns, "created_at")},
            ${value(activityColumns, "updated_at")}
          FROM contact_activities_migration_legacy;
          DROP TABLE contact_activities_migration_legacy;
        `);
      }

      const emailColumns = columns(db, "email_items");
      const rebuildEmailItems = !hasAll("email_items", [
        "contact_id", "company_id", "classification", "body_excerpt",
        "source_payload", "received_at", "account_email", "draft_response",
        "actioned_at", "updated_at",
      ]);
      if (rebuildEmailItems) {
        db.exec("ALTER TABLE email_items RENAME TO email_items_migration_legacy");
        db.exec(CANONICAL_EMAIL_ITEMS_SCHEMA);
        db.exec(`
          INSERT INTO email_items
            (id, contact_id, company_id, message_id, thread_id, classification,
             status, sender_name, sender_email, subject, body_excerpt, summary,
             context, source_payload, recommended_action, draft_response,
             priority, received_at, account_email, actioned_at, created_at,
             updated_at)
          SELECT
            ${value(emailColumns, "id")},
            ${value(emailColumns, "contact_id")},
            ${value(emailColumns, "company_id")},
            ${value(emailColumns, "message_id")},
            ${value(emailColumns, "thread_id")},
            ${value(emailColumns, "classification")},
            ${value(emailColumns, "status", "'pending'")},
            ${value(emailColumns, "sender_name")},
            ${value(emailColumns, "sender_email")},
            ${value(emailColumns, "subject")},
            ${value(emailColumns, "body_excerpt")},
            ${value(emailColumns, "summary")},
            ${value(emailColumns, "context")},
            ${value(emailColumns, "source_payload")},
            ${value(emailColumns, "recommended_action")},
            ${value(emailColumns, "draft_response")},
            ${value(emailColumns, "priority", "0")},
            ${value(emailColumns, "received_at")},
            ${value(emailColumns, "account_email")},
            ${value(emailColumns, "actioned_at")},
            ${value(emailColumns, "created_at")},
            ${value(emailColumns, "updated_at")}
          FROM email_items_migration_legacy;
          DROP TABLE email_items_migration_legacy;
        `);
      }

      // SQLite propagates a renamed parent table into foreign-key metadata.
      // Rebuild these two compatibility tables after their parent so a live
      // upgrade and a fresh install both reference the canonical table name.
      if (rebuildContacts) {
        db.exec("ALTER TABLE meeting_notes RENAME TO meeting_notes_migration_legacy");
        db.exec(COMPAT_MEETING_NOTES_SCHEMA);
        db.exec(`
          INSERT INTO meeting_notes
            (id, contact_id, date, attendees, summary, action_items,
             source_email_id, created_at)
          SELECT id, contact_id, date, attendees, summary, action_items,
                 source_email_id, created_at
          FROM meeting_notes_migration_legacy;
          DROP TABLE meeting_notes_migration_legacy;
        `);
      }
      if (rebuildEmailItems) {
        db.exec("ALTER TABLE email_actions RENAME TO email_actions_migration_legacy");
        db.exec(COMPAT_EMAIL_ACTIONS_SCHEMA);
        db.exec(`
          INSERT INTO email_actions
            (id, email_item_id, action_type, description, created_at)
          SELECT id, email_item_id, action_type, description, created_at
          FROM email_actions_migration_legacy;
          DROP TABLE email_actions_migration_legacy;
        `);
      }
    },
  },
  {
    version: 3,
    name: "reliability-spine",
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS forge_jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        priority INTEGER NOT NULL DEFAULT 0,
        run_after TEXT NOT NULL,
        lease_until TEXT,
        lease_token TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued','leased','done','failed','dead')),
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        finished_at TEXT,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS forge_jobs_ready_idx
        ON forge_jobs(status, priority DESC, run_after);
      CREATE INDEX IF NOT EXISTS forge_jobs_lease_idx
        ON forge_jobs(status, lease_until);

      CREATE TABLE IF NOT EXISTS forge_receipts (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        summary TEXT NOT NULL,
        actions_json TEXT NOT NULL DEFAULT '{}',
        retry_count INTEGER NOT NULL DEFAULT 0,
        outcome TEXT NOT NULL
          CHECK (outcome IN ('success','partial','failed','skipped')),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS forge_receipts_recent_idx
        ON forge_receipts(finished_at DESC);
      CREATE INDEX IF NOT EXISTS forge_receipts_source_idx
        ON forge_receipts(source, finished_at DESC);

      CREATE TABLE IF NOT EXISTS forge_failure_inbox (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        message TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        occurred_at TEXT NOT NULL,
        dismissed_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (source, source_id)
      );
      CREATE INDEX IF NOT EXISTS forge_failure_inbox_open_idx
        ON forge_failure_inbox(dismissed_at, occurred_at DESC);
    `),
  },
  {
    version: 4,
    name: "canonical-task-columns",
    up: (db) => canonicalizeTaskColumns(db, true),
  },
];

export function runLocalMigrations(
  db: Database.Database,
  now: () => Date = () => new Date(),
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS forge_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  for (const migration of LOCAL_MIGRATIONS) {
    applyLocalMigration(db, migration, now);
  }
}

export function applyLocalMigration(
  db: Database.Database,
  migration: LocalMigration,
  now: () => Date = () => new Date(),
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS forge_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const alreadyApplied = db.prepare(
    "SELECT 1 FROM forge_schema_migrations WHERE version = ?",
  );
  if (alreadyApplied.get(migration.version)) return;

  const foreignKeysWereEnabled = Number(
    db.pragma("foreign_keys", { simple: true }),
  ) === 1;
  const legacyAlterTableWasEnabled = Number(
    db.pragma("legacy_alter_table", { simple: true }),
  ) === 1;
  if (migration.foreignKeysOff && foreignKeysWereEnabled) {
    db.pragma("foreign_keys = OFF");
  }
  if (migration.legacyAlterTable && !legacyAlterTableWasEnabled) {
    db.pragma("legacy_alter_table = ON");
  }
  try {
    db.transaction(() => {
      // Another Cove process may have applied it while this connection waited
      // for SQLite's write lock. Recheck inside the immediate transaction.
      if (alreadyApplied.get(migration.version)) return;
      migration.up(db);
      db.prepare(
        "INSERT INTO forge_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(migration.version, migration.name, now().toISOString());
    }).immediate();
  } finally {
    if (migration.foreignKeysOff && foreignKeysWereEnabled) {
      db.pragma("foreign_keys = ON");
    }
    if (migration.legacyAlterTable && !legacyAlterTableWasEnabled) {
      db.pragma("legacy_alter_table = OFF");
    }
  }
}

export function localSchemaFingerprint(db: Database.Database): string {
  const normalizeSql = (sql: string | null) =>
    sql
      ?.replace(/\bIF\s+NOT\s+EXISTS\b/gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase() ?? null;
  const checkClauses = (sql: string | null): string[] => {
    if (!sql) return [];
    const checks: string[] = [];
    const upper = sql.toUpperCase();
    let cursor = 0;
    while ((cursor = upper.indexOf("CHECK", cursor)) >= 0) {
      const open = sql.indexOf("(", cursor + 5);
      if (open < 0) break;
      let depth = 0;
      let end = open;
      for (; end < sql.length; end += 1) {
        if (sql[end] === "(") depth += 1;
        else if (sql[end] === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      checks.push(
        sql.slice(open + 1, end).replace(/\s+/g, " ").trim().toLowerCase(),
      );
      cursor = end + 1;
    }
    return checks.sort();
  };
  const objects = db.prepare(
    `SELECT type, name, tbl_name, sql
     FROM sqlite_schema
     WHERE name NOT LIKE 'sqlite_%'
     ORDER BY type, name`,
  ).all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
  const snapshot = objects.map((object) => {
    if (object.type === "table") {
      const indexes = (db.prepare(
        `PRAGMA index_list("${object.name}")`,
      ).all() as Array<{
        name: string;
        unique: number;
        origin: string;
        partial: number;
      }>)
        .sort((left, right) => left.name.localeCompare(right.name));
      return {
        type: object.type,
        name: object.name,
        tbl_name: object.tbl_name,
        columns: db.prepare(`PRAGMA table_info("${object.name}")`).all(),
        foreignKeys: db.prepare(
          `PRAGMA foreign_key_list("${object.name}")`,
        ).all(),
        checks: checkClauses(object.sql),
        indexes: indexes.map((index) => ({
          name: index.name,
          unique: index.unique,
          origin: index.origin,
          partial: index.partial,
          columns: (db.prepare(
            `PRAGMA index_xinfo("${index.name}")`,
          ).all() as Array<{ name: string | null; seqno: number }>)
            .sort((left, right) =>
              (left.name ?? "").localeCompare(right.name ?? "") ||
              left.seqno - right.seqno
            ),
          sql: normalizeSql(
            (db.prepare(
              "SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?",
            ).get(index.name) as { sql: string | null } | undefined)?.sql ?? null,
          ),
        })),
      };
    }
    return { ...object, sql: normalizeSql(object.sql) };
  });
  return JSON.stringify(snapshot);
}
