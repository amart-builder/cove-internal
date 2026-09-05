# Chief-of-staff responsibility rollout

Status: implemented and independently reviewed in an isolated checkout. Not deployed.

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
- Browser acceptance remains unverified. The temporary loopback server started,
  then the Mac's existing memory monitor killed it at over 9 GB swap. The memory
  protection was preserved; the daily-driver checkout and services were unchanged.
- Required before rollout: answer the pending planning-context consent; inspect
  the actual UI and native notification on a healthy Mac; rehearse a backed-up
  live migration; review and merge the release, then perform restart checks.
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
