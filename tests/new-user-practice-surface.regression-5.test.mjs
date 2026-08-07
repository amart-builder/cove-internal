import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const setupPath = fileURLToPath(new URL('../SETUP.md', import.meta.url));

// Regression: QA ISSUE-005 in the clean-user rehearsal documented at
// /private/tmp/cove-dual-sim.WDleYH/qa/qa-report-cove-local-2026-08-06.md.
// The handoff required Hold for Cove and Bring back, but those controls belong
// to the retired Today surface and are not available in shipped Today V2.
test('first-day practice requires only controls present in the shipped Today surface', () => {
  const setup = readFileSync(setupPath, 'utf8');
  const practice = setup.slice(
    setup.indexOf('## Step 7: Practice one morning and close'),
    setup.indexOf('## Step 8: Leave the user three ways back in'),
  );

  assert.match(practice, /Open Focus Grid, switch one item into Focus/);
  assert.match(practice, /mark a demo item done, and\s+undo it/);
  assert.match(practice, /original item, order, and owner return/);
  assert.doesNotMatch(practice, /hold it for Cove/i);
  assert.doesNotMatch(practice, /bring it back/i);
});
