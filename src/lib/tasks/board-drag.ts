/**
 * Placement rules for dragging a card around the All Work board.
 *
 * These are split out from the board component because the rule that matters
 * most here is a negative one: while a card stays inside its own column, the
 * board must not re-order its own state. `@dnd-kit`'s sorting strategy already
 * slides the neighbours out of the way. Re-ordering state as well moves the
 * cards under the pointer, so the next pointer event reports a different card
 * as the drop target, which re-orders again — the board flips between two
 * orders as fast as React can render until React gives up and unmounts the
 * page.
 */

/**
 * Whether a drag that is currently over `overColumnId` should be previewed by
 * moving the card in board state. Only a move between two columns qualifies.
 */
export function dragOverMovesBetweenColumns(
  activeColumnId: string | undefined,
  overColumnId: string | undefined,
): boolean {
  if (!activeColumnId || !overColumnId) return false;
  return activeColumnId !== overColumnId;
}

/**
 * Where a card dropped on another card in its own column belongs.
 *
 * `columnTaskIds` is the column in its stored order, including the dragged
 * card. The answer is an index into that column with the dragged card taken
 * out, which is what the board splices into, and it matches what the sorting
 * strategy showed during the drag in both directions. `undefined` means there
 * is nothing to do: an unknown card, or a card dropped on itself.
 */
export function sameColumnDropIndex(
  columnTaskIds: readonly string[],
  activeId: string,
  overId: string,
): number | undefined {
  const activeIndex = columnTaskIds.indexOf(activeId);
  const overIndex = columnTaskIds.indexOf(overId);
  if (activeIndex < 0 || overIndex < 0) return undefined;
  if (activeIndex === overIndex) return undefined;
  return overIndex;
}
