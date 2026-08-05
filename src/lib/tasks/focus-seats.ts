export type FocusSeatEvent =
  | { type: "complete"; seatIndex: number; taskId: string }
  | { type: "task_vanished"; taskId: string }
  | { type: "focus_count_changed"; focusCount: number }
  | { type: "reorder_applied"; orderedTaskIds: readonly string[] };

function requireFocusCount(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 3) {
    throw new Error("focusCount must be an integer from 1 to 3.");
  }
}

function refillSeat(
  orderedTaskIds: readonly string[],
  focusCount: number,
  seatIndex: number,
): string[] {
  const next = [...orderedTaskIds];
  const downstreamIndex = next.findIndex((_, index) => index >= focusCount);
  if (downstreamIndex < 0) {
    next.splice(seatIndex, 1);
    return next;
  }
  next[seatIndex] = next[downstreamIndex];
  next.splice(downstreamIndex, 1);
  return next;
}

export function reduceFocusSeats(
  orderedTaskIds: readonly string[],
  focusCount: number,
  event: FocusSeatEvent,
): string[] {
  requireFocusCount(focusCount);

  if (event.type === "focus_count_changed") {
    requireFocusCount(event.focusCount);
    return [...orderedTaskIds];
  }
  if (event.type === "reorder_applied") {
    return [...event.orderedTaskIds];
  }

  const taskIndex = orderedTaskIds.indexOf(event.taskId);
  if (taskIndex < 0) return [...orderedTaskIds];

  if (event.type === "complete") {
    if (
      !Number.isInteger(event.seatIndex) ||
      event.seatIndex < 0 ||
      event.seatIndex >= focusCount ||
      taskIndex !== event.seatIndex
    ) {
      return [...orderedTaskIds];
    }
    return refillSeat(orderedTaskIds, focusCount, event.seatIndex);
  }

  if (taskIndex >= focusCount) {
    const next = [...orderedTaskIds];
    next.splice(taskIndex, 1);
    return next;
  }
  return refillSeat(orderedTaskIds, focusCount, taskIndex);
}
