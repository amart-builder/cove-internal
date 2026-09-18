# Planning reliability log

Daily planning keeps producing small, similar failures: work that already exists
is proposed again, and a time Cove chose is written as though someone agreed to
it. This file records each observed incident, the class of cause behind it, the
deterministic safeguard that now prevents it, and exactly which evidence exists.
It is an engineering log, not a status report, and not a claim of acceptance.

The short runtime rules the planner sees live in
`src/lib/chief-of-staff/planning-lessons.ts`. Keep them short: they are sent with
every planning call. Detail, history and proof belong here instead.

## Incidents

### 1. A proposed review time was written as an existing arrangement

**Incident.** A task asking whether a person had booked was described using an
AI-selected 8:30 time as if that were an agreed appointment. The saved task
follow-up was 9 AM, and no appointment had ever been established.

**Cause (class).** Three different facts share the word "time": a task follow-up
date, a booked calendar event, and an internally proposed review. Prose could
name any clock without saying which one it was, and a generated `nextCheckAt`
could silently replace a source date.

**Safeguard.** Clocks in new planning prose must be typed references. Cove
renders `{{action.N.nextCheckAt}}`, `{{action.N.plannedFor}}` and
`{{question.N.expiresAt}}` from the validated timestamp and appends the meaning
("proposed review time", "proposed work time", "question expiry"); source clocks
come from a separate `{{time.N}}` catalog and keep their own provenance labels
(`src/lib/chief-of-staff/planning-time-text.ts`). Literal invented clocks are
rejected. Lesson 2 tells the writer to name the person and action and use the
saved date when asking about an existing follow-up, and forbids promising or
denying reminder delivery that the supplied records do not establish.

**Regression evidence.** `tests/planning-time-text.test.mjs`: "an AI-selected
clock carries its proposed meaning into a question", "a prior internal review
retains its meaning when selected as source evidence", "captured Fable 2PM prose
versus 9PM saved check is rejected before persistence", "a proposed check cannot
become a promise of future agent execution".
`tests/planning-reliability-multiday.test.mjs` asserts that a question about a
document the records do not show as returned uses the saved follow-up date from
the task and carries no proposed-review label.

### 2. "Reuse the existing preparation" created a second record

**Incident.** The planner said it would reuse existing preparation, then created
a calendar-linked suggestion. The original, identical task stayed in Not Today,
so the same work appeared twice and only one copy was linked to the plan.

**Cause (class).** Intent in prose was not a link. The response had no field that
could point at an existing task, and the detailed review queue is bounded, so an
older task could fall out of context entirely and could then only be recreated.

**Safeguard.** `proposal.existingTask` is a required decision on every proposal
and may only name a task reference; the runtime schema narrows it to the task
`ref.N` keys actually supplied. When it is set, `validateDailyDecision`
normalizes the action to that task as the canonical source with `proposal=null`
and keeps the calendar occurrence as `supportingSources`, so one identity is
persisted (`src/lib/chief-of-staff/daily-planning.ts`). Every active task
identity is supplied as `existingTasks` outside the 10.5k detailed-review budget,
so a known task stays selectable when the queue is full. Duplicate canonical
references are rejected, and stale task or calendar sources reject the whole
decision before any write. Lesson 1 also forbids inferring a match from a
person's name alone.

**Regression evidence.** `tests/daily-planning.test.mjs`: "existing preparation
stays selectable when detailed responsibility context is full", "calendar
preparation explicitly reuses one task through persistence, Arrival and
acceptance" (one plan item, absent from `eligibleNotTodayTasks`, Start Day
creates no second task), "reused preparation rejects a stale task or stale
supporting calendar before writes", "a completed source cannot be reused as
existing preparation", "two different tasks for one person stay distinct records
in one plan", "the runtime planning prompt carries the short lessons and a
task-only existingTask field".

### 3. A supporting schedule was checked only at write time

**Incident (independent review).** Supporting sources were validated before
persistence and then dropped. A plan item kept only its task source, so
rescheduling the meeting after a reused preparation was generated left the item
`ready`, not stale, still carrying a "Meeting today" rationale.

**Cause (class).** Evidence a recommendation depended on was not part of the
stored item, so resolution could not see it change.

**Safeguard.** `DayPlanItem.planningSupport` stores the supporting references
(kind, id, version) that `persistDecisionLinks` validated. Items are stored as
JSON, so this survives the stored-plan path and a database reopen without a
migration or a second work store. `resolvePlanningItems` re-checks each support:
if it is gone, cancelled or at a different version, the item is marked
`planningStale`, its obsolete rationale and assumptions are withdrawn and the
brief annotation is dropped. The item's own `planningState` is untouched: a
meeting that moves never resolves, completes or cancels accepted work. Repeated
reads are idempotent, so this does not churn the plan version on every read.

**Regression evidence.** `tests/daily-planning.test.mjs`: "a rescheduled meeting
withdraws obsolete timing without resolving the reused task" (also asserts read
idempotence) and "a cancelled meeting cannot cancel the work it was preparation
for". `tests/planning-reliability-multiday.test.mjs` covers the same preparation
across a reschedule, a database reopen, explicit completion and the next day.
Pre-fix reproduction: `/tmp/cove-planning-opus-evidence/repro-flaw1-before.txt`.

### 4. Rendered time labels could exceed the field bounds that had just passed

**Incident (independent review).** Field lengths were validated on the authored
text, and Cove then rendered time labels into it. A valid 163-character
`nextAction` could be stored at 204 characters, and `readStoredDailyDecision`
then threw `planning_text_invalid` at its 200 limit: a decision Cove had accepted
could not be read back.

**Cause (class).** One bound was used for two different strings — what the model
wrote and what Cove stores.

**Safeguard.** `PLANNING_TEXT_BOUNDS` holds both: the `raw` bound, which is what
the JSON schema advertises and what a new response is checked against, and the
`stored` bound, which is `raw` plus four maximum rendered labels. Rendering
enforces a 100-character cap per label (`RENDERED_TIME_LABEL_MAX`), so the stored
bound is a real upper limit rather than an estimate, and the rendered text is
re-checked against it (`planning_rendered_text_too_long`) instead of failing
later at read time. Stored reads use the `stored` bound, so both new decisions
and legacy artifacts written under the raw bound remain readable. A useful brief
is no longer dropped because Cove's own labels made it longer.

**Regression evidence.** `tests/planning-time-text.test.mjs`: "a near-limit
action survives rendering and reads back from storage" (nextAction, rationale,
assumption and question each at their authored limit), "the authored bound still
rejects text one character too long", "stuffing one field with time references
fails instead of storing unreadable text", "an unbounded source label cannot be
rendered into stored prose", "a stored decision written under the authored bound
stays readable". Pre-fix reproduction and post-fix run:
`/tmp/cove-planning-opus-evidence/repro-flaw2-before.txt`, `repro-flaw2-after.txt`.

## Verification status

| Layer | Status |
| --- | --- |
| Focused domain tests (planning, day-plan store, brief, evaluation harness, export) | Run and passing in an isolated snapshot with synthetic databases in OS temp directories. |
| Repository test suite, TypeScript, lint and production build | `scripts/cove-verify.mjs` run in that snapshot on Node 24: all checks passed. |
| Multi-day integration regression | `tests/planning-reliability-multiday.test.mjs`, synthetic database in an OS temp directory, no provider or transport started. |
| Model judgment on the new cases | Three GPT-6 Astra low-effort trials passed validation, independent semantic review and production persistence replay. See remaining coverage gap below. |
| Browser and Arrival rendering | Synthetic browser acceptance passed through Start Day and reload. Native notification delivery was not tested. |
| Live operator data | Existing day and full saved brief compared exactly before and after local installation and browser inspection. No new plan generated against live records. |

Nothing in this file establishes production acceptance. The deterministic
safeguards prove that Cove rejects or marks the failures above; they do not prove
that a recommendation is useful, or that a model will follow the lessons. That
requires the model trials and the semantic review described in `EVALUATION.md`.

## How to fix the next one

1. Reproduce first, outside the product: a small script that shows the wrong
   state, saved as evidence. A failing test that turns green later is the proof
   the change did something.
2. Name the class, not the record. Fix "a supporting source is never re-checked",
   not "this meeting moved". Never special-case a person, a task or a date.
3. Prefer a deterministic safeguard in validation, persistence or resolution over
   a new instruction to the model. Instructions are the last resort, and when one
   is genuinely needed it goes in `planning-lessons.ts` as one short rule.
4. Keep the change small. No fuzzy auto-merging, no second store for work, no
   redesign of planning to fix one class.
5. Be precise about what a change may do to accepted work. Stale evidence may
   withdraw a rationale and ask for a fresh recommendation; it may never resolve,
   complete or cancel something a person accepted.
6. Check both directions of a boundary: what is written and what is read back,
   the authored value and the stored value, the first read and the second.
7. Add the regression next to the behavior it protects, then record the incident,
   cause, safeguard and evidence here. Leave pending checks marked pending.

## Acceptance evidence from this pass (September 16, 2026)

The parent reran the complete gate on Node 24: 1,661 tests passed, zero failed,
three environment-dependent checks skipped, with TypeScript, lint and production
build passing. Three fictional cases ran through the configured GPT-6 Astra
planner at low effort. All three passed validation, independent semantic review,
and production persistence replay. The raw inputs, outputs and frozen criteria
are retained in the private review evidence.

The browser check used a synthetic database: one reused preparation in Initial
priorities, a separate task for the same person in Not Today, the full long
rationale in task details, and proposed-time labels in the brief and question.
Start Day and reload retained the same preparation without another task.
This does not test notification delivery or real-client acceptance.

### Remaining coverage gap: directly selected tasks

The calendar-plus-existingTask route records the supporting event and detects
later schedule changes. A model can instead select the task directly with
proposal=null. In the Priya trial it did that while citing the meeting as a
reason to prioritize preparation, without recording the supporting event. The
identity and saved-date checks passed, but automatic withdrawal of that rationale
after a later calendar change is not covered on this route. Do not claim that
all calendar-dependent recommendations are now invalidated correctly. A future
repair should make that evidence dependency explicit and test both selection
routes; matching by a person's name would be unsafe.
