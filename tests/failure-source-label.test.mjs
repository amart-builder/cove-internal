import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UNKNOWN_FAILURE_SOURCE_LABEL,
  failureSourceLabel,
} from '../src/lib/reliability/failure-source-label.ts';

test('known sources read as parts of Cove, not as keys', () => {
  assert.equal(failureSourceLabel('job'), 'Background work');
  assert.equal(failureSourceLabel('receipt'), 'Recent activity');
  assert.equal(failureSourceLabel('meeting-watch'), 'Meeting notes');
  assert.equal(failureSourceLabel('meeting-analysis-degraded'), 'Meeting notes');
  assert.equal(failureSourceLabel('reminder-delivery'), 'Reminder delivery');
});

test('an unrecognised source never reaches the screen as its key', () => {
  // This used to title-case the key, so `meeting-analysis-degraded` rendered as
  // "Meeting Analysis Degraded" on a page a non-technical person reads.
  for (const source of ['meeting-analysis-degraded', 'progress-reconciler', 'a_future_source', '']) {
    const label = failureSourceLabel(source);
    assert.doesNotMatch(label, /[-_]/);
    if (!['job', 'receipt'].includes(source)) {
      assert.notEqual(label.toLowerCase(), source.replace(/[-_]+/g, ' '));
    }
  }
  assert.equal(failureSourceLabel('progress-reconciler'), UNKNOWN_FAILURE_SOURCE_LABEL);
});
