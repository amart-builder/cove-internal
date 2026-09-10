'use client';

import { useEffect } from 'react';
import { requestedTaskLink, requestedTaskWorkspaceView, type TaskWorkspaceView } from './task-workspace-view';

export function useTaskLink(
  view: TaskWorkspaceView,
  tasks: ReadonlyArray<{ _id: string }>,
  openTask: (id: string) => void,
): void {
  useEffect(() => {
    // Today mounts briefly before an explicit All Work switch. Only the
    // requested view may consume the link, or that switch would lose it.
    if ((requestedTaskWorkspaceView(window.location.search, true) ?? 'today') !== view) return;
    const id = requestedTaskLink(window.location.search, tasks);
    if (!id) return;
    const timer = window.setTimeout(() => {
      openTask(id);
      // Consume only this task link. Preserve the view and unrelated parameters.
      const url = new URL(window.location.href);
      url.searchParams.delete('task');
      window.history.replaceState(window.history.state, '', url);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [view, tasks, openTask]);
}
