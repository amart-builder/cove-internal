import assert from 'node:assert/strict';
import test from 'node:test';
import { arrayMove } from '@dnd-kit/sortable';
import {
  dragOverMovesBetweenColumns,
  sameColumnDropIndex,
} from '../src/lib/tasks/board-drag.ts';

// What the board does with the index: pull the dragged card out of the column,
// then splice it back in at the answer.
function applyDrop(columnTaskIds, activeId, index) {
  const without = columnTaskIds.filter((id) => id !== activeId);
  const bounded = Math.max(0, Math.min(index, without.length));
  return [...without.slice(0, bounded), activeId, ...without.slice(bounded)];
}

test('a drag that stays in one column is never previewed as a move', () => {
  // The regression: previewing it re-orders the cards under the pointer, the
  // next pointer event lands on a different card, and the board flips between
  // two orders until React unmounts the page.
  assert.equal(dragOverMovesBetweenColumns('todo', 'todo'), false);
  assert.equal(dragOverMovesBetweenColumns('todo', 'doing'), true);
  assert.equal(dragOverMovesBetweenColumns(undefined, 'doing'), false);
  assert.equal(dragOverMovesBetweenColumns('todo', undefined), false);
});

test('dropping a card on its own column lands where the sliding showed it', () => {
  const column = ['a', 'b', 'c', 'd'];

  for (const [activeId, overId] of [
    ['a', 'b'], ['a', 'c'], ['a', 'd'],
    ['d', 'a'], ['d', 'b'], ['d', 'c'],
    ['b', 'c'], ['c', 'b'],
  ]) {
    const index = sameColumnDropIndex(column, activeId, overId);
    assert.notEqual(index, undefined, `${activeId} onto ${overId}`);
    assert.deepEqual(
      applyDrop(column, activeId, index),
      arrayMove(column, column.indexOf(activeId), column.indexOf(overId)),
      `${activeId} dropped on ${overId}`,
    );
  }
});

test('a card dropped on itself or on a stranger moves nothing', () => {
  const column = ['a', 'b', 'c'];
  assert.equal(sameColumnDropIndex(column, 'b', 'b'), undefined);
  assert.equal(sameColumnDropIndex(column, 'b', 'elsewhere'), undefined);
  assert.equal(sameColumnDropIndex(column, 'elsewhere', 'b'), undefined);
});
