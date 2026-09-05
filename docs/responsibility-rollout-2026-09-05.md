# Chief-of-staff responsibility rollout

Status: published to public Cove. Personal installation cutover is pending.

This candidate implements changes across the four requested improvements: trustworthy
records, durable next checks, feasible planning, and dependable attention with
bounded preparation. The north star is freedom to focus with confidence that
commitments are being looked after. Every accepted commitment needs a reliable
path to its next decision.

Implemented in the candidate:

1. First-observed deadlines are retained. Proposed work times are separate.
   Chief edits require current source fingerprints. The chief cannot complete
   tasks or move deadlines on assumption. Morning Brief board actions cannot
   rewrite an existing deadline. Legacy task_create is downgraded to a proposal,
   so model inference does not create accepted work. Source closure and changed records reconcile.
2. Every open task and non-idea commitment receives durable next-check metadata.
   Fair bounded review selection covers new, urgent, undated and waiting work.
   Unseen rows remain due. Changed source or plan revisions reject stale edits.
   The existing five-minute chief drain coalesces due work into bounded wakes.
3. Your follow-through shows accepted or proposed work, merged calendar time,
   proposed effort, overload, missing estimates and repeated carryovers. It uses
   a visible 9am to 5pm assumption and 30% buffer. One draft per agent wake can be
   persisted with source version and shown for review. Drafts never imply sending.
4. Ordinary banners leave room for the noon floor and two time-sensitive alerts.
   Confirmed commitments have native deadline coverage without copying to tasks.
   Missed and uncertain notifications remain visible. Acknowledgement quiets
   supported attention paths for one hour without completing the obligation.
   Routine AI calls preserve part of the same allowance for chief and brief;
   budget denials defer jobs without burning execution retries. No-change email
   runs no longer wake the chief.

Pending specific consent: automatic approval review rejected adding private
goals, latest closeout and accepted daily focus to background model calls. The
question is pending. No such new background context is connected. Existing
Morning Brief context and local-only planning reads are unchanged in authority.

Unchanged operational boundaries: intelligent attention and urgent-email lanes
remain shadow until their live acceptance; no external sending or integration
activation; no provider downgrade or increased total call budget; no changes to
inherited personal Codex configuration. A sleeping Mac cannot notify. Email is
observed at its configured schedule, so this is not an instant email monitor.

Acceptance requires synthetic outcome tests, full typecheck/lint/test/build,
independent review, actual UI review and a selected-provider structured-output
rehearsal. These checks do not establish a longitudinal guarantee that no work
will ever be missed. Release and live-cutover evidence will be recorded below.

## Validation and remaining rollout gates

- Final private and exported-client release gates both passed typecheck,
  zero-warning lint, 1,294 tests (zero failures, one opt-in model skip), and
  production Webpack builds. Direct route checks cover foreign-host rejection,
  CSRF, stale acknowledgement and unknown calendar coverage.
- Independent reviewer resolved deadline-bound, acknowledgment, creation-trust
  and initial-selection findings. Latest independent focused run: 45 passed.
- Actual GPT-6 Astra at low effort produced two concrete plans and one persisted
  proposal outline from fictional data, with three accepted actions, no rejections,
  unchanged source status and unchanged deadline. The first restricted-network
  attempt timed out; the second succeeded. The fixture limited the whole rehearsal
  to two calls. No private goals, closeout, accepted focus or live task data went
  through this rehearsal.
- Production build passed with the supported Webpack release-gate compiler.
- Initial browser acceptance was stopped by the memory monitor at over 9 GB
  swap. A later attempt below the stop threshold loaded successfully. Verified
  acknowledgement and its persistence across reload/restart, draft expansion,
  honest unknown calendar status, and navigation from Today. No browser console
  errors were reported. Memory protection and live runtime remained unchanged.
- Release scope uses the currently approved background context. Additional
  goals/closeout/focus sharing remains a separate pending change and is absent
  from this release. Native sender acceptance has OS display evidence; personal
  confirmation is still outstanding. Before personal cutover, require healthy
  memory, a fresh backup and successful restart checks. New intelligent alert
  lanes remain shadow until their own supervised acceptance.
- Adding private goals, closeout and accepted focus to the chief remains paused.
  The code does not yet deliver shared personal-goal context across all agent
  lanes. Its local feasible-day view is useful but is not a claim that the full
  chief-of-staff vision has been demonstrated in everyday use.

Final private release gate: `npm run verify` passed typecheck, zero-warning lint,
1,294 tests (zero failures, one opt-in skip), and the production Webpack build.
The 541-file candidate client export passed its explicit allowlist, secret
patterns, setup-text checks and live-data exclusion. It has not been published.

The exported client candidate independently passed `npm run verify` with the
same 1,294 passing tests, one opt-in skip, typecheck, lint and production build.
Verification logs and the fictional model result are retained locally under
`data/review-artifacts/2026-09-05-responsibility/` in the candidate checkout.

## Acceptance follow-up

- Candidate base commit: `8bab4a5`. Browser testing found missing draft-copy
  success feedback. The follow-up shows copying, success and manual-copy recovery
  beside the draft. An independent fresh-context reviewer found no blockers.
  The rebuilt client passed all release checks again (1,294 passed, one opt-in
  model skip). The browser visibly reported "Draft copied." No clipboard contents
  were inspected after automatic approval review rejected that diagnostic read.
- A verified online backup of the personal database was migrated and reconciled
  only in an ignored local copy. All 57 original application tables, including
  247 task records, retained identical row hashes. Repeating migration and
  reconciliation also preserved them. SQLite quick_check passed, foreign-key
  violations were zero, and 363 responsibility records were initialized.
  The original live database was not migrated by this test.
- Alex keeps Do Not Disturb on and authorized Cove notifications through it.
  Added only Cove Notifications to its Allowed Apps, preserving the existing
  five exceptions and the disabled broad time-sensitive bypass. Notifications >
  Cove already had Allow notifications, desktop display and temporary style on.
- Alex did not notice the first two test banners. For the second test, macOS
  logs explicitly reported Focus interruption suppression as none and displayed
  the exact test identifier as a banner. A third test used normal sound. Human
  confirmation is still pending. Screen-sharing privacy settings were unchanged.
- SETUP.md and OPERATIONS.md now cover Focus exceptions and distinguish Cove
  Notifications from Terminal and terminal-notifier. A successful sender exit
  still does not by itself count as a visible-banner acceptance.

## Release preparation

Alex asked to continue. Release the already tested implementation with existing
context permissions; do not treat that instruction as consent to add new private
context to model calls. The original four-part vision is only partially proven.
The selected model and total call caps remain unchanged.

The source and client code are unchanged since the passing release gate. The
client export from clean commit `617b2ec` contains 541 files and passed the
allowlist, secrets and live-data checks. Its only differences from the last fully
verified client tree are the tested setup/operations Focus documentation.

At release preparation, the Mac again had more than 8 GB swap in use, above the
existing monitor's server-stop threshold. Public/private review preparation can
proceed independently. Do not bypass the memory monitor for a personal cutover.

## Public release outcome

Public PR [#2](https://github.com/amart-builder/cove/pull/2) merged to public main
`3cb57435c3933e122c6c88ba511b5db0836658cd`. Every one of the 541 allowlisted file
hashes matches the committed export manifest. Final independent code and docs
reviews found no unresolved blockers. No new source changes followed the passing
1,294-test client gate; Focus guidance passed its separate docs/export checks.

The private development push was initially rejected by automatic approval
review. Alex subsequently explicitly approved `cove-internal`; that permission
is resolved. The branch is pushed and [private PR #8](https://github.com/amart-builder/cove-internal/pull/8)
is open with no merge conflicts. This did not block the public release. The personal installation is unchanged: memory pressure again exceeded
the existing monitor's server-stop threshold. Personal cutover needs a healthy
Mac and the already prepared backup/restart checks. Additional personal planning
context still requires its own permission before being added to model calls.
