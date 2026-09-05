import { FOLLOW_THROUGH_SCHEMA } from "../attention/follow-through.mjs";
import { BACKGROUND_USAGE_SCHEMA } from "../background-usage.mjs";
import { RESPONSIBILITY_SCHEMA } from "../responsibility/store";
/**
 * Ordered, append-only schema history for Cove's local SQLite database.
 *
 * Fresh databases and upgraded databases both pass through this list. Never
 * rewrite an applied version to change history. Add a new migration and cover
 * both starting shapes in tests. Some legacy table rebuilds temporarily change
 * foreign-key behavior; those exceptions are declared on the migration rather
 * than hidden inside generic migration code.
 */
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  normalizeContactEmail,
  normalizeContactName,
} from "../crm/identity";
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
        CREATE TEMP TABLE cove_legacy_column_map (
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
        "INSERT INTO cove_legacy_column_map (legacy_id, target_id) VALUES (?, ?)",
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
            FROM cove_legacy_column_map
            WHERE legacy_id = tasks.column_id
          )
          WHERE column_id IN (SELECT legacy_id FROM cove_legacy_column_map)
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
      db.exec("DROP TABLE cove_legacy_column_map");
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
      CREATE TABLE IF NOT EXISTS cove_jobs (
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
      CREATE INDEX IF NOT EXISTS cove_jobs_ready_idx
        ON cove_jobs(status, priority DESC, run_after);
      CREATE INDEX IF NOT EXISTS cove_jobs_lease_idx
        ON cove_jobs(status, lease_until);

      CREATE TABLE IF NOT EXISTS cove_receipts (
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
      CREATE INDEX IF NOT EXISTS cove_receipts_recent_idx
        ON cove_receipts(finished_at DESC);
      CREATE INDEX IF NOT EXISTS cove_receipts_source_idx
        ON cove_receipts(source, finished_at DESC);

      CREATE TABLE IF NOT EXISTS cove_failure_inbox (
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
      CREATE INDEX IF NOT EXISTS cove_failure_inbox_open_idx
        ON cove_failure_inbox(dismissed_at, occurred_at DESC);
    `),
  },
  {
    version: 4,
    name: "canonical-task-columns",
    up: (db) => canonicalizeTaskColumns(db, true),
  },
  {
    version: 5,
    name: "crm-identity-resolution",
    up: (db) => {
      const contactColumns = columns(db, "contacts");
      if (!contactColumns.has("normalized_name")) {
        db.exec("ALTER TABLE contacts ADD COLUMN normalized_name TEXT");
      }
      if (!contactColumns.has("normalized_email")) {
        db.exec("ALTER TABLE contacts ADD COLUMN normalized_email TEXT");
      }
      if (!contactColumns.has("provenance_source")) {
        db.exec("ALTER TABLE contacts ADD COLUMN provenance_source TEXT");
      }

      const rows = db.prepare(
        "SELECT id, name, email FROM contacts",
      ).all() as Array<{
        id: string;
        name: string | null;
        email: string | null;
      }>;
      const update = db.prepare(
        `UPDATE contacts
         SET normalized_name = ?, normalized_email = ?
         WHERE id = ?`,
      );
      for (const row of rows) {
        update.run(
          normalizeContactName(row.name ?? ""),
          normalizeContactEmail(row.email ?? undefined),
          row.id,
        );
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS contacts_normalized_email_idx
          ON contacts(normalized_email);
        CREATE INDEX IF NOT EXISTS contacts_normalized_name_idx
          ON contacts(normalized_name);
      `);
    },
  },
  {
    version: 6,
    name: "shared-meeting-ingestion",
    up: (db) => {
      const activityColumns = columns(db, "contact_activities");
      if (!activityColumns.has("source_ref")) {
        db.exec("ALTER TABLE contact_activities ADD COLUMN source_ref TEXT");
      }
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS contact_activities_source_ref_idx
          ON contact_activities(source_ref)
          WHERE source_ref IS NOT NULL;

        CREATE TABLE IF NOT EXISTS cove_message_ingestion (
          message_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          source_door TEXT NOT NULL
            CHECK (source_door IN ('watcher','triage')),
          detected_tool TEXT NOT NULL,
          status TEXT NOT NULL
            CHECK (status IN ('processing','retry','processed','failed')),
          lease_token TEXT,
          lease_until TEXT,
          attempts INTEGER NOT NULL DEFAULT 1,
          processed_at TEXT,
          outcome TEXT,
          receipt_id TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS cove_message_ingestion_status_lease_idx
          ON cove_message_ingestion(status, lease_until);
        CREATE INDEX IF NOT EXISTS cove_message_ingestion_receipt_idx
          ON cove_message_ingestion(receipt_id);
      `);
    },
  },
  {
    version: 7,
    name: "task-rhythms-stale-and-archive",
    up: (db) => {
      const taskColumns = columns(db, "tasks");
      if (!taskColumns.has("archived_at")) {
        db.exec("ALTER TABLE tasks ADD COLUMN archived_at TEXT");
      }
      if (!taskColumns.has("archived_from_status")) {
        db.exec("ALTER TABLE tasks ADD COLUMN archived_from_status TEXT");
      }
      if (!taskColumns.has("proposed_recurrence_cadence")) {
        db.exec("ALTER TABLE tasks ADD COLUMN proposed_recurrence_cadence TEXT");
      }
      if (!taskColumns.has("recurring_template_id")) {
        db.exec("ALTER TABLE tasks ADD COLUMN recurring_template_id TEXT");
      }
      if (!taskColumns.has("occurrence_local_date")) {
        db.exec("ALTER TABLE tasks ADD COLUMN occurrence_local_date TEXT");
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS recurring_templates (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT,
          cadence TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
          paused_until TEXT,
          last_spawned_local_date TEXT,
          current_streak INTEGER NOT NULL DEFAULT 0,
          last_missed_local_date TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS recurring_templates_active_idx
          ON recurring_templates(active, paused_until);

        CREATE TABLE IF NOT EXISTS recurring_occurrences (
          id TEXT PRIMARY KEY,
          template_id TEXT NOT NULL REFERENCES recurring_templates(id),
          occurrence_local_date TEXT NOT NULL,
          task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
          state TEXT NOT NULL
            CHECK (state IN ('open','completed','missed')),
          completed_at TEXT,
          missed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (template_id, occurrence_local_date)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS recurring_occurrences_task_idx
          ON recurring_occurrences(task_id)
          WHERE task_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS recurring_occurrences_template_date_idx
          ON recurring_occurrences(template_id, occurrence_local_date DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS tasks_recurring_occurrence_idx
          ON tasks(recurring_template_id, occurrence_local_date)
          WHERE recurring_template_id IS NOT NULL
            AND occurrence_local_date IS NOT NULL;

        CREATE TABLE IF NOT EXISTS recurrence_runtime_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          timezone TEXT NOT NULL,
          local_date TEXT NOT NULL,
          timezone_hold_local_date TEXT,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 8,
    name: "stamp-legacy-archived-tasks",
    up: (db) => {
      // Settlement "Drop" wrote status=archived with no archived_at long before
      // Recently deleted existed. Stamp those rows at migration time so every
      // legacy drop gets a full 30-day window in Recently deleted instead of
      // being purged on the first sweep.
      db.prepare(
        `UPDATE tasks
         SET archived_at = ?
         WHERE status = 'archived'
           AND (archived_at IS NULL OR archived_at = '')`,
      ).run(new Date().toISOString());
    },
  },
  {
    version: 9,
    name: "email-automation-and-health-collectors",
    up: (db) => {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS commitments_email_quote_idx
          ON commitments(source_ref, source_quote, kind)
          WHERE source_ref LIKE 'gmail:%'
            AND source_quote IS NOT NULL;

        CREATE TABLE IF NOT EXISTS cove_health_snapshots (
          id TEXT PRIMARY KEY,
          collected_at TEXT NOT NULL,
          collector_version INTEGER NOT NULL,
          system_json TEXT NOT NULL,
          adoption_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS cove_health_snapshots_collected_idx
          ON cove_health_snapshots(collected_at DESC, id);
      `);
    },
  },
  {
    version: 10,
    name: "task-session-runs-and-child-process-registry",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS cove_task_session_runs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          day_plan_id TEXT,
          item_id TEXT,
          owner TEXT NOT NULL CHECK (owner IN ('claude','together')),
          permission_mode TEXT NOT NULL CHECK (permission_mode IN ('acceptEdits','plan')),
          status TEXT NOT NULL
            CHECK (status IN ('running','awaiting_approval','failed','output_ready','abandoned')),
          claude_session_id TEXT NOT NULL UNIQUE,
          pid INTEGER,
          server_pid INTEGER NOT NULL,
          output_dir TEXT NOT NULL,
          resume_url TEXT NOT NULL,
          prompt_json TEXT NOT NULL,
          result_summary TEXT,
          hint TEXT,
          error_code TEXT,
          exit_code INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          finished_at TEXT
        );
        CREATE INDEX IF NOT EXISTS cove_task_session_runs_task_idx
          ON cove_task_session_runs(task_id, created_at DESC, id DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS cove_task_session_runs_one_live_task
          ON cove_task_session_runs(task_id)
          WHERE status IN ('running','awaiting_approval');

        CREATE TABLE IF NOT EXISTS cove_spawned_children (
          id TEXT PRIMARY KEY,
          lane TEXT NOT NULL CHECK (lane IN ('brief','dump','execution','session')),
          run_id TEXT NOT NULL,
          pid INTEGER NOT NULL,
          server_pid INTEGER NOT NULL,
          executable TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('active','completed','reaped')),
          started_at TEXT NOT NULL,
          finished_at TEXT,
          UNIQUE (lane, run_id, pid)
        );
        CREATE INDEX IF NOT EXISTS cove_spawned_children_active_idx
          ON cove_spawned_children(state, server_pid, started_at);
      `);
    },
  },
  {
    version: 11,
    name: "strong-child-process-identity",
    up: (db) => {
      db.exec(`
        ALTER TABLE cove_task_session_runs
          ADD COLUMN server_generation TEXT NOT NULL DEFAULT 'legacy';
        ALTER TABLE cove_spawned_children
          ADD COLUMN server_generation TEXT NOT NULL DEFAULT 'legacy';
        ALTER TABLE cove_spawned_children
          ADD COLUMN boot_id TEXT NOT NULL DEFAULT 'unknown';
        ALTER TABLE cove_spawned_children
          ADD COLUMN identity_token TEXT;
        ALTER TABLE cove_spawned_children
          ADD COLUMN expected_command TEXT;
        ALTER TABLE cove_spawned_children
          ADD COLUMN server_command TEXT;
        ALTER TABLE cove_spawned_children
          ADD COLUMN server_started_at TEXT;
      `);
    },
  },
  {
    version: 12,
    name: "deterministic-email-state",
    up: (db) => {
      db.exec(`
        ALTER TABLE email_items ADD COLUMN workflow_state TEXT NOT NULL DEFAULT 'legacy'
          CHECK (workflow_state IN (
            'legacy','observed','classifying','open',
            'finalizing','terminal','failed'
          ));
        ALTER TABLE email_items ADD COLUMN bucket TEXT
          CHECK (bucket IN ('reply','action','fyi','noise'));
        ALTER TABLE email_items ADD COLUMN thread_version INTEGER NOT NULL DEFAULT 0
          CHECK (thread_version >= 0);
        ALTER TABLE email_items ADD COLUMN latest_inbound_message_id TEXT;
        ALTER TABLE email_items ADD COLUMN latest_gmail_history_id TEXT;
        ALTER TABLE email_items ADD COLUMN gmail_draft_id TEXT;
        ALTER TABLE email_items ADD COLUMN draft_body_hash TEXT;
        ALTER TABLE email_items ADD COLUMN surfaced_message_id TEXT;
        ALTER TABLE email_items ADD COLUMN surfaced_at TEXT;
        ALTER TABLE email_items ADD COLUMN surface_receipt_id TEXT;
        ALTER TABLE email_items ADD COLUMN completion_reason TEXT;
      `);

      const rows = db.prepare(
        `SELECT id, thread_id, message_id, status, received_at, updated_at,
                source_payload
         FROM email_items
         WHERE thread_id IS NOT NULL
         ORDER BY thread_id,
           CASE WHEN status IN ('pending','archiving') THEN 0 ELSE 1 END,
           COALESCE(received_at, '') DESC,
           COALESCE(updated_at, '') DESC,
           id`,
      ).all() as Array<{
        id: string;
        thread_id: string;
        message_id: string | null;
        status: string;
        received_at: string | null;
        updated_at: string | null;
        source_payload: string | null;
      }>;
      const winners = new Map<string, string>();
      const winnerForDuplicate = db.prepare(
        "SELECT id FROM email_items WHERE thread_id = ? LIMIT 1",
      );
      const repointDrafts = db.prepare(
        "UPDATE drafts SET email_item_id = ? WHERE email_item_id = ?",
      );
      const repointActions = db.prepare(
        "UPDATE email_action_log SET email_item_id = ? WHERE email_item_id = ?",
      );
      const dismissDuplicate = db.prepare(
        `UPDATE email_items
         SET thread_id = NULL, status = 'dismissed', workflow_state = 'legacy',
             source_payload = ?, updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)
         WHERE id = ?`,
      );
      for (const row of rows) {
        const winner = winners.get(row.thread_id);
        if (!winner) {
          winners.set(row.thread_id, row.id);
          continue;
        }
        const metadata = (() => {
          try {
            const parsed = row.source_payload ? JSON.parse(row.source_payload) : {};
            return parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? parsed as Record<string, unknown>
              : {};
          } catch {
            return {};
          }
        })();
        repointDrafts.run(winner, row.id);
        repointActions.run(winner, row.id);
        dismissDuplicate.run(
          JSON.stringify({ ...metadata, merged_into_id: winner }),
          row.id,
        );
      }
      // Keep this lookup referenced so migration failures surface before indexes
      // on unusual legacy databases with malformed thread identifiers.
      for (const threadId of winners.keys()) winnerForDuplicate.get(threadId);

      db.exec(`
        CREATE TABLE cove_email_messages (
          message_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          email_item_id TEXT NOT NULL REFERENCES email_items(id),
          gmail_history_id TEXT,
          internal_date TEXT,
          direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
          state TEXT NOT NULL CHECK (
            state IN ('observed','classifying','processed','failed','superseded')
          ),
          classification_json TEXT,
          model_version TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          observed_at TEXT NOT NULL,
          processed_at TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX cove_email_messages_thread_date_idx
          ON cove_email_messages(thread_id, internal_date);
        CREATE INDEX cove_email_messages_state_idx
          ON cove_email_messages(state, updated_at);

        CREATE TABLE cove_gmail_operations (
          id TEXT PRIMARY KEY,
          email_item_id TEXT NOT NULL REFERENCES email_items(id),
          thread_id TEXT NOT NULL,
          expected_message_id TEXT NOT NULL
            REFERENCES cove_email_messages(message_id),
          expected_thread_version INTEGER NOT NULL CHECK (expected_thread_version > 0),
          kind TEXT NOT NULL CHECK (kind IN ('upsert_draft','archive_messages')),
          operation_key TEXT NOT NULL UNIQUE,
          payload_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','uncertain','succeeded','superseded','dead')),
          job_id TEXT,
          remote_id TEXT,
          result_json TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        );
        CREATE UNIQUE INDEX cove_gmail_operations_one_active_thread
          ON cove_gmail_operations(thread_id)
          WHERE status IN ('pending','uncertain');
        CREATE INDEX cove_gmail_operations_status_idx
          ON cove_gmail_operations(status, updated_at);
      `);

      const managedRows = db.prepare(
        `SELECT id, thread_id, message_id, status, received_at, created_at,
                updated_at, source_payload
         FROM email_items
         WHERE thread_id IS NOT NULL`,
      ).all() as Array<{
        id: string;
        thread_id: string;
        message_id: string | null;
        status: string;
        received_at: string | null;
        created_at: string | null;
        updated_at: string | null;
        source_payload: string | null;
      }>;
      const backfillItem = db.prepare(
        `UPDATE email_items
         SET workflow_state = ?, bucket = ?, thread_version = 1,
             latest_inbound_message_id = ?, gmail_draft_id = ?,
             surfaced_message_id = ?, surfaced_at = ?
         WHERE id = ?`,
      );
      const insertMessage = db.prepare(
        `INSERT OR IGNORE INTO cove_email_messages
           (message_id, thread_id, email_item_id, internal_date, direction,
            state, classification_json, attempts, observed_at, processed_at,
            updated_at)
         VALUES (?, ?, ?, ?, 'inbound', 'processed', NULL, 0, ?, ?, ?)`,
      );
      for (const row of managedRows) {
        let metadata: Record<string, unknown> = {};
        try {
          const parsed = row.source_payload ? JSON.parse(row.source_payload) : {};
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            metadata = parsed as Record<string, unknown>;
          }
        } catch {
          // Malformed legacy metadata remains preserved in source_payload.
        }
        const rawBucket = metadata.bucket;
        const bucket = rawBucket === "reply" || rawBucket === "action" ||
            rawBucket === "fyi" || rawBucket === "noise"
          ? rawBucket
          : rawBucket === "archived"
            ? "noise"
            : null;
        const terminal = ["actioned", "reviewed", "archived", "dismissed"].includes(row.status);
        const timestamp = row.updated_at ?? row.received_at ?? row.created_at ??
          new Date(0).toISOString();
        const draftId = typeof metadata.gmail_draft_id === "string"
          ? metadata.gmail_draft_id
          : typeof metadata.draft_id === "string"
            ? metadata.draft_id
            : null;
        backfillItem.run(
          terminal ? "terminal" : "open",
          bucket,
          row.message_id,
          draftId,
          row.message_id,
          timestamp,
          row.id,
        );
        if (row.message_id) {
          insertMessage.run(
            row.message_id,
            row.thread_id,
            row.id,
            row.received_at,
            timestamp,
            timestamp,
            timestamp,
          );
        }
      }

      db.exec(`
        CREATE UNIQUE INDEX email_items_thread_id_unique
          ON email_items(thread_id) WHERE thread_id IS NOT NULL;
        CREATE UNIQUE INDEX email_items_latest_inbound_unique
          ON email_items(latest_inbound_message_id)
          WHERE latest_inbound_message_id IS NOT NULL;
      `);

      const emailTasks = db.prepare(
        `SELECT id, title, tags, status, created_at, updated_at
         FROM tasks
         WHERE title LIKE 'Emails:%' OR tags LIKE '%"email-current"%'
         ORDER BY
           CASE WHEN tags LIKE '%"email-current"%' THEN 0 ELSE 1 END,
           COALESCE(updated_at, created_at, '') DESC,
           id`,
      ).all() as Array<{
        id: string;
        title: string;
        tags: string | null;
        status: string;
        created_at: string | null;
        updated_at: string | null;
      }>;
      if (emailTasks.length > 0) {
        const canonical = emailTasks[0];
        let tags: string[] = [];
        try {
          const parsed = canonical.tags ? JSON.parse(canonical.tags) : [];
          tags = Array.isArray(parsed)
            ? parsed.filter((value): value is string => typeof value === "string")
            : [];
        } catch {
          // Keep the rolling identity even when a legacy tag field is malformed.
        }
        tags = [...new Set([...tags, "email", "email-current"])];
        const pending = db.prepare(
          "SELECT 1 FROM email_items WHERE status = 'pending' LIMIT 1",
        ).get();
        db.prepare(
          `UPDATE tasks
           SET title = 'Email', tags = ?, status = ?,
               source_type = 'email', updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)
           WHERE id = ?`,
        ).run(JSON.stringify(tags), pending ? "open" : "done", canonical.id);
        const closeLegacy = db.prepare(
          `UPDATE tasks
           SET status = 'done', updated_at = COALESCE(updated_at, CURRENT_TIMESTAMP)
           WHERE id = ? AND status = 'open'`,
        );
        for (const legacy of emailTasks.slice(1)) closeLegacy.run(legacy.id);
      } else if (managedRows.some((row) => row.status === "pending" || row.status === "archiving")) {
        const todayColumn = db.prepare(
          `SELECT id FROM task_columns
           WHERE lower(name) IN ('must happen today','needs to happen today','today')
           ORDER BY position, id LIMIT 1`,
        ).get() as { id: string } | undefined;
        const timestamp = new Date().toISOString();
        db.prepare(
          `INSERT INTO tasks
             (id, column_id, title, description, priority, tags, project,
              position, status, source_type, remind_native, remind_text,
              created_at, updated_at)
           VALUES (?, ?, 'Email',
             'Replies and actions that still need you. Gmail Inbox is the source of truth.',
             'high', '["email","email-current"]', 'Cove', -1000, 'open',
             'email', 0, 0, ?, ?)`,
        ).run(
          randomUUID(),
          todayColumn?.id ?? null,
          timestamp,
          timestamp,
        );
      }
    },
  },
  {
    version: 13,
    name: "canonical-cove-storage",
    foreignKeysOff: true,
    up: (db) => {
      const tableExists = (name: string) => Boolean(db.prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
      ).get(name));
      const legacyTables = [
        ["forge_jobs", "cove_jobs"],
        ["forge_receipts", "cove_receipts"],
        ["forge_failure_inbox", "cove_failure_inbox"],
        ["forge_message_ingestion", "cove_message_ingestion"],
        ["forge_email_messages", "cove_email_messages"],
        ["forge_gmail_operations", "cove_gmail_operations"],
      ] as const;
      for (const [legacyName, coveName] of legacyTables) {
        const legacyExists = tableExists(legacyName);
        const coveExists = tableExists(coveName);
        if (legacyExists && coveExists) {
          throw new Error(
            `Cannot migrate ${legacyName}: ${coveName} already exists.`,
          );
        }
        if (legacyExists) {
          db.exec(`ALTER TABLE "${legacyName}" RENAME TO "${coveName}"`);
        }
      }

      db.exec(`
        DROP INDEX IF EXISTS forge_jobs_ready_idx;
        DROP INDEX IF EXISTS forge_jobs_lease_idx;
        DROP INDEX IF EXISTS forge_receipts_recent_idx;
        DROP INDEX IF EXISTS forge_receipts_source_idx;
        DROP INDEX IF EXISTS forge_failure_inbox_open_idx;
        DROP INDEX IF EXISTS forge_message_ingestion_status_lease_idx;
        DROP INDEX IF EXISTS forge_message_ingestion_receipt_idx;
        DROP INDEX IF EXISTS forge_email_messages_thread_date_idx;
        DROP INDEX IF EXISTS forge_email_messages_state_idx;
        DROP INDEX IF EXISTS forge_gmail_operations_one_active_thread;
        DROP INDEX IF EXISTS forge_gmail_operations_status_idx;

        CREATE INDEX IF NOT EXISTS cove_jobs_ready_idx
          ON cove_jobs(status, priority DESC, run_after);
        CREATE INDEX IF NOT EXISTS cove_jobs_lease_idx
          ON cove_jobs(status, lease_until);
        CREATE INDEX IF NOT EXISTS cove_receipts_recent_idx
          ON cove_receipts(finished_at DESC);
        CREATE INDEX IF NOT EXISTS cove_receipts_source_idx
          ON cove_receipts(source, finished_at DESC);
        CREATE INDEX IF NOT EXISTS cove_failure_inbox_open_idx
          ON cove_failure_inbox(dismissed_at, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS cove_message_ingestion_status_lease_idx
          ON cove_message_ingestion(status, lease_until);
        CREATE INDEX IF NOT EXISTS cove_message_ingestion_receipt_idx
          ON cove_message_ingestion(receipt_id);
        CREATE INDEX IF NOT EXISTS cove_email_messages_thread_date_idx
          ON cove_email_messages(thread_id, internal_date);
        CREATE INDEX IF NOT EXISTS cove_email_messages_state_idx
          ON cove_email_messages(state, updated_at);
        CREATE UNIQUE INDEX IF NOT EXISTS cove_gmail_operations_one_active_thread
          ON cove_gmail_operations(thread_id)
          WHERE status IN ('pending','uncertain');
        CREATE INDEX IF NOT EXISTS cove_gmail_operations_status_idx
          ON cove_gmail_operations(status, updated_at);
      `);
    },
  },
  {
    version: 14,
    name: "contact-emails",
    up: (db) => {
      // contact_emails is the source of truth for email-based contact
      // resolution. contacts.email stays as the primary-address mirror so
      // existing readers keep working.
      db.exec(`
        CREATE TABLE IF NOT EXISTS contact_emails (
          id TEXT PRIMARY KEY,
          contact_id TEXT NOT NULL REFERENCES contacts(id),
          email TEXT NOT NULL,
          normalized_email TEXT NOT NULL UNIQUE,
          is_primary INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS contact_emails_contact_idx
          ON contact_emails(contact_id);
      `);
      const rows = db.prepare(
        `SELECT id, email, created_at
         FROM contacts
         WHERE email IS NOT NULL AND trim(email) <> ''
         ORDER BY COALESCE(created_at, ''), id`,
      ).all() as Array<{
        id: string;
        email: string;
        created_at: string | null;
      }>;
      const insert = db.prepare(
        `INSERT OR IGNORE INTO contact_emails
           (id, contact_id, email, normalized_email, is_primary, created_at)
         VALUES (?, ?, ?, ?, 1, ?)`,
      );
      for (const row of rows) {
        const normalizedEmail = normalizeContactEmail(row.email);
        if (!normalizedEmail) continue;
        // OR IGNORE: legacy duplicate emails keep only the oldest row here;
        // resolution still sees every holder through contacts.normalized_email,
        // so duplicate addresses stay ambiguous.
        insert.run(
          randomUUID(),
          row.id,
          row.email.trim(),
          normalizedEmail,
          row.created_at ?? new Date().toISOString(),
        );
      }
    },
  },
  {
    version: 15,
    name: "task-session-model-routing",
    up: (db) => {
      db.exec(`
        ALTER TABLE cove_task_session_runs
          ADD COLUMN model TEXT NOT NULL DEFAULT 'claude-opus-5'
          CHECK (model IN ('claude-opus-5','claude-sonnet-5','claude-haiku-4-5'));
        ALTER TABLE cove_task_session_runs
          ADD COLUMN effort TEXT NOT NULL DEFAULT 'high'
          CHECK (effort IN ('medium','high'));
        ALTER TABLE cove_task_session_runs
          ADD COLUMN model_reason TEXT NOT NULL DEFAULT 'Legacy session created before model routing.';
      `);
    },
  },
  {
    version: 16,
    name: "attention-ledger",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS cove_attention_ledger (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL
            CHECK (kind IN ('sweep_nudge','floor_nudge','urgent_email')),
          ref_kind TEXT NOT NULL
            CHECK (ref_kind IN ('task','commitment','email')),
          ref_id TEXT NOT NULL,
          level TEXT NOT NULL
            CHECK (level IN ('text','banner','board','suppressed','shadow')),
          reason TEXT NOT NULL,
          delivered_at TEXT,
          suppressed_reason TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS cove_attention_ledger_ref_idx
          ON cove_attention_ledger(ref_kind, ref_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS cove_attention_ledger_budget_idx
          ON cove_attention_ledger(level, delivered_at);
        CREATE INDEX IF NOT EXISTS cove_attention_ledger_kind_idx
          ON cove_attention_ledger(kind, created_at DESC);
      `);
    },
  },
  {
    version: 17,
    name: "task-session-workspace-path",
    up: (db) => {
      db.exec(`
        ALTER TABLE cove_task_session_runs
          ADD COLUMN workspace_path TEXT;
      `);
    },
  },
  {
    version: 18,
    name: "meeting-intelligence-task-fields",
    up: (db) => {
      db.exec(`
        ALTER TABLE tasks ADD COLUMN brief TEXT;
        ALTER TABLE tasks ADD COLUMN remind_at TEXT;
        ALTER TABLE tasks ADD COLUMN nudged_at TEXT;
        ALTER TABLE tasks ADD COLUMN engaged_at TEXT;
        ALTER TABLE tasks ADD COLUMN notification_policy TEXT
          CHECK (notification_policy IS NULL OR notification_policy IN ('none','predeadline','due','both'));
        CREATE INDEX tasks_open_nudge_candidates_idx
          ON tasks(remind_at)
          WHERE status = 'open' AND remind_at IS NOT NULL AND nudged_at IS NULL;
      `);
    },
  },
  {
    version: 19,
    name: "meeting-analysis-workflow",
    up: (db) => {
      db.exec(`
        CREATE TABLE meeting_analysis_jobs (
          id TEXT PRIMARY KEY,
          group_key TEXT NOT NULL UNIQUE,
          input_hash TEXT NOT NULL,
          not_before TEXT NOT NULL,
          lease TEXT,
          lease_expires TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL CHECK (status IN ('pending','held','running','succeeded','failed','dead')),
          analyst_json TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX meeting_analysis_jobs_ready_idx
          ON meeting_analysis_jobs(status, not_before, lease_expires);
        CREATE TABLE meeting_analysis_members (
          job_id TEXT NOT NULL REFERENCES meeting_analysis_jobs(id) ON DELETE CASCADE,
          gmail_message_id TEXT NOT NULL UNIQUE,
          tool TEXT NOT NULL,
          subject TEXT NOT NULL,
          received_at TEXT NOT NULL,
          envelope_json TEXT NOT NULL,
          PRIMARY KEY (job_id, gmail_message_id)
        );
        CREATE INDEX meeting_analysis_members_job_idx
          ON meeting_analysis_members(job_id, received_at, gmail_message_id);
        CREATE TABLE meeting_analysis_actions (
          job_id TEXT NOT NULL REFERENCES meeting_analysis_jobs(id) ON DELETE CASCADE,
          action_key TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('task','commitment','crm_note','research_note')),
          target_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
          error TEXT,
          PRIMARY KEY (job_id, action_key)
        );
        CREATE INDEX meeting_analysis_actions_status_idx
          ON meeting_analysis_actions(job_id, status, kind);
      `);
    },
  },
  {
    version: 20,
    name: "email-draft-outcomes",
    up: (db) => {
      db.exec(`
        CREATE TABLE email_draft_outcomes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email_item_id INTEGER NOT NULL,
          thread_id TEXT NOT NULL,
          gmail_draft_id TEXT,
          draft_body TEXT NOT NULL,
          draft_body_hash TEXT NOT NULL,
          drafted_at TEXT NOT NULL,
          judge_score INTEGER,
          judge_verdict TEXT,
          sent_message_id TEXT,
          sent_at TEXT,
          sent_body TEXT,
          outcome TEXT NOT NULL DEFAULT 'pending',
          reviewed_at TEXT
        );
        CREATE INDEX idx_edo_outcome ON email_draft_outcomes(outcome);
        CREATE INDEX idx_edo_thread ON email_draft_outcomes(thread_id);
      `);
    },
  },
  {
    version: 21,
    name: "pipeline-deals",
    up: (db) => {
      db.exec(`
        CREATE TABLE pipeline_deals (
          id TEXT PRIMARY KEY,
          contact_id TEXT NOT NULL UNIQUE
            REFERENCES contacts(id) ON DELETE CASCADE,
          stage TEXT NOT NULL CHECK (stage IN (
            'reach_out','keep_warm','interested','call_scheduled','pitched',
            'discovery_ready','discovery_booked','proposal','client','lost','parked'
          )),
          monthly_value INTEGER
            CHECK (monthly_value IS NULL OR monthly_value >= 0),
          discovery_price INTEGER
            CHECK (discovery_price IS NULL OR discovery_price >= 0),
          next_action TEXT NOT NULL DEFAULT '',
          next_follow_up_at TEXT,
          source TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '',
          last_touch_at TEXT,
          stage_changed_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX pipeline_deals_stage_idx ON pipeline_deals(stage);
        CREATE INDEX pipeline_deals_next_follow_up_idx
          ON pipeline_deals(next_follow_up_at);
      `);
    },
  },
  {
    version: 22,
    name: "chief_of_staff_action_ledger",
    up: (db) => {
      db.exec(`
        CREATE TABLE chief_of_staff_actions (
          wake_job_id TEXT NOT NULL REFERENCES cove_jobs(id) ON DELETE CASCADE,
          action_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL
            CHECK (status IN ('applied','rejected','skipped')),
          error TEXT,
          applied_at TEXT,
          PRIMARY KEY (wake_job_id, action_id)
        );
        CREATE INDEX chief_of_staff_actions_status_idx
          ON chief_of_staff_actions(status, applied_at);
      `);
    },
  },
  {
    version: 23,
    name: "chief_of_staff_content_hash_ledger",
    up: (db) => {
      db.exec(`
        ALTER TABLE chief_of_staff_actions RENAME TO chief_of_staff_actions_by_action_id;
        CREATE TABLE chief_of_staff_actions (
          wake_job_id TEXT NOT NULL REFERENCES cove_jobs(id) ON DELETE CASCADE,
          content_hash TEXT NOT NULL,
          action_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL
            CHECK (status IN ('applied','rejected','skipped')),
          error TEXT,
          applied_at TEXT,
          PRIMARY KEY (wake_job_id, content_hash)
        );
        INSERT INTO chief_of_staff_actions
          (wake_job_id, content_hash, action_id, kind, payload_json, status, error, applied_at)
        SELECT wake_job_id, 'legacy:' || action_id, action_id, kind, payload_json,
               status, error, applied_at
        FROM chief_of_staff_actions_by_action_id;
        DROP TABLE chief_of_staff_actions_by_action_id;
        CREATE INDEX chief_of_staff_actions_status_idx
          ON chief_of_staff_actions(status, applied_at);
      `);
    },
  },
  {
    version: 24,
    name: "chief_of_staff_attention",
    up: (db) => {
      db.exec(`
        ALTER TABLE cove_attention_ledger RENAME TO cove_attention_ledger_before_chief_of_staff;
        CREATE TABLE cove_attention_ledger (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL
            CHECK (kind IN ('sweep_nudge','floor_nudge','urgent_email','chief_of_staff')),
          ref_kind TEXT NOT NULL
            CHECK (ref_kind IN ('task','commitment','email','deal')),
          ref_id TEXT NOT NULL,
          level TEXT NOT NULL
            CHECK (level IN ('text','banner','board','suppressed','shadow')),
          reason TEXT NOT NULL,
          delivered_at TEXT,
          suppressed_reason TEXT,
          created_at TEXT NOT NULL
        );
        INSERT INTO cove_attention_ledger
          (id, kind, ref_kind, ref_id, level, reason, delivered_at,
           suppressed_reason, created_at)
        SELECT id, kind, ref_kind, ref_id, level, reason, delivered_at,
               suppressed_reason, created_at
        FROM cove_attention_ledger_before_chief_of_staff;
        DROP TABLE cove_attention_ledger_before_chief_of_staff;
        CREATE INDEX cove_attention_ledger_ref_idx
          ON cove_attention_ledger(ref_kind, ref_id, created_at DESC);
        CREATE INDEX cove_attention_ledger_budget_idx
          ON cove_attention_ledger(level, delivered_at);
        CREATE INDEX cove_attention_ledger_kind_idx
          ON cove_attention_ledger(kind, created_at DESC);
      `);
    },
  },
  {
    version: 25,
    name: "task-origin",
    up: (db) => {
      db.exec("ALTER TABLE tasks ADD COLUMN origin TEXT");
    },
  },
  {
    version: 26,
    name: "quiet-current-transactions",
    up: (db) => {
      db.exec(`
        CREATE TABLE cove_quiet_current (
          store_key TEXT PRIMARY KEY,
          state_json TEXT NOT NULL CHECK (json_valid(state_json)),
          legacy_sha256 TEXT,
          imported_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 27,
    name: "background-model-usage",
    up: (db) => { db.exec(BACKGROUND_USAGE_SCHEMA); },
  },
  {
    version: 28,
    name: "task-session-providers",
    up: (db) => db.exec(`
      ALTER TABLE cove_task_session_runs ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude' CHECK(provider IN ('claude','codex'));
      ALTER TABLE cove_task_session_runs ADD COLUMN model_id TEXT;
      ALTER TABLE cove_task_session_runs ADD COLUMN reasoning_effort TEXT CHECK(reasoning_effort IN ('low','medium','high'));
      ALTER TABLE cove_task_session_runs ADD COLUMN provider_session_id TEXT;
      ALTER TABLE cove_task_session_runs ADD COLUMN provider_home TEXT;
      ALTER TABLE cove_task_session_runs ADD COLUMN provider_executable TEXT;
    `),
  },
  {
    version: 29,
    name: "deterministic-follow-through",
    up: (db) => {
      db.exec(FOLLOW_THROUGH_SCHEMA);
      db.exec(`ALTER TABLE cove_attention_ledger RENAME TO cove_attention_ledger_before_meetings;`);
      const previous = (db.prepare("SELECT sql FROM sqlite_schema WHERE name='cove_attention_ledger_before_meetings'").get() as { sql: string }).sql;
      db.exec(previous.replace('"cove_attention_ledger_before_meetings"', 'cove_attention_ledger').replace("'email','deal'", "'email','deal','meeting'"));
      db.exec(`INSERT INTO cove_attention_ledger SELECT * FROM cove_attention_ledger_before_meetings;
        DROP TABLE cove_attention_ledger_before_meetings;
        CREATE INDEX cove_attention_ledger_ref_idx ON cove_attention_ledger(ref_kind, ref_id, created_at DESC);
        CREATE INDEX cove_attention_ledger_budget_idx ON cove_attention_ledger(level, delivered_at);
        CREATE INDEX cove_attention_ledger_kind_idx ON cove_attention_ledger(kind, created_at DESC);`);
    },
  },
  {
    version: 30,
    name: "paused-recurring-occurrences",
    up: (db) => {
      db.exec(`ALTER TABLE recurring_occurrences RENAME TO recurring_occurrences_before_pause;`);
      const previous = (db.prepare("SELECT sql FROM sqlite_schema WHERE name='recurring_occurrences_before_pause'").get() as { sql: string }).sql;
      db.exec(previous.replace('"recurring_occurrences_before_pause"', 'recurring_occurrences').replace("'open','completed','missed'", "'open','completed','missed','paused'"));
      db.exec(`INSERT INTO recurring_occurrences SELECT * FROM recurring_occurrences_before_pause;
        DROP TABLE recurring_occurrences_before_pause;
        CREATE UNIQUE INDEX recurring_occurrences_task_idx ON recurring_occurrences(task_id) WHERE task_id IS NOT NULL;
        CREATE INDEX recurring_occurrences_template_date_idx ON recurring_occurrences(template_id, occurrence_local_date DESC);`);
    },
  },
  {
    version: 31,
    name: "commitment-responsibility",
    up: (db) => { db.exec(RESPONSIBILITY_SCHEMA); },
  },
];

function migrationTableExists(db: Database.Database, name: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?",
  ).get(name));
}

function ensureMigrationLedger(db: Database.Database): void {
  if (
    !migrationTableExists(db, "cove_schema_migrations") &&
    migrationTableExists(db, "forge_schema_migrations")
  ) {
    db.exec(
      "ALTER TABLE forge_schema_migrations RENAME TO cove_schema_migrations",
    );
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS cove_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
}

export function runLocalMigrations(
  db: Database.Database,
  now: () => Date = () => new Date(),
): void {
  ensureMigrationLedger(db);
  for (const migration of LOCAL_MIGRATIONS) {
    applyLocalMigration(db, migration, now);
  }
}

export function applyLocalMigration(
  db: Database.Database,
  migration: LocalMigration,
  now: () => Date = () => new Date(),
): void {
  ensureMigrationLedger(db);
  const alreadyApplied = db.prepare(
    "SELECT 1 FROM cove_schema_migrations WHERE version = ?",
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
        "INSERT INTO cove_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
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
