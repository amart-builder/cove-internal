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

`fixtures/working-week/planning-reliability.json` adds three cases for the
repeated planning failures recorded in `PLANNING_RELIABILITY.md`: reusing an
existing preparation (including a second, different outcome for the same person),
a saved follow-up during an absence with no appointment, and carrying a
correction forward. Run them the same way with `--cases`. Their criteria are
frozen; the deterministic safeguards for those incidents are already covered by
tests, so a passing validator here says nothing about whether the judgment was
right.

The default suite has six cases, two providers, and three repeats: 36 responses.
The two holdouts add four responses. The runner uses the exact model IDs and effort
recorded in its manifest/results. Calls are tool-free, run in temporary working
directories, and do not operate the installed Cove. Codex uses a temporary
configuration home with access to existing sign-in; Claude uses safe mode to
exclude personal instructions and customizations. Provider configuration
isolation is part of the evaluation, not proof from an expected name appearing
in an answer. Investigate unexpected personal context before counting a run.

Once a model run finishes, replay its saved responses through actual persistence:

For a bounded check of one configured planner, add `--provider codex` or
`--provider claude`. Omitting it retains both configured providers. Use
`--repeats 1` for one trial per case; the manifest records the actual selection.

Replay the saved responses:

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

The runner saves both the raw wire response and the validated decision. Exact clock references in new model prose are rendered from saved timestamps or supplied source labels before persistence; grade the rendered decision alongside the wire references and source evidence. Old stored prose remains readable. This removes duplicate clock formatting, but does not prove that the chosen review time or source interpretation is sensible.

The manifest records fixture and prompt provenance, including the hash of the
runtime planning lessons. Keep diagnostics, repaired runs, semantic judgments and
holdouts distinguishable. Do not change a criterion after seeing an answer simply
to make a run pass.

When a run exposes a repeated failure, record the incident, its class, the
deterministic safeguard and the regression evidence in `PLANNING_RELIABILITY.md`
before adding instructions to the planner.

## Remaining acceptance work

These tests do not verify a user's account permissions, actual Mac sleep/wake
behavior, browser interaction, native notification visibility, or time saved.
They also do not exhaust possible tasks and source conflicts. Repeated model
responses are correlated samples. Validate the intended production model/effort
configuration and perform the actual-device acceptance checks in `SETUP.md`.

## Source and time references

New planner responses select source keys from a frozen `ref.N` catalog. Cove
resolves each key to the saved identity and revision, then checks that revision
again before persistence. This avoids asking the writer to reproduce hashes.
Older stored full references remain readable and retain version validation.

Generated review/start/expiry clocks in new prose use typed references to the
validated decision fields. Source clocks use a separate catalog. Cove formats
them in the operator timezone. Exact supplied local labels remain valid quotes.
This prevents independent clock conversion for compliant references; it does
not prove that the writer chose the right source, inferred the right priority,
or avoided every unsupported sentence. Grade meaning separately, keep failed
trials, and treat provider/network errors as unevaluated, not model passes.

## Jev judgment fixtures (offline)

`fixtures/jev/cases.json` holds frozen, synthetic cases for the planned
TypeSafe Jev judgments, one lane per feature: `commitment-meaning`,
`email-triage`, `draft-correctness`, `reply-fulfillment`, `task-identity` and
`planning-evidence`. `fixtures/jev/README.md` documents the lanes and the case
schema. Everyone and everything in the fixture is fictional.

Prepare and validate without any provider:

```sh
node --import tsx scripts/evaluation/jev-cases.mjs \
  --output "$eval_root/jev-prepared"

node --import tsx scripts/evaluation/jev-cases.mjs \
  --output "$eval_root/jev-email" --lane email-triage

node --import tsx --test tests/jev-cases.test.mjs
```

The script refuses an existing output directory, strips inherited `COVE_*` and
`FORGE_*` paths, validates the fixture strictly (unique ids, split matches its
array, every expected key names a defined question, every choice label exists
in that question's criteria, state under 24 KiB, at most 32 questions per
lane), and writes one `<lane>.prepared.json` with the exact request bodies
(`model`, `state`, `questions`) a later live runner would send. Expected answers
and notes go to a separate `<lane>.expected.json` so they can never appear in
a request. `manifest.json` records the fixture hash, each lane's question-set
version and hash, case counts by split, and hashes of the source files whose
behavior these judgments will sit beside.

What this proves: the fixture is well-formed and the request shape is stable
and reproducible. What it does not prove: anything about Jev's accuracy, Cove's
live behavior, latency, cost, or safety. No network call is made, no key is
read, no database is opened and no model is invoked. `--live` and `--run` exit
with code 2; live evaluation is a separate work package with its own
activation.

Development and heldout rule: labels were frozen before any Jev call. Tune
question wording, thresholds and retrieval on development cases only. Heldout
cases run once per candidate question set and are reported as-is; never adjust
anything to make a heldout number pass, and never move a case between splits.
If a heldout label is wrong, fix it, bump `questionSetVersion` when wording
changed, and record why.

Email triage is a separate lane from commitment meaning by design. Triage asks
whether a reply or action is needed and whether an archive decision would hide
a request; commitment meaning asks who owns a quoted obligation and whether an
extracted candidate matches its source. They are gated, measured and promoted
independently, so a good score on one says nothing about the other.
