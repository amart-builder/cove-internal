# Working-week evaluation

This evaluation asks whether Cove preserves commitments, gives useful advice,
and interrupts appropriately through realistic changes. It combines a linked
state simulation with independent model scenarios. Passing either alone does
not establish that Cove is ready for an unattended client rollout.

## Run it

Run from the repository root with dependencies installed and the compatible
Node 24 runtime. Use a fresh output directory for each attempt. Keep failed
results; do not overwrite them with a successful rerun.

```sh
eval_root="$(mktemp -d /tmp/cove-evaluation.XXXXXX)"
node --import tsx scripts/evaluation/working-week-state.mjs \
  --output-dir "$eval_root/state"

node --import tsx --test tests/working-week-evaluation.test.mjs
```

The state script creates its own synthetic database. It never accepts a live
database path. Inherited Cove/Forge path selections are cleared before product
modules load. Calendar and notification adapters are fakes; network and native
transport entry points are blocked. A fixed read-only subprocess checks the
saved database in a fresh process during restart verification.

To inspect the model inputs without invoking a provider:

```sh
node --import tsx scripts/evaluation/working-week-models.mjs \
  --output "$eval_root/prepared"
```

To run the actual model trials, explicitly enable provider calls. Both CLIs must
be installed and signed in. This consumes their normal usage allowance.

```sh
node --import tsx scripts/evaluation/working-week-models.mjs \
  --output "$eval_root/models" --run-models --repeats 3

node --import tsx scripts/evaluation/working-week-models.mjs \
  --output "$eval_root/holdouts" --run-models --repeats 1 \
  --cases fixtures/working-week/holdouts.json
```

The default suite has six cases, two providers, and three repeats: 36 responses.
The two holdouts add four responses. The runner uses the exact model IDs and effort
recorded in its manifest/results. Calls are tool-free, run in temporary working
directories, and do not operate the installed Cove. Codex uses a temporary
configuration home with access to existing sign-in; Claude uses safe mode to
exclude personal instructions and customizations. Provider configuration
isolation is part of the evaluation, not proof from an expected name appearing
in an answer. Investigate unexpected personal context before counting a run.

Once a model run finishes, replay its saved responses through actual persistence:

```sh
node --import tsx scripts/evaluation/working-week-roundtrip.mjs \
  --input "$eval_root/models" --output "$eval_root/roundtrip"
```

Replay creates fresh synthetic source records, checks source identity, validates
each response, saves valid decisions, and reads the resulting plan and full
brief. It checks that unaccepted proposals do not create canonical tasks.
Rejected responses are reported separately from successful roundtrips. A zero
replay exit code does not mean every response became a usable brief.

## What each layer proves

| Layer | Evidence | Does not establish |
| --- | --- | --- |
| Linked five-day state simulation | Commitment conservation, completion/Undo, closeout continuity, stale-result rejection, started-day stability, calendar changes, notification policy and restart persistence | Model judgment, browser rendering, actual notification delivery |
| Independent model scenarios | Response to frozen source facts, missing information, explicit choices and hostile imported text | A continuously learning agent or live connector correctness |
| Saved-response roundtrip | Valid model output survives production validation, persistence and full-brief projection | That the recommendation is useful or factually sound |
| Human/independent semantic review | Concrete compliance with each case's frozen outcome criteria | A universal reliability percentage or measured time saved |

The state suite advances one shared database across five working days. Its
assertion count is not the number of independent trials. The model cases each
start from a separate point-in-time source set; their outputs do not become the
next case's inputs. Closeout notes supplied in those cases are fixtures.

## Rubric and interpretation

Each fixture contains source facts and numbered `criteria`. Freeze those before
generation. Criteria are saved with the inputs for review but are not included
in the generation prompt. Reserve holdouts until after initial repairs.

Review the full structured response and narrative against the source. Hide
provider/model metadata when practical. Record the run ID, exact supporting
quote, affected criterion, and one of:

- **Pass:** the frozen outcome criteria are satisfied.
- **Fail:** a concrete contradiction or omission violates a criterion.
- **Concern:** a material ambiguity or weakness merits review but does not
  clearly violate a frozen criterion.

Judge preserved commitments, explicit decisions, uncertainty, useful bounded
preparation, and authority. Do not score prose preference. A missing calendar
does not imply free time. An empty connected calendar does not establish all
personal availability. A draft is not sent work; a suggestion is not an accepted
commitment. A proposed internal review time is not a client deadline.

Interpret failures by layer:

- A provider error or timeout is an execution failure, not a semantic answer.
- A validator failure means Cove cannot accept that response. Useful prose does
  not make it a successful brief.
- A semantic failure can occur even when the validator passes.
- A replay failure means accepted output did not survive the real state path.
- An isolation failure makes that run diagnostic. Preserve it and rerun in a
  new directory after fixing the boundary; do not relabel old outputs as final.

The manifest records fixture and prompt provenance. Keep diagnostics, repaired
runs, semantic judgments and holdouts distinguishable. Do not change a criterion
after seeing an answer simply to make a run pass.

## Remaining acceptance work

These tests do not verify a user's account permissions, actual Mac sleep/wake
behavior, browser interaction, native notification visibility, or time saved.
They also do not exhaust possible tasks and source conflicts. Repeated model
responses are correlated samples. Validate the intended production model/effort
configuration and perform the actual-device acceptance checks in `SETUP.md`.
