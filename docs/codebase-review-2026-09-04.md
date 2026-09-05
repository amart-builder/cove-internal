# Cove codebase review, September 4, 2026

## Current follow-up status

The findings below record the original review. The subsequent isolated work
implements transactional Quiet Current, eligible chief reminders, conditional
editor writes and same-day recurrence resume. See
`client-readiness-2026-09-04.md` for current implementation and acceptance state.
The shared Codex runner and Claude seed-hook isolation risks remain documented
by Alex's explicit choice. No live migration or service replacement has run.

## Resolution of original findings

| Original finding | Current disposition |
| --- | --- |
| Quiet Current lost updates | Fixed in isolated SQLite implementation; migration not run live |
| Shared Codex configuration inheritance | Deferred explicitly; documented, execution isolation unchanged |
| Same-field editor conflicts | Fixed with transactional expected-value checks and visible conflict recovery |
| Chief advance-reminder eligibility | Fixed for explicit chief reminder actions |
| Pause and same-day resume | Fixed with preserved paused occurrence/task identity |
| Claude seed hooks | Documented; execution isolation unchanged |

The sections below retain the original line references and initial-pass evidence.
The reviewed candidate is now committed locally on `codex/chief-of-staff-client-ready`.
Use the client-readiness document for current acceptance and release status.

## Assessment

Cove has a coherent product core: local task ownership, versioned daily planning,
explicit model proposals, and durable background work. Preserve that core.
A rewrite or framework migration is not justified by this review. The most
valuable next investment is reliable coordination between simultaneous writers.

This pass implemented bounded security, backup, editing, and documentation
improvements. It leaves major storage and model-permission changes explicit.
The operator requested that model execution remain unchanged.

## Baseline and scope

- Integrated on `bf15ba0`, after the other session committed task provenance,
  Claude sign-in recovery, and duplicate-task guards (`cd34bfd`, `bc9cf3a`,
  `628bd64`). Their changes were preserved.
- Inventory: 524 tracked files at that baseline, including 252 under `src`,
  56 scripts, and 127 test files. New review files are additional.
- Deep review covered local request/CSRF boundaries, REST persistence, task
  editors, day-plan concurrency, recurrence, chief actions, model subprocess
  configuration, Quiet Current writes, backup/restore, and release/setup paths.
- Broader inspection covered dependency advisories, tracked credential patterns,
  root documentation, source/test organization, and existing validation coverage.
- Independent reviewers checked security, data correctness, maintenance, and the
  final implementation. This is not a claim that every line or comment received
  equal depth, or that the app has no remaining vulnerabilities.
- This initial code review did not read the live task database, mailbox,
  personal model configuration, or credentials. The subsequent client-readiness
  review used narrowly scoped CRM and meeting-email reads at the operator's
  request; see `client-readiness-2026-09-04.md`. Browser tests used a separate
  home and synthetic database in `/private/tmp`. No live models were invoked.

## Implemented

### Backups report what actually happened

Previously, the manual backup command drained up to 25 arbitrary queued jobs,
could report exit code zero after backup failure, and reused the day's earlier
snapshot instead of capturing intervening edits.

The command now runs only its requested backup and reports failure with a
nonzero exit. It ignores optional email configuration, and targeted execution
recovers only that job's expired lease. General scheduler drains retain global
lease recovery. Every new snapshot passes SQLite `quick_check` before old
snapshots rotate. Manual requests receive unique filenames and stable retry
identity; `--daily` retains scheduled deduplication and verifies existing
completed snapshots. Health and retention accept old and new filenames.

Evidence: `tests/reliability-backup.test.mjs` covers failed destinations,
unrelated queued and expired jobs, intervening edits, daily repeats, corrupt
and missing snapshots, legacy completed jobs, same-second collisions, live WAL,
restore refusal while files are open, and retention. Job and email regression
suites also pass.

Files: `scripts/cove-backup.sh`, `scripts/cove-jobs.ts`,
`scripts/install-cove-local.sh`, `src/lib/reliability/backup.ts`,
`src/lib/reliability/jobs.ts`, `src/lib/health/collector.ts`.

### Task editors preserve untouched fields

Both editors now compare against the values present when editing began and
send only fields the person changed. A title edit no longer sends an old
description, due date, column, or origin over a background update. Clearing
origin is an explicit empty-string write. No-op saves do not write. Tag edits
preserve the latest blocked marker; changing blocked status preserves other tags.

Evidence: `tests/task-editor-patch.test.mjs`, existing editor wiring tests,
and an actual browser test: open a synthetic task, edit its title and clear
origin, update its description independently, then save. The new description
survived, and the cleared origin remained empty after reopening.

This mitigates cross-field lost updates. It does not detect two writers changing
the same field; that requires conditional server writes.

Files: `src/lib/tasks/editor-patch.ts`, `TaskDetail.tsx`, `TaskFieldsEditor.tsx`.

### Narrow browser and dependency hardening

- `npm run dev` and `npm start` default to `127.0.0.1`, matching the supported
  local-only deployment. The installer already used loopback.
- Responses include CSP `frame-ancestors 'none'`, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, and `Referrer-Policy: same-origin`.
  The isolated production server returned these headers and bound to loopback.
- Compatible lockfile updates patch `nanoid`, `@humanfs/node`, and `browserslist`,
  with their required transitive updates. No framework or model version changed.
  The lockfile now also agrees with the package's supported Node engines.
- The final isolated dependency installation reports zero npm advisories.
  That is a registry scan result, not proof that every dependency is secure.
  No application exploit was demonstrated for the original advisories.

Advisories: [Nano ID](https://github.com/advisories/GHSA-2v37-7h3g-55p8),
[humanfs](https://github.com/advisories/GHSA-p498-v437-472g),
[Browserslist cache](https://github.com/advisories/GHSA-c83g-rgw3-j3cx),
[Browserslist stats](https://github.com/advisories/GHSA-73wf-gq98-2v4g).

### Documentation and comments

Updated README, architecture, security, data, operations, and the codebase map.
Removed the false claim that email triage is the only feature contacting the
internet. Distinguished local storage from context sent to model providers.
Corrected backup retention to 14 snapshots, removed the unsafe single-file
reset recipe, and documented backup scope and failure behavior. Documented
actual per-lane model controls and the Quiet Current JSON-store exception.
Comments around the modified backup, scheduler, and editor paths explain the
invariants their implementation actually enforces.

Historical design records remain historical; they were not rewritten to suggest
that old decisions or acceptance results describe current behavior.

## Remaining findings and decisions

### P1: Quiet Current can lose concurrent decisions (confidence 10/10)

`src/lib/quiet-current/store.ts:175` writes a whole JSON snapshot and renames it.
Creation reads at line 333 and writes at 384; resolution reads at 402 and writes
at 448. There is no shared lock around the read-modify-write transaction.
The web process, chief-of-staff driver, and weekly reviewer call this store
independently. Atomic rename prevents partial files, not lost updates.

A deterministic two-process synthetic test reproduced acceptance disappearing:
one process accepted a suggestion, another saved a new suggestion from its old
snapshot, and the final file reverted the first suggestion to proposed and
removed its acceptance event. Live frequency was not measured.

Recommended major change: move suggestions and decision events into SQLite
transactions, with an idempotent JSON import, backup of the source file, and
rollback/acceptance tests. A complete shared locking protocol is a smaller
alternative. Do not migrate live state as incidental cleanup. SQLite backups
currently do not include this JSON file or private settings.

### P1: Background Codex configuration is inherited (confidence 9/10)

`src/lib/model-runner-runtime.mjs:51` starts `codex exec --sandbox read-only`
without independent tool/configuration isolation. Lines 81 to 83 retain HOME
and CODEX_HOME. Untrusted email and meeting text reaches this runner. Read-only
filesystem access does not itself disable personal shell, app, or MCP tools.

Recommended change: explicit capability profiles and isolated configuration,
preserving intentional research access. The chief-of-staff lane already offers
an isolated configuration pattern. The operator chose documentation only;
execution and models are unchanged. No exploit or compromise was observed.

### P2: Same-field task conflicts remain (confidence 9/10)

`src/lib/data/tasks.ts:143` still updates by task ID alone. The new sparse edits
protect unrelated fields, but two simultaneous edits of one field remain
last-writer-wins. Recommended next step: conditional writes with a consistent
revision and visible conflict handling across editors and automation writers.
This touches the shared task-write contract and should be a deliberate change.

### P2: Chief-created advance reminders can be ineligible (confidence 10/10)

`src/lib/chief-of-staff/driver.ts:484` inserts `remind_at` without a notification
policy. The advance reminder query in `scripts/cove-reminders.mjs:675` requires
`predeadline` or `both`. A synthetic action stored the timestamp successfully
with NULL policy, making it ineligible. Updating an existing reminder also
omits delivery-state reset.

Recommended change: unify reminder scheduling rules while preserving explicitly
disabled notifications. This changes actual notification behavior, so the
review did not enable or reinterpret reminder delivery silently.

### P2: Pause and same-day resume loses the recurring occurrence (confidence 10/10)

`src/lib/tasks/recurrence.ts:657` deletes today's open occurrence after archiving
its task, while retaining `last_spawned_local_date`. Resuming the same day leaves
no date for `dateRangeAfter` to spawn. A synthetic daily rhythm reproduced zero
spawned tasks, an archived task, and no occurrence.

Recommended decision: should Resume restore today's paused task or resume only
future occurrences? If restoring today, preserve task/occurrence identity and
separate pause from manual archive. Simply rewinding the date collides with
existing uniqueness rules. No recurrence lifecycle was changed in this pass.

### P2: Buddy's seed can load hooks (confidence 8/10)

`src/lib/buddy/spawn-session.ts:41` disables model tools and inherited MCP,
but does not explicitly disable project or user hooks. Hook execution is
separate from model tool calls. Local CLI help confirms a safe mode exists.
Recommended change: isolate the inert seed and verify normal interactive
resume still works. Documented only under the operator's execution constraint.

## Validation and release state

- Supported Node 24.19.0 in a disposable copy with its own dependency install.
- Full final suite after integration: 1,221 passed, zero failed, one intentional
  opt-in live-model test skipped. Open-file/WAL restore refusal tests ran.
- TypeScript, zero-warning lint, and production Webpack build pass. Webpack is
  the existing documented release-gate build path.
- Browser verification passed for stale cross-field protection and origin
  clearing; response headers and loopback binding were observed.
- Independent final review found no material regressions. Its expired-lease
  observation was fixed and covered by an additional regression test.
- Tracked credential-pattern scan found only a private-key marker in a redaction
  test fixture, not a credential. Git history was not secret-scanned.
- No clean-machine install, live integration acceptance, real model behavior,
  exhaustive browser/accessibility audit, or production restart was performed.
- Changes are in source and lockfile, uncommitted. The live web build and installed
  dependency tree were not replaced. Scheduled scripts may load their source
  changes on their next run. Existing daily backup LaunchAgents still work;
  a future installer refresh adds the explicit `--daily` argument.

Before activating the web/dependency changes, build with the intended install's
settings and a supported Node version, then deliberately restart and smoke-test.
Do not deploy the synthetic review build: it intentionally excludes live settings.
