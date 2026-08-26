import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reconcileFocusSeatTaskChanges,
  reduceFocusSeats,
  shouldSurfaceTodayOrderError,
} from '../src/lib/tasks/focus-seats.ts';

const ORDER = ['a', 'b', 'c', 'd', 'e', 'f'];

test('completion refills each focus seat without moving the surviving seats', () => {
  assert.deepEqual(
    reduceFocusSeats(ORDER, 3, { type: 'complete', seatIndex: 0, taskId: 'a' }),
    ['d', 'b', 'c', 'e', 'f'],
  );
  assert.deepEqual(
    reduceFocusSeats(ORDER, 3, { type: 'complete', seatIndex: 1, taskId: 'b' }),
    ['a', 'd', 'c', 'e', 'f'],
  );
  assert.deepEqual(
    reduceFocusSeats(ORDER, 3, { type: 'complete', seatIndex: 2, taskId: 'c' }),
    ['a', 'b', 'd', 'e', 'f'],
  );
});

test('single focus completion promotes the first downstream task', () => {
  assert.deepEqual(
    reduceFocusSeats(ORDER, 1, { type: 'complete', seatIndex: 0, taskId: 'a' }),
    ['b', 'c', 'd', 'e', 'f'],
  );
});

test('focus count changes preserve the complete ordering', () => {
  assert.deepEqual(
    reduceFocusSeats(ORDER, 1, { type: 'focus_count_changed', focusCount: 3 }),
    ORDER,
  );
  assert.deepEqual(
    reduceFocusSeats(ORDER, 3, { type: 'focus_count_changed', focusCount: 1 }),
    ORDER,
  );
});

test('a missing downstream task is removed without moving focus seats', () => {
  assert.deepEqual(
    reduceFocusSeats(ORDER, 3, { type: 'task_vanished', taskId: 'e' }),
    ['a', 'b', 'c', 'd', 'f'],
  );
  assert.deepEqual(
    reduceFocusSeats(ORDER, 3, { type: 'task_vanished', taskId: 'b' }),
    ['a', 'd', 'c', 'e', 'f'],
  );
});

test('an empty downstream river leaves only the surviving seats', () => {
  assert.deepEqual(
    reduceFocusSeats(['a', 'b', 'c'], 3, {
      type: 'complete',
      seatIndex: 1,
      taskId: 'b',
    }),
    ['a', 'c'],
  );
  assert.deepEqual(
    reduceFocusSeats([], 1, { type: 'complete', seatIndex: 0, taskId: 'a' }),
    [],
  );
});

test('reorder events return the full applied ordering', () => {
  assert.deepEqual(
    reduceFocusSeats(ORDER, 3, {
      type: 'reorder_applied',
      orderedTaskIds: ['c', 'a', 'b', 'f', 'e', 'd'],
    }),
    ['c', 'a', 'b', 'f', 'e', 'd'],
  );
});

test('reapplying a task event is idempotent after the task is gone', () => {
  const event = { type: 'complete', seatIndex: 1, taskId: 'b' };
  const once = reduceFocusSeats(ORDER, 3, event);
  assert.deepEqual(reduceFocusSeats(once, 3, event), once);

  const vanished = { type: 'task_vanished', taskId: 'e' };
  const withoutTask = reduceFocusSeats(ORDER, 3, vanished);
  assert.deepEqual(reduceFocusSeats(withoutTask, 3, vanished), withoutTask);
});

test('a proposed day resets vanished cards without persisting a Today reorder', () => {
  assert.deepEqual(
    reconcileFocusSeatTaskChanges(
      ['a', 'b', 'c', 'd'],
      ['a', 'c', 'd'],
      2,
      false,
    ),
    {
      orderedTaskIds: ['a', 'c', 'd'],
      shouldPersist: false,
    },
  );
});

test('an active day persists the same vanished focus-seat repair', () => {
  assert.deepEqual(
    reconcileFocusSeatTaskChanges(
      ['a', 'b', 'c', 'd'],
      ['a', 'c', 'd'],
      2,
      true,
    ),
    {
      orderedTaskIds: ['a', 'c', 'd'],
      shouldPersist: true,
    },
  );
});

test('a late reorder error cannot cross into a different or proposed plan', () => {
  assert.equal(
    shouldSurfaceTodayOrderError('yesterday', { id: 'today', state: 'active' }),
    false,
  );
  assert.equal(
    shouldSurfaceTodayOrderError('today', { id: 'today', state: 'proposed' }),
    false,
  );
  assert.equal(
    shouldSurfaceTodayOrderError('today', { id: 'today', state: 'active' }),
    true,
  );
});
