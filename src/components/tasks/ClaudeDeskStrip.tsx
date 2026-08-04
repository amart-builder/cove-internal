'use client';

import { useState } from 'react';
import {
  TASK_SESSION_STATUS_LABELS,
  type TaskSessionRun,
} from '@/lib/task-sessions/types';

function summary(activeCount: number, readyCount: number): string {
  const active = activeCount > 0
    ? `Claude is working on ${activeCount}`
    : 'Claude has no active work';
  if (readyCount === 0) return active;
  return `${active}, ${readyCount} ready to review`;
}

export default function ClaudeDeskStrip({
  activeRuns,
  outputReadyRuns,
  onAbandon,
}: {
  activeRuns: readonly TaskSessionRun[];
  outputReadyRuns: readonly TaskSessionRun[];
  onAbandon: (runId: string) => void | Promise<unknown>;
}) {
  const [confirmingRunId, setConfirmingRunId] = useState<string>();
  const [stoppingRunId, setStoppingRunId] = useState<string>();
  const runs = [...activeRuns, ...outputReadyRuns];
  if (runs.length === 0) return null;

  return (
    <section className="mt-4 rounded-2xl border border-border/60 bg-background/65 px-3 py-2.5 backdrop-blur" aria-label="Claude desk">
      <p className="text-xs font-medium text-foreground">
        {summary(activeRuns.length, outputReadyRuns.length)}
      </p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {runs.map((run) => (
          <li key={run.id} className="flex min-h-8 items-center gap-2 rounded-full border bg-card px-2.5 py-1 text-[11px]">
            <span className="max-w-48 truncate font-medium text-foreground">
              {run.promptSnapshot.title}
            </span>
            <span className="text-muted-foreground">{TASK_SESSION_STATUS_LABELS[run.status]}</span>
            {run.status === 'output_ready' && (
              <a className="font-medium text-foreground underline underline-offset-2" href={run.resumeUrl}>
                Review
              </a>
            )}
            {(run.status === 'running' || run.status === 'awaiting_approval') && (
              confirmingRunId === run.id ? (
                <span className="inline-flex items-center gap-1">
                  <span className="text-muted-foreground">Stop this run?</span>
                  <button
                    type="button"
                    className="font-medium text-accent-red disabled:opacity-40"
                    disabled={stoppingRunId === run.id}
                    onClick={() => {
                      setStoppingRunId(run.id);
                      void Promise.resolve(onAbandon(run.id))
                        .catch(() => undefined)
                        .finally(() => {
                          setStoppingRunId(undefined);
                          setConfirmingRunId(undefined);
                        });
                    }}
                  >
                    {stoppingRunId === run.id ? 'Stopping…' : 'Stop'}
                  </button>
                  <button type="button" className="text-muted-foreground" onClick={() => setConfirmingRunId(undefined)}>
                    Keep working
                  </button>
                </span>
              ) : (
                <button type="button" className="text-muted-foreground hover:text-accent-red" onClick={() => setConfirmingRunId(run.id)}>
                  Stop
                </button>
              )
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
