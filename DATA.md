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
| Sales pipeline | one consulting deal per contact, stage, value, next action, follow-up date | `src/lib/crm/pipeline-store.ts` |
| Meeting intelligence | normalized meeting envelopes, analyst artifacts, replay-safe action ledger | `src/lib/intake/meeting-analysis.ts` |
| Automation | jobs, receipts, failures, health snapshots, attention ledger | `src/lib/reliability/`, `src/lib/attention/` |
| Persistent chief of staff | wake jobs plus one replay-safe action row per proposed action | `src/lib/chief-of-staff/`, `chief_of_staff_actions` |
| Agent work | execution runs, task-session runs, child-process identity | `src/lib/claude-execution/`, `src/lib/task-sessions/` |

Schema ownership and code ownership are mapped in `CODEBASE_GUIDE.md`.

### Sales pipeline

`pipeline_deals` stores one Edge AI consulting deal per contact. Deleting a
contact deletes its deal. Stage changes and real touches are retained in
`contact_activities`; administrative deal removal does not delete that history.
Follow-up dates are calendar dates in `YYYY-MM-DD` form, never timestamps.

`src/lib/crm/contact-context.ts` builds the shared relationship view used by
email, meeting analysis, the brief, and Buddy. Email aliases come from
`contact_emails`. The view includes the local pipeline deal, the last three
meeting summaries, other recent activity, and open follow-up commitments.

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

When a meeting summary lands after a Cove-owned draft was written, Cove moves
the open email item back to `observed`, increments its thread version, and
queues the existing classifier lane. The resulting `upsert_draft` operation
updates the known Gmail draft only when its current body still matches Cove's
stored hash. An operator-edited draft is preserved.

Handled informational and low-value email rows remain in `email_items` as
durable review evidence. The Email card reads the last seven days of `fyi` and
`noise` rows for its read-only Things you should know section. The local REST
query filters and sorts on `actioned_at`, which is set when Gmail confirms the
archive. Accepted and tentative calendar responses use deterministic summaries.
Other calendar notices keep the model context after a deterministic event line.

Resolved rows remain durable review evidence after `reviewed_at` is set. Weekly
markdown digests under `data/voice-reviews/` are also retained until the
operator removes them. There is no automatic deletion in this version because
the review history is the evidence for proposed fingerprint changes; no rule or
corpus candidate is applied automatically.

### Persistent chief of staff

`chief_of_staff_actions` is the action ledger for persistent-agent wakes. Its
primary key is `(wake_job_id, content_hash)`, where the hash excludes the
model-chosen action ID and rationale. Each row stores the proposed payload,
the deterministic driver's result (`applied`, `rejected`, or `skipped`), an
optional rejection reason, and the application time. Applied rows are never
rerun when the scheduler retries a wake. Each completed wake adds a
driver-authored journal outcome with the applied count and any rejected action
kinds and reasons, so model-written journal claims cannot hide ledger failures.

`cove_attention_ledger` accepts `chief_of_staff` decisions for task,
commitment, and deal references. The driver stores the resulting attention row
ID inside the chief-of-staff action payload. An action is applied only after a
live delivery or a shadow record. Cap and cooldown rejections keep their exact
ledger reason for the next snapshot.

Notify audit payloads include `delivered_level`. Cove attempts at most one text
per wake. It records a later text request with `downgrade_reason` set to
`one_text_per_wake`, then sends it as a banner. A successful Quiet Current
write without a successful notification transport remains a truthful `board`
row in the attention ledger, while the chief-of-staff action is rejected as
`delivered_board_only:<transport error>`.

The action vocabulary can add a pipeline deal only when the contact has no
deal and the requested stage is non-terminal. Existing deals use update or
move actions. Client, lost, and parked additions are rejected.

Runtime-private files live under `data/chief-of-staff/`. `session.json` holds
the Codex session ID and wake counters. `agent/` is a tiny nested Git repository
with a read-only mandate and an otherwise empty workspace. `journal/` and
`reviews/` are driver-written audit records. `snapshots/` retains the exact
bounded input for the latest 50 wakes. Reset archives the old session record
under `archive/`; it does not delete the journal, ledger, snapshots, or reviews.

`codex-home/` is the persistent agent's isolated Codex home. Its exact minimal
`config.toml` disables shell, web search, and apps, and declares no MCP servers.
Its `auth.json` is a symlink to the operator's live Codex auth file, never a
credential copy. Agent sessions and rollouts stay under `codex-home/sessions/`
and are not removed when `session.json` is reset.

The private mandate source is `data/cove-mandate.md`. The distributable fallback
is `prompts/chief-of-staff-mandate.md`.

`data/attention-sweep.json` retains its `shadow` key but now governs
chief-of-staff `notify` actions. The old standalone attention sweep LaunchAgent
is retired. Shadow decisions write ledger and Quiet Current evidence without
sending a banner or text.

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

`data/cove-meeting-state.json` stores Gmail watcher progress plus this Granola
poll state:

```json
{
  "granola": {
    "watermark_at": "ISO timestamp or null",
    "list_cursor": "opaque cursor or null",
    "pending_note_ids": ["not_..."],
    "revisions": { "not_...": "sha256 hash" },
    "failures": { "not_...": { "failed_runs": 1 } },
    "dead_letters": [{ "note_id": "not_...", "failed_runs": 5 }]
  }
}
```

The Granola watermark advances only after a complete successful page walk.
Every pending note is fetched directly on each poll for up to seven days,
including notes waiting for a summary and notes waiting for the intake queue.
After five failed queue attempts, Cove records the note in Granola dead letters
and stops refetching it. The stable claim ID is `granola:<note_id>`. One note is
one meeting and never joins the Gmail fragment group. Cove analyzes the first
complete summary once. Later summary or private-note revisions are counted in
the heartbeat as ignored and are not analyzed again in this release.

`data/cove-policy.md` is the optional private operator policy for the brief,
generic intake, email classifier, meeting analyst, and Buddy. Reads are capped
at 3,000 characters. `prompts/operator-policy.template.md` is the distributable
placeholder, not the live policy.

`data/cove-mandate.md` and everything under `data/chief-of-staff/` are private
runtime state. They must never be included in a client export or commit.

## Backups and restore

- The scheduler creates online SQLite backups in `data/backups/` and keeps 14 snapshots.
- Create one now with `bash scripts/cove-backup.sh`.
- Restore only with `bash scripts/cove-restore-backup.sh --yes <backup-file>`. The script validates the source and preserves the replaced database.
- Never copy a database over a running Cove process.

## Retention

Jobs, receipts, failure records, brief inputs, relays, and backups have bounded cleanup paths. Any new operational table or file collection must define retention before it ships.
