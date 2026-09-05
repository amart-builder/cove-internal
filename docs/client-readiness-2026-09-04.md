# Cove client readiness, September 4, 2026

## Current state

The implementation is published in the public Cove repository and deployed to
Alex's personal running Cove. Public PR 1 merged as `badb7af`; the sanitized
manifest records clean source `9451a59`. Private PRs 6 and 7 merged the matching
implementation. Alex's Codex CLI is 0.153.4, and his app now uses GPT-6 Astra on
low with bounded background work. All 14 existing services resumed on pinned
Node 24.19.0. No client installation has been performed yet.

The previous document mixed an old proposal with unfinished engineering work.
This document supersedes that proposal: Full Cove includes the chief of staff
and deterministic follow-through as its standard guided setup. It does not make
the client design a collection of background services.

## Implemented

1. **One agent choice.** Setup recommends the tool receiving the request, asks
   one model question, and verifies access before saving. Starting recommendations
   are Claude Fable 5.1 (`claude-fable-5-1`) low or GPT-6 Astra (`gpt-6-astra`) low.
   The exact selection applies to standard background jobs, chief-of-staff
   reviews, Buddy and task sessions. No silent fallback. No saved settings keeps
   existing installations on their legacy behavior.
2. **Complete provider paths.** Buddy conversation, replanning, compaction,
   sign-in recovery, spawned sessions, task output and native resume support the
   selected provider. Switching providers starts fresh without transferring
   private chat history. Tasks remain available. Codex task work uses
   on-request approvals; Buddy uses automatic approval review and only Cove's
   validated data tool. The retired day-plan execution queue remains a Claude
   compatibility path and rejects Codex with guidance to supported task controls.
3. **Gentle reminders without continuous model spend.** A deterministic worker
   checks eligible approaching/overdue tasks and connected meetings. Calendar
   observations refresh at most every five minutes. Quiet hours, recent activity,
   deduplication and shared banner limits suppress unnecessary interruptions.
   A one-hour snooze persists. Uncertain delivery is visible and is not blindly
   retried. The existing explicit-reminder path survives checker failure.
4. **Visible bounded AI work.** Background attempts reserve capacity before
   starting: initially 6/hour, 24/day and 100/week, with bounded input, output and
   runtime. Retries and failures count. Issues shows the model and usage limits.
   This is not a provider subscription meter or a guarantee that $200 lasts a
   month. Interactive Buddy and task sessions are outside these background caps.
5. **More reliable data.** Quiet Current uses transactional SQLite with a
   validated legacy import. Editors preserve unrelated changes and reject
   same-field conflicts while retaining typed text. Pausing and resuming a
   recurring task on the same day retains its identity; note edits do not turn
   paused occurrences into missed ones. Backups validate snapshots, report real
   failure and avoid running unrelated jobs.
6. **Clearer setup and health.** Only the selected CLI is required. New Full
   installations include the chief service after mandate/model preflight.
   Basic Mode retains its separate contract. Empty Today provides a useful
   next step. Reminder coverage distinguishes stale checks and missing calendar
   access. Documentation describes actual process and permission boundaries.

## Verification

- Automated tests exercise both providers using controlled fake CLIs, process
  termination, migrations, concurrent writes, shared quota reservations,
  reminder policies, uncertainty, snooze, installer prerequisites and recovery.
- The exact final 533-file sanitized package passed TypeScript, zero-warning
  lint, 1,278 tests with zero failures and one intentional live-model skip, and
  the production Webpack build. Locked dependency installation reported zero
  npm advisories. Export secret-pattern/setup checks passed; manifest hashes
  were verified. The dependency scan is not proof that every dependency is secure.
- Live GPT-6 acceptance with Codex 0.153.4 passed a tool-free conversation,
  fictional task capture through Cove's real MCP data tool, and a planning run
  with saved native session ID, exact model/effort and a ready output. The task
  and due date were checked directly in the synthetic database.
- The live tool test exposed an approval-policy incompatibility, corrected to
  on-request with automatic review. No approval denial is bypassed or reported
  as a successful change. Independent fresh-context review found no remaining
  material issue in that correction or the final data/UI fixes.
- Isolated browser checks confirmed Today, task conflict text preservation,
  source freshness, usage display and snooze after restart. Buddy found and
  edited a fictional task through the real model/tool path and showed a verified
  saved receipt. Its database change and retained due date were checked.
  Shared task-session wording now says agent rather than incorrectly naming
  Claude. Real macOS banner delivery and connected-calendar coverage were not
  exercised in this pass. The test server and browser were stopped.
- Claude is not currently signed in on this Mac. Claude's real model, tools,
  brief quality and full client workflow remain acceptance checks, despite
  passing automated provider-path tests.

## Client acceptance and release boundary

A successful build is not a finished client installation. Follow SETUP.md with
the client's signed-in chosen provider, real open work and priorities, useful
first brief, task capture/edit, closeout, backup and restart persistence. Record
which services are active and verify each chosen external integration with the
client. Phone/shared access and work while a Mac sleeps are not part of the
single-Mac product. Cove cannot promise that nothing will ever be missed.

Publication and personal deployment are complete. The private environment file
was unchanged, and all 246 task records matched exactly before workers resumed.
Consistent pre-cutover backups, previous build/dependencies and original service
files are retained in private ignored deployment storage. Today and Issues
rendered successfully without browser console errors. Worker readiness and fresh
calendar/deadline coverage passed after restart; real Astra background calls
succeeded. Native banner visibility still needs manual acceptance. Existing
historical contact-resolution and remote text-reminder issues were preserved.

The shared Codex background runner's inherited personal configuration and the
Claude session-seed hook boundary remain documented in
SECURITY_AND_INTEGRATIONS.md. Alex explicitly chose documentation instead of
changing shared-runner isolation. Private client context is excluded from the
sanitized package.

## Saved artifacts

Final verified client checkout: `/private/tmp/cove-client-final`.
A durable copy is saved under the private, gitignored directory
`data/review-artifacts/2026-09-04-client-readiness/` in the main Cove checkout:
`cove-client-ready.tar.gz` contains only the sanitized package. The separate
implementation patch and new-files archive preserve internal development work
against base `bf15ba04bd86bbe14d73ba89a2f117879f78bf86`. The artifact README
explains recovery into a clean isolated checkout. No live data or credentials
are in the client archive.

The public release checkout is `/private/tmp/cove-public-release-20260904`.
Its exact contents passed the full verification gate before publication. Personal
deployment used a separate production build with this installation's own private
configuration. Recovery details are in
`data/deploy-backups/2026-09-04-ec4650e/README.md`.
The next acceptance step is the client's own signed-in setup using SETUP.md.
