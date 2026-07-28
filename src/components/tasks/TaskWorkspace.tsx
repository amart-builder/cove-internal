'use client';

import { useEffect, useState } from 'react';
import { getRuntimeMode } from '@/lib/runtime/mode';
import KanbanBoard from './KanbanBoard';
import TodayView from './TodayView';

type WorkspaceView = 'today' | 'all-work';

export default function TaskWorkspace() {
  const quietCurrentAvailable = getRuntimeMode() !== 'convex';
  const [view, setView] = useState<WorkspaceView>(
    quietCurrentAvailable ? 'today' : 'all-work',
  );

  // ?view=all-work (or ?view=today) opens the workspace straight into a view,
  // so it can be linked to instead of always landing on Today and needing a
  // click. This page is statically rendered, so the query string does not exist
  // until the browser has it: applying it after mount rather than in the
  // initial state is what keeps the server and client markup identical.
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('view');
    if (requested === 'all-work') setView('all-work');
    else if (requested === 'today' && quietCurrentAvailable) setView('today');
  }, [quietCurrentAvailable]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="quiet-workspace-bar flex h-12 shrink-0 items-center justify-center border-b px-4">
        <div
          className="quiet-segmented-control flex items-center rounded-full p-1"
          role="group"
          aria-label="Task view"
        >
          <button
            type="button"
            aria-pressed={view === 'today'}
            aria-describedby={!quietCurrentAvailable ? 'convex-today-notice' : undefined}
            disabled={!quietCurrentAvailable}
            title={
              quietCurrentAvailable
                ? undefined
                : 'Today is available after moving this Cove setup to the local or Supabase runtime.'
            }
            onClick={() => setView('today')}
            className={`quiet-segment ${view === 'today' ? 'is-active' : ''}`}
          >
            Today
          </button>
          <button
            type="button"
            aria-pressed={view === 'all-work'}
            onClick={() => setView('all-work')}
            className={`quiet-segment ${view === 'all-work' ? 'is-active' : ''}`}
          >
            All Work
          </button>
        </div>
      </div>
      {!quietCurrentAvailable && (
        <p
          id="convex-today-notice"
          className="shrink-0 border-b px-4 py-2 text-center text-xs text-muted-foreground"
        >
          Today is paused for this Convex workspace until its Quiet Current flow is verified. All Work remains available.
        </p>
      )}
      <div className="min-h-0 flex-1">
        {view === 'today' ? (
          <TodayView onOpenAllWork={() => setView('all-work')} />
        ) : (
          <KanbanBoard />
        )}
      </div>
    </div>
  );
}
