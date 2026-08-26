export type FocusSeatEvent =
  | { type: "complete"; seatIndex: number; taskId: string }
  | { type: "task_vanished"; taskId: string }
  | { type: "focus_count_changed"; focusCount: number }
  | { type: "reorder_applied"; orderedTaskIds: readonly string[] };

export type FocusSeatTaskReconciliation = {
  orderedTaskIds: string[];
  shouldPersist: boolean;
};

export function shouldSurfaceTodayOrderError(
  startingPlanId: string | undefined,
  currentPlan: { id: string; state: string } | undefined,
): boolean {
  return Boolean(
    startingPlanId &&
      currentPlan?.id === startingPlanId &&
      currentPlan.state === "active",
  );
}

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

/**
 * Reconcile Today’s temporary visual order after its task projection changes.
 *
 * An active day persists a vanished focus task so the durable plan refills the
 * same seat. A proposed day only resets the visual projection. Persisting then
 * would race Morning Arrival and leak a meaningless reorder error into it.
 */
export function reconcileFocusSeatTaskChanges(
  visualTaskIds: readonly string[],
  modelTaskIds: readonly string[],
  focusCount: number,
  persistenceEnabled: boolean,
): FocusSeatTaskReconciliation {
  requireFocusCount(focusCount);
  if (!persistenceEnabled) {
    return { orderedTaskIds: [...modelTaskIds], shouldPersist: false };
  }

  const modelTaskIdSet = new Set(modelTaskIds);
  const vanishedSeatIds = visualTaskIds
    .slice(0, focusCount)
    .filter((taskId) => !modelTaskIdSet.has(taskId));
  if (vanishedSeatIds.length === 0) {
    return { orderedTaskIds: [...modelTaskIds], shouldPersist: false };
  }

  let next = [...visualTaskIds];
  for (const taskId of vanishedSeatIds) {
    next = reduceFocusSeats(next, focusCount, { type: "task_vanished", taskId });
  }
  next = [
    ...next.filter((taskId) => modelTaskIdSet.has(taskId)),
    ...modelTaskIds.filter((taskId) => !next.includes(taskId)),
  ];
  return { orderedTaskIds: next, shouldPersist: true };
}
