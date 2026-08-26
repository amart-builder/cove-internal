import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  addNotTodayDropToToday,
  ALSO_TODAY_ZONE_ID,
  INITIAL_PRIORITY_ZONE_ID,
  NOT_TODAY_ZONE_ID,
  persistArrivalPriorityDrag,
  TODAY_ZONE_ID,
} from '../src/components/tasks/arrival/ArrivalPlanGrid.tsx';

test('a Not today drag ending over the Today drop zone calls the add handler', () => {
  const calls = [];
  const handled = addNotTodayDropToToday(
    'not-today:task-a',
    TODAY_ZONE_ID,
    [{ id: 'task-a', title: 'Task A' }],
    (task) => {
      calls.push(task.id);
      return true;
    },
  );

  assert.equal(handled, true);
  assert.deepEqual(calls, ['task-a']);
});

test('all three persistent buckets register inside DndContext', () => {
  const source = readFileSync(
    new URL('../src/components/tasks/arrival/ArrivalPlanGrid.tsx', import.meta.url),
    'utf8',
  );
  const childStart = source.indexOf('function ArrivalDropBucket');
  const gridStart = source.indexOf('export default function ArrivalPlanGrid');
  const contextRender = source.indexOf('<DndContext', gridStart);
  const firstBucketRender = source.indexOf('<ArrivalDropBucket', contextRender);

  assert.ok(childStart >= 0);
  assert.ok(source.indexOf('useDroppable({ id })', childStart) < gridStart);
  assert.ok(contextRender >= 0 && firstBucketRender > contextRender);
  assert.match(source, /id={INITIAL_PRIORITY_ZONE_ID}/);
  assert.match(source, /id={ALSO_TODAY_ZONE_ID}/);
  assert.match(source, /id={NOT_TODAY_ZONE_ID}/);
  assert.match(source, /alsoTodayViews\.length === 0/);
  assert.doesNotMatch(source, /<SortableContext/);
  assert.doesNotMatch(source, /useSortable\(/);
});

test('dragging announces human bucket names and rolls back a failed new-task promotion', () => {
  const source = readFileSync(
    new URL('../src/components/tasks/arrival/ArrivalPlanGrid.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /accessibility={dragAccessibility}/);
  assert.match(source, /Move to Initial priorities, Also today, or Not today/);
  assert.match(source, /Use the arrow keys to choose a section/);
  assert.match(source, /await onRemove\(addedItem\.id, task\.title, true\)/);
});

test('the legacy Today zone resolves to Also Today and all bucket ids stay distinct', () => {
  assert.equal(TODAY_ZONE_ID, ALSO_TODAY_ZONE_ID);
  assert.notEqual(INITIAL_PRIORITY_ZONE_ID, ALSO_TODAY_ZONE_ID);
  assert.notEqual(NOT_TODAY_ZONE_ID, ALSO_TODAY_ZONE_ID);
});

test('Morning Arrival labels the focus band and uses completion checks instead of Not today arrows', () => {
  const source = readFileSync(
    new URL('../src/components/tasks/arrival/ArrivalPlanGrid.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, />\s*Initial priorities\s*</);
  assert.match(source, /aria-label={`Mark \${title} complete`}/);
  assert.match(source, /onComplete\(view\.item\.id, view\.title\)/);
  assert.match(source, /onCompleteBoardTask\(task\.id, task\.title\)/);
  assert.doesNotMatch(source, /aria-label={`Add \${task\.title} to today`}/);
});

test('a dynamic priority drag saves the move before its new focus count', async () => {
  const calls = [];
  await persistArrivalPriorityDrag({
    itemId: 'item-b',
    title: 'Task B',
    originalPosition: 2,
    nextPosition: 0,
    focusCount: 1,
    nextFocusCount: 2,
    onMoveToPosition: async (_itemId, position) => calls.push(`move:${position}`),
    onFocusCountChange: async (count) => calls.push(`focus:${count}`),
  });

  assert.deepEqual(calls, ['move:0', 'focus:2']);
});

test('a failed focus-count save rolls the card back to its original position', async () => {
  const calls = [];
  await assert.rejects(
    persistArrivalPriorityDrag({
      itemId: 'item-b',
      title: 'Task B',
      originalPosition: 2,
      nextPosition: 0,
      focusCount: 1,
      nextFocusCount: 2,
      onMoveToPosition: async (_itemId, position) => calls.push(`move:${position}`),
      onFocusCountChange: async () => {
        calls.push('focus:failed');
        throw new Error('settings unavailable');
      },
    }),
    /settings unavailable/,
  );

  assert.deepEqual(calls, ['move:0', 'focus:failed', 'move:2']);
});
