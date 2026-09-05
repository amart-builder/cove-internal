# Cove chief-of-staff methodology review

September 5, 2026. Reviewed implementation: `967c3b6` (runtime implementation
`b3a5ce3`). Scope: prompts, agent context, scheduling, capture, prioritization,
notification policies, action authority, usage limits and outcome evaluation.
This is a review and proposed product direction. No runtime behavior was changed.

## Conclusion

Cove is a useful personal work system with strong persistence and bounded
execution foundations. It is not yet a demonstrated service that assumes full
responsibility for every commitment from discovery through resolution.

The architecture should keep inexpensive deterministic checks and strong-model
judgment when needed. A model thinking continuously would not fix the principal
gaps: missing context, weak follow-through state, deadline rewriting, fragmented
notification policies and absence of outcome-based acceptance tests.

The earlier readiness recommendation applies to a supervised first client pilot.
It does not establish the stronger promise that a person can stop monitoring
all their own commitments. This review found concrete product gaps under that
higher standard, despite passing component tests.

Proposed guiding language is in [the north-star draft](cove-north-star-draft.md).

## What runs today

| Component | Actual job | Limits relevant to the promise |
| --- | --- | --- |
| Morning Brief | Reads goals, closeouts, commitments, email state, calendar and task evidence; recommends today's work. | A generated recommendation is not a continuously maintained plan. |
| Background chief | Wakes after brief, triage and meeting processing, plus 11:30/16:00 sweeps and 21:30 nightly review. The drain checks queued jobs every five minutes. | It receives a smaller desk view than the brief, not the same complete context. |
| Saved-provider reasoning | Uses fresh bounded Claude or Codex calls with durable desk/journal context. | Continuity depends on what the next snapshot includes; it is not an unlimited persistent conversation. |
| Reminder worker | Runs each minute while awake. Checks explicit reminders, due items, and deterministic follow-through. | Different paths have different timing and suppression semantics. |
| Meeting follow-through | Refreshes the next 30 minutes of calendar at most every five minutes; attempts a banner within 15 minutes of a meeting. | This is a reminder, not prepared meeting material or proof the person saw it. |
| Email | Scheduled observation, classification, drafts and reconciliation; configurable times, default 09:00 and 15:00. | Scheduled email checks are not continuous urgent-email detection. |
| Buddy and task sessions | User-facing conversation and authorized task preparation/execution. | Separate from the background chief. A background wake cannot launch arbitrary preparation work through its action vocabulary. |
| Weekly review | Reviews journal, action counts/rejections and recent suggestion outcomes. | No independent inventory of missed commitments or importance-adjusted completed outcomes. |

Evidence: `CODEBASE_GUIDE.md`; `scripts/install-cove-local.sh:844-920`;
`scripts/launchd/com.cove.chief-of-staff-{drain,sweep,nightly}.plist`;
`src/lib/chief-of-staff/driver.ts:898-935`; `src/lib/chief-of-staff/review.ts:98-180`.

## Strengths to preserve

- Durable jobs, retries, claims, action receipts and transactional local storage.
- Narrow, validated action and external-tool boundaries. Email drafts are not sent.
- Exact model choice without silently falling back to a weaker model.
- Deterministic checks do not consume model calls or stop merely because the
  background model budget is exhausted.
- Morning Brief already contains valuable direction on goal alignment, repeated
  carryover, source authority, uncertainty and truthful claims about prepared work.
- Quiet Current separates inferred work from user-accepted commitments in the
  ordinary suggestion flow. Existing permissions and confirmations remain important.

## Findings, in order of importance

### 1. Overdue promises can be replaced with invented new deadlines

**Observed in the personal installation.** Three applied task updates after the
release moved overdue client work to new September 5 times. Their rationale cited
old deadlines and client priority, not an agreed renegotiation. This proves date
rewriting, not that the clients were actually harmed or that the tasks were done.
The stored dates alone do not establish which deadlines were externally promised;
that missing distinction is part of the problem.

The private mandate explicitly says to move slipped dates at the nightly wake.
The handler accepts a new `due_at` and overwrites `due_date` as well. This can
hide the distinction between the original promise and a proposed recovery plan.
The action ledger preserves the outgoing action, but the task loses the original
active deadline unless it is reconstructed from other evidence.

**Required change:** preserve the externally promised deadline; represent a
planned work time separately. If delivery is at risk, propose a recovery plan or
ask for a renegotiation decision. An agent must not create evidence that somebody
agreed to a new date. Do not silently roll unfinished work into a fresh due date.

Evidence: private `data/cove-mandate.md`, jobs 1/7 and rules;
`src/lib/chief-of-staff/driver.ts:522-558`. Private names/details are intentionally
excluded from this report.

### 2. Important work can be invisible to the background chief

**Reproduced with synthetic data.** The task query selects the first 40 open
items, sorting dated work ahead of undated work. The rendered section is then
cut to 4,400 characters. Recently created items are appended after that list,
so the intended recent-item protection can itself be truncated away.

With 45 long older tasks, both a high-priority undated project and a newly
created important commitment disappeared from the supplied snapshot. The latest
real snapshot had a truncated task section containing only 29 task lines.

The chief also has no dedicated current goals, latest closeout, accepted focus
plan, task descriptions, blocked state, or commitments/waiting-on section. The
personal mandate embeds manually maintained goals; the morning brief has richer
sources. Some facts may appear incidentally in receipts or journal, but that is
not dependable coverage. The real database contains separate open promise,
follow-up and waiting-on records. The deterministic noon floor does cover some
already-due promises/follow-ups, so the ledger is not wholly unwatched.

**Required change:** build a shared, bounded priority view from existing stores.
Reserve space for changed items, near-term risks, undated important work and
waiting items. Include omission counts and deterministic review eligibility for
anything excluded. Context size should be bounded without abandoning coverage.

Evidence: `src/lib/chief-of-staff/snapshot.ts:99-128,425-453`;
`src/lib/day-plan/brief-sources.ts`; `scripts/cove-reminders.mjs:311-354`.

### 3. “Watching” does not establish an accountable next check

The chief's `watching` output is an array of short strings recorded in its job
result. There is no corresponding structured next-check time, escalation
condition or completion criterion created from that output. The next snapshot
reads journal lines and receipts; it does not recover a dedicated watch register.
The existing commitments `review_at` field is a useful foundation, but the chief
neither sees a dedicated commitments section nor owns a commitment-update action.

A notification handoff is also not evidence that the person acknowledged or
resolved the risk. Shared cooldowns grow from 24 hours to 48 hours to seven days
as historical nudges accumulate. That controls noise, but it does not distinguish
“still ignored and now urgent” from “intentionally deferred with a sound plan.”

**Required change:** make every accepted obligation point to a next action,
owner, check time and resolution evidence. Reuse existing task/commitment IDs and
stores. Track acknowledged, deferred, blocked and resolved separately. Escalate
based on changed risk and explicit policy, not simply more frequent nagging.

Evidence: `src/lib/chief-of-staff/types.ts:25-30`;
`src/lib/chief-of-staff/driver.ts:1021`;
`src/lib/chief-of-staff/snapshot.ts:453`; `src/lib/attention/ledger.mjs:83-116`.

### 4. Alert coverage is narrower than the intended promise

**Confirmed configuration:** the personal installation has both chief judgment
alerts and urgent-email alerts in shadow mode. They record proposals rather
than interrupt. Deterministic task and meeting reminders remain active. This is
consistent with existing rollout rules, not a reason to silently enable them.

**Reproduced with synthetic data:** five older task banners consumed the new
follow-through allowance. A meeting entering its ten-minute window afterward
received no banner, stayed pending, and the endpoint still reported a healthy
checker. Meetings are ordered first within a tick, but cannot recover allowance
already spent on earlier ticks. A meeting can then expire without delivery.

Email timing is another limit. A default twice-daily check cannot discover an
urgent message within minutes. The five-minute chief drain adds latency after
upstream processing. A sleeping or closed Mac cannot check anything.

**Required change:** separate operational health from protection coverage.
Reserve attention for time-sensitive meetings and consequential risks, make
suppressed critical items visible, and validate actual native banner receipt.
Design and accept an explicit urgency policy before enabling intelligent alerts.
Use frequent cheap source-change checks with bounded classification when data
changes. Do not imply a 24/7 service from laptop-only execution.

Evidence: `data/attention-sweep.json` (private configuration);
`src/lib/attention/email-urgency.ts:23-35`;
`src/lib/attention/follow-through.mjs:74-85,111`;
`scripts/install-cove-local.sh:880-920`.

### 5. Prioritization is stronger in the brief than in continuous execution

The morning mandate asks for goal alignment and notices repeated carryover.
The deterministic candidate fallback ranks due work, coarse priority, accepted
columns and position. It explicitly does not infer duration or people waiting.
The background chief lacks the complete daily plan and task detail needed to
reconcile that recommendation as the day changes.

There is no complete, verified path here for working backward from a deadline
using effort, availability and dependencies, detecting an impossible day, and
resolving the tradeoff with the person. Generic one-hour advance alerts and
15-minute meeting alerts are useful but cannot provide that planning judgment.
The private mandate is tailored to consulting revenue and clients; the brief's
client-delivery-first default should not become every person's universal values.

**Required change:** preserve the strong-model choice and improve the decision
inputs. Recommend a feasible few outcomes, identify what will deliberately wait,
and turn repeatedly carried work into a smaller step or a blocker decision.
Separate invariant chief-of-staff rules from each person's goals and preferences.

Evidence: `prompts/chief-of-staff.md`, Judgment and Recent Closeouts;
`prompts/chief-of-staff-mandate.md`; `src/lib/day-plan/candidates.ts:361-404`;
`src/lib/chief-of-staff/types.ts:58-68`.

### 6. An action can be valid without being justified

**Reproduced with a synthetic task.** A `task_update` setting status to `done`
with rationale “I assume this was finished” was accepted. This probe called the
handler directly; it does not claim the live model produced that output.
The schema/handler validate shape and record existence, but do not require
completion evidence or a source-version precondition for this update. A model
can also overwrite fields that changed after its snapshot.

The prompt's instruction to cite a source in `why` is not a mechanical check of
that source. The general principle “facts act, judgment proposes” needs stronger
support on consequential task changes.

**Required change:** evidence-backed completion and due-date changes, plus
expected versions or expected prior field values. Unsupported completion becomes
a suggestion. Apply the same protection to stale background writes that already
protects task-editor conflicts. Preserve all external-action restrictions.

Evidence: `src/lib/chief-of-staff/types.ts:134-167`;
`src/lib/chief-of-staff/driver.ts:522-558`.

### 7. Shared call caps can stop the chief at the wrong time

The saved-provider budget is one shared rolling count across model lanes:
6/hour, 24/day, 100/week in the personal install. Routine classifications and
progress checks can use capacity needed for a meaningful chief decision. There
is no reservation by importance. A quota denial becomes a runner failure; chief
jobs have two attempts and the scheduler handles it as an ordinary retry/dead
job, not a deliberate pause until capacity returns.

The observed usage sample contained 18 calls: nine email classifications, seven
progress reconciliations and two chief wakes. That is a workload sample, not a
subscription forecast. Token counts include cached input and cannot be mapped
reliably to a percentage of the subscription here.

**Required change:** coalesce changes, avoid no-change model calls, batch related
classification, reserve capacity for core reviews and meaningful risks, and keep
budget-denied work durably deferred until the actual reset time. Deterministic
reminders remain available. Keep visible usage limits; do not promise a monthly
subscription duration from call counts.

Evidence: `src/lib/background-usage.mjs:28-44`;
`src/lib/model-runner-runtime.mjs:357-372`;
`src/lib/chief-of-staff/storage.ts:451`; `src/lib/reliability/jobs.ts:493-550`.

### 8. Successful execution has not yet proven chief-of-staff quality

Current tests establish many important data and process invariants. The weekly
review mainly sees what the agent said and attempted, action counts/rejections,
and recent suggestions. It does not independently compare incoming commitments,
missed deadlines, acknowledged warnings, completed high-value work and the
person's planning burden.

The three new probes reproduced product failures while the 76 existing focused
tests passed. This is evidence of missing acceptance coverage, not evidence that
all previous testing was ineffective. Neither model family has been measured
against a representative chief-of-staff outcome benchmark in this review.

**Required change:** evaluate scenarios and longitudinal user outcomes. Do not
use an agent's self-rating or task-completion count as the main success measure.

## Recommended method

Use one logical chief-of-staff responsibility implemented by several bounded
components. The durable state, priorities and evidence should be coherent even
when a fresh model call does the next piece of reasoning.

1. Observe connected sources and their freshness cheaply while the Mac is awake.
2. Record explicit obligations with provenance; queue uncertain interpretations.
3. Reconcile new evidence against existing commitments before proposing more work.
4. Compute upcoming check times and obvious deadline risks deterministically.
5. Invoke the strong model for meaningful changes, morning planning, risk tradeoffs
   and a small end-of-day reconciliation. Supply only relevant changes plus a
   compact, complete summary of goals, accepted work and unresolved risks.
6. Apply validated actions, record the outcome, and schedule the next check.
7. Tell the person what matters now, what is being handled, and any material gap
   in coverage. Interrupt only under the agreed urgency policy.

The model should not need to stay alive or retain an ever-growing transcript to
remember its responsibilities. The application's records and scheduled checks
must carry that responsibility between calls.

## Acceptance scenarios before the stronger promise

| Scenario | Required proof |
| --- | --- |
| Bob's Friday proposal appears in a meeting | Capture once with source and original deadline; plan preparation before the deadline; preserve it through restart. |
| A reply to the boss is still outstanding | Verify current mail state; draft is not completion; resurface the decision at an appropriate time. |
| An important video task carries over repeatedly | Identify the blocker or smaller first step and propose a realistic plan rather than repeat the same headline. |
| Fifty older tasks compete with one new important promise | The new promise and an undated strategic task remain eligible for review despite context bounds. |
| Several minor reminders precede an important meeting | Meeting warning still has reserved capacity or an explicit, visible alternate handling path. |
| The model assumes something was completed | Handler refuses unsupported completion and preserves the open obligation. |
| More work is due than fits in the available day | Recommend what to defer, delegate, reduce or renegotiate without inventing a new agreed deadline. |
| Email or progress work consumes the ordinary AI budget | Core risks retain reserved capacity; deferred work resumes after reset without disappearing as a dead job. |
| Calendar access fails, the Mac sleeps, or notification delivery is uncertain | Show the actual coverage gap; reconcile on return; never present missing protection as “all clear.” |
| Work is delegated or waiting on someone | Persist a return/check condition, detect the response and verify closure without duplicate follow-ups. |

Use deterministic tests for records, timing and delivery claims. Use blinded
scenario review of real Claude/Codex outputs for judgment and groundedness.
Then follow a supported client through real working days, comparing missed
commitments, useful interruptions, planning time, correction burden and actual
model consumption with their baseline. A 20 to 30 times gain is not established.

## Implementation order and boundaries

1. First repair truth: preserve promised deadlines and require completion evidence.
2. Then repair coverage: shared context, durable next checks and omission handling.
3. Then repair interruption and budget priorities; validate and deliberately enable
   the intelligent alert policy with the operator.
4. Add feasible-day planning and avoidance support, then run the scenario suite and
   supported client evaluation before making broad reliability claims.

These are recommendations. No settings, mandates, notification policies, tasks,
services or public repository were changed by this review. The inherited shared
Codex background configuration remains unchanged as Alex requested previously.
A new always-on remote host would be a separate architecture decision, not a
prerequisite for improving the current single-Mac product.

## Verification record

- Read current source, public/default and private mandate, scheduling templates,
  background limits, live action ledger and latest stored snapshot.
- All live database inspection was read-only. No real tasks were created or edited.
- Ran five existing test files: 76 tests passed, zero failures, zero skips.
- Ran three isolated synthetic probes with no model calls, network connections
  or real notifications. All three reproduced the findings described above.
- Durable private evidence: `data/review-artifacts/2026-09-05-chief-methodology/`.
  This is a behavior review, not a new deployment or a full release gate.
