import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAttentionSweepPrompt } from '../scripts/cove-attention-sweep.mjs';

// This lane is retired, and the persistent chief-of-staff agent owns attention
// judgment now. The script is kept as a compatibility and regression seam, so
// it should not be kept with another person's name baked into its prompt: the
// same defect was live in the email classifier.

const snapshot = { now: '2026-09-22T16:00:00.000Z', localDate: '2026-09-22', tasks: [] };

test('the ranking instruction names the person whose board this is', (t) => {
  const previous = process.env.COVE_OPERATOR_NAME;
  t.after(() => {
    if (previous === undefined) delete process.env.COVE_OPERATOR_NAME;
    else process.env.COVE_OPERATOR_NAME = previous;
  });
  process.env.COVE_OPERATOR_NAME = 'Gary';
  const written = buildAttentionSweepPrompt(snapshot);
  assert.match(written, /Gary's attention/);
  assert.doesNotMatch(written, /Alex/);
});

test('an install that configured no name still reads as a sentence', (t) => {
  const previous = process.env.COVE_OPERATOR_NAME;
  t.after(() => {
    if (previous === undefined) delete process.env.COVE_OPERATOR_NAME;
    else process.env.COVE_OPERATOR_NAME = previous;
  });
  delete process.env.COVE_OPERATOR_NAME;
  const written = buildAttentionSweepPrompt(snapshot);
  assert.doesNotMatch(written, /Alex/);
  assert.match(written, /the operator's attention/);
});

test('the untrusted-data boundary is still stated', () => {
  const written = buildAttentionSweepPrompt(snapshot);
  assert.match(written, /untrusted data/);
  assert.match(written, /<untrusted_board_snapshot>/);
});
