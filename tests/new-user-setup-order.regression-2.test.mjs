import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const setupPath = fileURLToPath(new URL('../SETUP.md', import.meta.url));

// Regression: QA ISSUE-002 in the clean-user rehearsal documented at
// /private/tmp/cove-dual-sim.WDleYH/qa/qa-report-cove-local-2026-08-06.md.
// Starting the worker while tasks were still being captured produced a valid
// but stale first brief that said the board was empty. A disposable smoke brief
// also cannot be followed by a second identical same-day brief because Cove
// intentionally deduplicates identical evidence.
test('first-user setup loads real data before the worker and reviews one candidate brief', () => {
  const setup = readFileSync(setupPath, 'utf8');

  assert.match(
    setup,
    /Start only the already-built web app in a dedicated terminal:[\s\S]*next start -H 127\.0\.0\.1 -p 3200/,
  );
  assert.match(setup, /no Cove worker process is running/);
  assert.match(setup, /The next worker start must see the finished first-day data/);
  assert.match(setup, /successful artifact is the candidate real brief reviewed in[\s\S]*Step 6/);
  assert.match(setup, /Do not create a disposable same-date brief first/);
  assert.match(setup, /Do not request a second[\s\S]*same-date brief/);
  assert.match(setup, /does not currently expose a safe[\s\S]*same-day refresh/);
  assert.doesNotMatch(setup, /The real one comes at the end/);
  assert.doesNotMatch(setup, /Do not reuse the quiet smoke test/);
  assert.doesNotMatch(setup, /fix the profile or goals and generate another brief/);
});
