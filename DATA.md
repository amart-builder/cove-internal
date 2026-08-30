# Cove Data

## Source of truth

`data/cove.db` is Cove's durable local database. It contains tasks, day plans, brief artifacts, email workflow state, CRM records, jobs, receipts, failures, health snapshots, and model-run metadata. SQLite migrations are ordered in `src/lib/local/migrations.ts`; day-plan schema compatibility is maintained by `src/lib/day-plan/store.ts`.

Gmail remains authoritative for message content, drafts, sent replies, inbox membership, and archives. Cove stores the workflow state it needs to make those actions reliable. When voice review is enabled, it also stores the normalized pre-signature draft and matching sent body needed to measure edits; those bounded copies are review evidence, not a mailbox mirror.

## State families

| Family | Examples | Primary owner |
| --- | --- | --- |
| Work | tasks, meeting briefs, reminder state, columns, recurring templates and occurrences | `src/lib/local/migrations.ts`, `src/lib/tasks/` |
| Daily ritual | day plans, items, events, snapshots, dumps | `src/lib/day-plan/store.ts` |
| Briefs | immutable artifacts, action state, exact input metadata | `src/lib/day-plan/brief.ts`, `src/lib/claude-execution/brief-inputs.ts` |
| Email workflow | canonical thread items, message claims, provider operation outbox, draft outcomes | `src/lib/email/` |
| People | contacts, companies, relationship activities | `src/lib/crm/` |
| Meeting intelligence | normalized meeting envelopes, analyst artifacts, replay-safe action ledger | `src/lib/intake/meeting-analysis.ts` |
| Automation | jobs, receipts, failures, health snapshots, attention ledger | `src/lib/reliability/`, `src/lib/attention/` |
| Agent work | execution runs, task-session runs, child-process identity | `src/lib/claude-execution/`, `src/lib/task-sessions/` |

Schema ownership and code ownership are mapped in `CODEBASE_GUIDE.md`.

### Task reminder fields

`tasks.remind_at` is the pre-deadline nudge moment. Writers must store a full
RFC 3339 timestamp using the operator timezone's offset for that instant. A UTC
`Z` timestamp is rejected unless the operator timezone itself is UTC. This
keeps the operator's chosen wall-clock time explicit across daylight-saving
changes.

`tasks.notification_policy` controls reminder lanes: `none` disables both,
`predeadline` enables only `remind_at`, `due` enables only the existing due
reminder, and `both` enables both. `NULL` is legacy due-only behavior. It never
enables a pre-deadline nudge.

### Meeting analysis workflow

Meeting-note ingestion has two ownership boundaries. The short Gmail claim
parses a deterministic envelope, writes it to `meeting_analysis_members`, and
then completes the Gmail claim. The durable job in `meeting_analysis_jobs` owns
all model calls, research, and writes after that point. Its validated
`analyst_json` is persisted before any CRM, task, or commitment side effect.

`meeting_analysis_jobs.group_key` elects one leader for meeting fragments that
share normalized attendee identities in the two-hour grouping window. Explicit
duration metadata under 15 minutes marks a fragment. When duration metadata is
absent, a meeting body shorter than 1,200 characters is the deterministic
transcript-length heuristic. A fragment is held for two hours unless a sibling
joins. The always-on meeting drain checks every 15 minutes, so a lone fragment
runs on the first drain tick after its two-hour hold, roughly two hours after
ingestion in practice, with an explicit incomplete-notes caveat. Urgent-looking
text does not bypass this hold.

`meeting_analysis_actions` is the replay ledger. Action keys are stable hashes
of entries in the persisted analyst artifact. `done` actions are never rerun;
pending or failed actions resume after a crash with deterministic target IDs.
Kinds are `task`, `commitment`, `crm_note`, and `research_note`. Research is
cached permanently by CRM activity `source_ref=research:<contact_id>`, not by
age. A job retries with backoff and becomes `dead` after five attempts, at which
point a visible failure-inbox item records that legacy extraction ran as a
degraded fallback.

Meeting job artifacts, membership, and action rows are durable audit and replay
state in Phase 2 and have no automatic age-based deletion. A future retention
policy must preserve source identity, the validated artifact, and completed
action keys before compacting them.

### Email draft outcome review

`email_draft_outcomes` is append-only draft history. Each verified Gmail draft
write stores the normalized model body before the cached signature, its SHA-256
hash, and any optional voice-judge measurement. The weekly review reconciles a
later `SENT` message as unedited or edited, or marks a draft abandoned after 14
days. It strips the cached or recognizable trailing signature before hashing
and comparison. Model judge failures leave the draft unjudged and never block
Gmail drafting.

Resolved rows remain durable review evidence after `reviewed_at` is set. Weekly
markdown digests under `data/voice-reviews/` are also retained until the
operator removes them. There is no automatic deletion in this version because
the review history is the evidence for proposed fingerprint changes; no rule or
corpus candidate is applied automatically.

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
