# Cove Data

## Source of truth

`data/cove.db` is Cove's durable local database. It contains tasks, day plans, brief artifacts, email workflow state, CRM records, jobs, receipts, failures, health snapshots, and model-run metadata. SQLite migrations are ordered in `src/lib/local/migrations.ts`; day-plan schema compatibility is maintained by `src/lib/day-plan/store.ts`.

Gmail remains authoritative for message content, drafts, sent replies, inbox membership, and archives. Cove stores only the workflow state it needs to make those actions reliable.

## Private files

Machine-private files under `data/` include the database, OAuth settings, heartbeats, relays, brief inputs, logs, and live meeting configuration. They must not be committed or included in a client export. The only distributable meeting file is `data/cove-meetings.example.json`, which is disabled by default.

## Backups and restore

- The scheduler creates online SQLite backups in `data/backups/` and keeps 14 snapshots.
- Create one now with `bash scripts/cove-backup.sh`.
- Restore only with `bash scripts/cove-restore-backup.sh --yes <backup-file>`. The script validates the source and preserves the replaced database.
- Never copy a database over a running Cove process.

## Retention

Jobs, receipts, failure records, brief inputs, relays, and backups have bounded cleanup paths. Any new operational table or file collection must define retention before it ships.
