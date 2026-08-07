'use client';

import { useEffect, useState } from 'react';
import { getRuntimeMode } from '@/lib/runtime/mode';
import KanbanBoard from './KanbanBoard';
import TodayView from './TodayView';
import {
  TASK_WORKSPACE_VIEW_EVENT,
  requestedTaskWorkspaceView,
  type TaskWorkspaceView,
} from './task-workspace-view';

export default function TaskWorkspace() {
  const quietCurrentAvailable = getRuntimeMode() !== 'convex';
  const [view, setView] = useState<TaskWorkspaceView>(
    quietCurrentAvailable ? 'today' : 'all-work',
  );

  // ?view=all-work (or ?view=today) opens the workspace straight into a view,
  // so it can be linked to instead of always landing on Today and needing a
  // click. This page is statically rendered, so the query string does not exist
  // until the browser has it: applying it after mount rather than in the
  // initial state is what keeps the server and client markup identical.
  useEffect(() => {
    const requestedView = requestedTaskWorkspaceView(
      window.location.search,
      quietCurrentAvailable,
    );
    const update = requestedView
      ? window.setTimeout(() => setView(requestedView), 0)
      : undefined;
    const handleView = (event: Event) => {
      const next = (event as CustomEvent<TaskWorkspaceView>).detail;
      if (next === 'today' && !quietCurrentAvailable) return;
      setView(next);
    };
    window.addEventListener(TASK_WORKSPACE_VIEW_EVENT, handleView);
    return () => {
      if (update !== undefined) window.clearTimeout(update);
      window.removeEventListener(TASK_WORKSPACE_VIEW_EVENT, handleView);
    };
  }, [quietCurrentAvailable]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {!quietCurrentAvailable && (
        <p
          id="convex-today-notice"
          className="shrink-0 border-b px-4 pb-2 pt-[60px] text-center text-xs text-muted-foreground"
        >
          Today is paused for this cloud workspace until its planning flow is verified. All Work remains available.
        </p>
      )}
      <div className="min-h-0 flex-1">
        {view === 'today' ? (
          <TodayView />
        ) : (
          <KanbanBoard />
        )}
      </div>
    </div>
  );
}
