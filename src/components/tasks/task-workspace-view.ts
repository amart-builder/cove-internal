export type TaskWorkspaceView = 'today' | 'all-work';

export const TASK_WORKSPACE_VIEW_EVENT = 'cove:task-workspace-view';

export function requestedTaskWorkspaceView(
  search: string,
  quietCurrentAvailable: boolean,
): TaskWorkspaceView | undefined {
  const requested = new URLSearchParams(search).get('view');
  if (requested === 'all-work') return 'all-work';
  if (requested === 'today' && quietCurrentAvailable) return 'today';
  return undefined;
}

export function announceTaskWorkspaceView(view: TaskWorkspaceView): void {
  window.dispatchEvent(new CustomEvent<TaskWorkspaceView>(TASK_WORKSPACE_VIEW_EVENT, {
    detail: view,
  }));
  const url = new URL(window.location.href);
  if (view === 'today') url.searchParams.delete('view');
  else url.searchParams.set('view', view);
  window.history.replaceState(window.history.state, '', url);
}
