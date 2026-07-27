import type { DayPlanReconciliation } from './types';

export type ReconciliationTaskStatus = 'open' | 'done' | 'archived';

export type ReconciliationTaskState = {
  columnId: string;
  status?: ReconciliationTaskStatus;
};

export type ReconciliationTaskPatch = {
  columnId?: string;
  status?: ReconciliationTaskStatus;
};

export type ReconciliationColumns = {
  notStartedId?: string;
  todayId?: string;
};

export type PlannedTaskReconciliation = {
  patch?: ReconciliationTaskPatch;
  nextState?: ReconciliationTaskState;
};

export function planTaskReconciliation(
  action: DayPlanReconciliation['action'],
  task: ReconciliationTaskState | undefined,
  columns: ReconciliationColumns,
): PlannedTaskReconciliation {
  if (!task || task.status === 'done' || task.status === 'archived') {
    return { nextState: task };
  }

  if (action === 'defer') {
    if (!columns.notStartedId) {
      throw new Error('Forge needs a Not Started list before it can defer that task.');
    }
    const nextState = { columnId: columns.notStartedId, status: 'open' as const };
    return {
      patch:
        task.columnId === nextState.columnId && task.status === nextState.status
          ? undefined
          : nextState,
      nextState,
    };
  }

  if (action === 'drop') {
    const nextState = { ...task, status: 'archived' as const };
    return {
      patch: { status: 'archived' },
      nextState,
    };
  }

  if (!columns.notStartedId || !columns.todayId) {
    throw new Error('Forge needs Today and Not Started lists to resurface deferred work.');
  }
  if (task.columnId !== columns.notStartedId) {
    return { nextState: task };
  }
  const nextState = { columnId: columns.todayId, status: 'open' as const };
  return {
    patch:
      task.columnId === nextState.columnId && task.status === nextState.status
        ? undefined
        : nextState,
    nextState,
  };
}

export function reconciliationStateMatches(
  actual: ReconciliationTaskState | undefined,
  expected: ReconciliationTaskState | undefined,
): boolean {
  if (!actual || !expected) return actual === expected;
  return actual.columnId === expected.columnId && actual.status === expected.status;
}
