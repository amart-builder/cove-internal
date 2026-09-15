import assert from 'node:assert/strict';
import test from 'node:test';
import { currentDayPlanItems } from '../src/lib/day-plan/presentation.ts';

const items = ['progress', 'carry', 'defer', 'drop'].map((disposition, position) => ({
  id: disposition, taskId: disposition, position, decision: 'accepted', settlementDecision: { disposition },
}));
items.push({ id: 'completed', taskId: 'completed', position: 4, decision: 'completed', settlementDecision: { disposition: 'defer' } });

test('Today removes definite defer/drop decisions after closeout while preserving continuing and completed work', () => {
  const history = structuredClone(items);
  const plan = { state: 'settling', items };
  assert.deepEqual(currentDayPlanItems(plan).map(item => item.id), ['progress', 'carry', 'defer', 'drop', 'completed']);
  // Closing changes plan state. Defer still has a real open task in Not Started.
  plan.state = 'settled';
  const projected = currentDayPlanItems(plan);
  assert.deepEqual(projected.map(item => item.id), ['progress', 'carry', 'completed']);
  assert.deepEqual(projected.filter(item => item.decision === 'accepted').map(item => item.taskId), ['progress', 'carry']);
  assert.deepEqual(currentDayPlanItems(JSON.parse(JSON.stringify(plan))), projected);
  assert.deepEqual(plan.items, history);
});

test('unfinished plans retain draft closeout choices and no plan has no active work', () => {
  assert.deepEqual(currentDayPlanItems(), []);
  assert.deepEqual(currentDayPlanItems({ state: 'active', items }), items);
  assert.deepEqual(currentDayPlanItems({ state: 'proposed', items }), items);
});
