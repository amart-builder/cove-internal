import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allSettlementDecisionsMade,
  SETTLEMENT_ITEM_GONE_NOTE,
} from '../src/lib/day-plan/presentation.ts';

// Delete a task during the day and it leaves the board but stays on the day's
// plan, so the settlement lists it as still open and asks what happens to it
// next. It used to do that with no explanation and a dead link to a task in
// Recently deleted. The row now says what happened and names the answer that
// fits; the question itself has to stay, because `settlement_commit` in the
// store refuses to close a day with an undecided accepted item, deleted or not.

const item = (id) => ({ id, taskId: `task-${id}`, position: 0 });

test('the row tells you what happened and what to choose', () => {
  assert.match(SETTLEMENT_ITEM_GONE_NOTE, /deleted this task today/);
  assert.match(SETTLEMENT_ITEM_GONE_NOTE, /Drop/);
});

test('the note names an outcome the settlement actually offers', () => {
  // DECISIONS in DaySettlement offers exactly these four.
  const offered = ['Progress', 'Carry', 'Defer', 'Drop'];
  const named = offered.filter((label) => SETTLEMENT_ITEM_GONE_NOTE.includes(label));
  assert.deepEqual(named, ['Drop']);
});

test('a deleted item still counts as an outstanding decision', () => {
  // The client must not enable Close the day for something the store will
  // reject: it answered with "Every unfinished accepted item needs Progress,
  // Carry, Defer, or Drop." and the close failed with the button enabled.
  const items = [item('a'), item('b')];
  assert.equal(allSettlementDecisionsMade(items, { a: 'carry' }), false);
  assert.equal(allSettlementDecisionsMade(items, { a: 'carry', b: 'drop' }), true);
});

test('a plan with nothing open is already decided', () => {
  assert.equal(allSettlementDecisionsMade([], {}), true);
});
