# Cove Data

## Source of truth

`data/cove.db` is Cove's durable local database. It contains tasks, day plans, brief artifacts, email workflow state, CRM records, jobs, receipts, failures, health snapshots, and model-run metadata. SQLite migrations are ordered in `src/lib/local/migrations.ts`; day-plan schema compatibility is maintained by `src/lib/day-plan/store.ts`.

Gmail remains authoritative for message content, drafts, sent replies, inbox membership, and archives. Cove stores only the workflow state it needs to make those actions reliable.

## State families

| Family | Examples | Primary owner |
| --- | --- | --- |
| Work | tasks, columns, recurring templates and occurrences | `src/lib/local/migrations.ts`, `src/lib/tasks/` |
| Daily ritual | day plans, items, events, snapshots, dumps | `src/lib/day-plan/store.ts` |
| Briefs | immutable artifacts, action state, exact input metadata | `src/lib/day-plan/brief.ts`, `src/lib/claude-execution/brief-inputs.ts` |
| Email workflow | canonical thread items, message claims, drafts, provider operation outbox | `src/lib/email/` |
| People | contacts, companies, relationship activities | `src/lib/crm/` |
| Automation | jobs, receipts, failures, health snapshots, attention ledger | `src/lib/reliability/`, `src/lib/attention/` |
| Agent work | execution runs, task-session runs, child-process identity | `src/lib/claude-execution/`, `src/lib/task-sessions/` |

Schema ownership and code ownership are mapped in `CODEBASE_GUIDE.md`.

## Database access

Normal product code opens SQLite through `openLocalDatabase`, which applies all
pending migrations. Low-level migration and recovery paths may use
`openSqliteDatabase` when they intentionally control migration timing. Do not
open `better-sqlite3` directly in a new product module without a documented
reason.

SQLite uses foreign keys, WAL mode, and a busy timeout. Multi-step state changes
that must agree are one transaction. Provider mutations use a durable outbox or
claim record so a crash can be reconciled against the provider before retry.

## Private files

Machine-private files under `data/` include the database, OAuth settings, heartbeats, relays, brief inputs, logs, and live meeting configuration. They must not be committed or included in a client export. The only distributable meeting file is `data/cove-meetings.example.json`, which is disabled by default.

## Backups and restore

- The scheduler creates online SQLite backups in `data/backups/` and keeps 14 snapshots.
- Create one now with `bash scripts/cove-backup.sh`.
- Restore only with `bash scripts/cove-restore-backup.sh --yes <backup-file>`. The script validates the source and preserves the replaced database.
- Never copy a database over a running Cove process.

## Retention

Jobs, receipts, failure records, brief inputs, relays, and backups have bounded cleanup paths. Any new operational table or file collection must define retention before it ships.
