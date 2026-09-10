# Daily planning and background usage review

September 7, 2026. Scope: reliable daily planning and sustainable follow-through.

Cove should let the person focus while it remembers, prioritizes and follows
through. Its own background activity must not prevent the daily planning ritual.

## Verified failures

- The September 7 brief request was 101,106 bytes, exceeding a separate 96,000-byte
  runner input guard. The guard rejected the request before a model call.
- The same generic runner_budget_exceeded code represented both oversized input
  and a rolling call allowance denial. Arrival showed an unhelpful retry message.
- At inspection, unattended work had consumed all 24 calls in the prior 24 hours:
  14 chief/review calls, 6 email classifications, 3 progress checks, 1 voice review.
  The chief could consume the quarter reserved for itself and the brief.
- This was not proof that the chief's calls were wasted. The installation had
  370 active responsibilities and 233 without an initial review. Recent snapshots
  included 11 at a time. Existing due-check scheduling, coalescing, source-version
  checks and deferred jobs prevent repeated blind polling and preserve omissions.
- A selected provider's 120-second background timeout also silently shortened
  the brief's configured eight-minute writing window.

## Implemented behavior

- Morning Brief and closeout have a separate call pool. Background monitoring
  cannot consume it, and planning cannot consume monitoring's allowance.
- Default call ceilings are 12/hour, 96/day and 400/week per pool. They remain
  explicit workload limits, not estimates of a provider subscription balance.
  Saved settings are preserved by code upgrades; the personal update explicitly
  changes only the three call counts, retaining the selected model and effort.
- Daily planning is exempt from the small per-call input/output guard and retains
  its own timeout. Existing relevant-source selection, source freshness, schema,
  evidence and action validation remain. A 4 MiB technical response boundary
  protects the local process; it is not an editorial brief-length requirement.
- Codex diagnostic output is drained separately from its final brief artifact.
- If planning exhausts its own allowance, the same brief remains queued until
  its next eligible time. That state survives restart and retries automatically.
- Input-size and database/runner errors no longer masquerade as quota denial.
  Arrival shows safe error categories and the actual scheduled retry state.
- Issues separates planning from background usage and explains that background
  calls include work Cove does while the person is away.

## Scope and remaining boundaries

No new source was added to model context. Goals/closeout expansion of the
continuous chief remains separately pending. No integrations or shadow alert
settings were changed. The inherited shared-runner tool configuration remains
as previously chosen. Deterministic reminders and existing external-action
approval boundaries remain unchanged. The supported service still runs on one
Mac and cannot work while it is asleep or offline.

The initial responsibility backlog needs reviews to complete; increased allowance
alone is not proof of review quality or long-term subscription sustainability.
This change fixes starvation of daily planning without suppressing those checks.

## Validation

- New large-input and pool-isolation regressions fail against the original code.
- Both selected-provider adapters accept a large context and long valid result
  after background exhaustion. Reverse isolation, retries, timeouts, exact-lane
  classification, oversized final artifacts and diagnostic chatter are covered.
- Store restart and worker integration prove no premature model spawn and
  automatic resume of the same queued brief. Polling respects visibility and
  prior user interaction. Failure UI never exposes arbitrary diagnostic text.
- Full verification passed typecheck, zero-warning lint, 1,305 tests with one
  opt-in test skipped, and production build. Two additional worker/polling tests
  passed afterward. Two independent reviews found no blocking issues.
- Personal cutover preserved all 61 table fingerprints and restored all 14
  services. The existing selected Astra low wrote a real validated brief from
  101,120 input bytes. Morning Arrival displayed it at 14:42 PDT. STATUS.md holds
  the artifact, build and recovery references. Three jobs held by the old daily
  allowance were released for normal review under the updated settings.

## Follow-through timeout and notification repair

Alex received a scheduler failure banner. The corresponding chief review died
after two attempts at exactly 120 seconds each. Selected-provider execution had
inherited the monitoring timeout instead of the chief driver's 15-minute window.
The exact chief lane now honors that window or an explicit caller override.
Its existing 20-minute scheduler lease is renewed while the process runs.
Background call and byte limits still apply.

Scheduler banners now explain the affected work and open Issues. Issues supplies
a safe cause, accurate retry status, an immediate fallback and setup-agent repair
ownership. Older stored job failures receive the same safe presentation; raw
errors remain available in stored details. No provider diagnostic is echoed into
a banner. Existing delivery gating remains in place.

Validation: typecheck, zero-warning lint, 1,309 passing tests, one opt-in skip,
and production build. A further historical-message fallback test passed with the
scheduler suite. A fresh independent review found no remaining P1/P2 findings.
Native delivery arguments are tested with a fake notifier, including privacy and
Issues-link assertions. The user's received banner already confirms delivery
for this reported event; no synthetic failure banner was sent.

Live acceptance: build `wODKk289jhpR8ODYbs3SQ` preserved all 61 database table
fingerprints and restored 14 original services. The exact failed chief review
was requeued, waited for its normal hourly allowance, completed on the first
attempt at 16:00:49 PDT, and automatically resolved its issue. Native notification
wording was verified through captured notifier arguments; the real Issues page
was checked in the browser. Alex later explained that Tailscale was off on the laptop. Keep the existing
Mini text route; he will keep Tailscale on. Native notifications are the priority.
No text message or route change was made in this repair.


## Native reminder priority and task links

Live evidence: three overdue reminders were submitted at 08:01 PDT and the noon
floor used a fourth banner. Carlo Kemp's 17:00 follow-up advance warning remained
pending because it inherited the routine cap. Approaching deadlines now have
access to the penultimate slot, with the final slot kept for meetings or urgent
mail. A morning advance warning also preserves the noon floor. The total remains
six. Within a check, meetings and advance warnings precede the overdue backlog.

Native task reminder links already included a task ID, but the browser ignored
it. Both Today and All Work now open the exact loaded task details. The requested
view consumes the link once and retains unrelated URL parameters. No task state
is changed by following the link.

Two new scheduling regressions fail on original code and pass on the repaired
code. Full verification passed: 1,313 tests, one opt-in skip, typecheck, lint and
production build. An independent fresh review found and helped resolve an All
Work initialization issue and reverse-order noon floor reservation gap; the
final review found no remaining P1/P2 issues. Browser and native acceptance are
recorded in STATUS.md after cutover.
