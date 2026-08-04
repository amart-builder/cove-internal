'use client';

import type {
  LaunchTaskSessionInput,
  TaskSessionOwner,
  TaskSessionRun,
} from '@/lib/task-sessions/types';
import {
  ACTIVE_TASK_SESSION_STATUSES,
  TASK_SESSION_STATUS_LABELS,
} from '@/lib/task-sessions/types';

function ownerLabel(owner: TaskSessionOwner): string {
  return owner === 'claude' ? 'Claude' : 'Together';
}

function stopPointer(event: React.SyntheticEvent) {
  event.stopPropagation();
}

export function taskSessionOwnerButtons(
  run: Pick<TaskSessionRun, 'status'> | undefined,
  preferredOwner: TaskSessionOwner | undefined,
): TaskSessionOwner[] {
  if (run && ACTIVE_TASK_SESSION_STATUSES.has(run.status)) return [];
  if (run) return ['claude', 'together'];
  return preferredOwner ? [preferredOwner] : ['claude', 'together'];
}

export function TaskSessionLauncher({
  input,
  run,
  busy = false,
  preferredOwner,
  compact = false,
  activeRunCount = 0,
  onLaunch,
}: {
  input: Omit<LaunchTaskSessionInput, 'owner'>;
  run?: TaskSessionRun;
  busy?: boolean;
  preferredOwner?: TaskSessionOwner;
  compact?: boolean;
  activeRunCount?: number;
  onLaunch: (input: LaunchTaskSessionInput) => void | Promise<unknown>;
}) {
  const owners = taskSessionOwnerButtons(run, preferredOwner);
  const baseClass = compact
    ? 'min-h-7 rounded-full border px-2 text-[10px] font-medium'
    : 'min-h-9 rounded-full border px-3 text-xs font-medium';

  if (run && ACTIVE_TASK_SESSION_STATUSES.has(run.status)) {
    return (
      <a
        href={run.resumeUrl}
        className={`${baseClass} press-scale inline-flex items-center border-accent-blue/35 bg-accent-blue/10 text-foreground`}
        title={run.hint}
        onPointerDown={stopPointer}
        onMouseDown={stopPointer}
        onClick={stopPointer}
      >
        {ownerLabel(run.owner)} · {TASK_SESSION_STATUS_LABELS[run.status]}
      </a>
    );
  }

  return (
    <span
      className="inline-flex flex-col items-start gap-1"
      onPointerDown={stopPointer}
      onMouseDown={stopPointer}
      onClick={stopPointer}
    >
      {activeRunCount >= 3 && owners.length > 0 && (
        <span className="text-[10px] leading-snug text-muted-foreground">
          More parallel sessions can increase Claude usage.
        </span>
      )}
      <span className="inline-flex flex-wrap items-center gap-1">
        {run && (
          <a
            href={run.resumeUrl}
            className={`${baseClass} press-scale inline-flex items-center border-accent-blue/35 bg-accent-blue/10 text-foreground`}
            title={run.hint}
            onPointerDown={stopPointer}
            onMouseDown={stopPointer}
            onClick={stopPointer}
          >
            {ownerLabel(run.owner)} · {TASK_SESSION_STATUS_LABELS[run.status]}
          </a>
        )}
        {owners.map((owner) => (
          <button
            key={owner}
            type="button"
            disabled={busy}
            className={`${baseClass} press-scale border-border/70 bg-background/55 text-muted-foreground hover:text-foreground disabled:opacity-50`}
            onClick={(event) => {
              event.stopPropagation();
              void Promise.resolve(onLaunch({ ...input, owner })).catch(() => undefined);
            }}
          >
            {busy ? 'Starting…' : ownerLabel(owner)}
          </button>
        ))}
      </span>
    </span>
  );
}

export function TaskSessionPanel({
  run,
  input,
  busy,
  preferredOwner,
  activeRunCount = 0,
  error,
  onLaunch,
}: {
  run?: TaskSessionRun;
  input: Omit<LaunchTaskSessionInput, 'owner'>;
  busy?: boolean;
  preferredOwner?: TaskSessionOwner;
  activeRunCount?: number;
  error?: string;
  onLaunch: (input: LaunchTaskSessionInput) => void | Promise<unknown>;
}) {
  return (
    <section className="mt-3 rounded-xl border bg-muted/40 p-3" aria-label="Claude session">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold text-foreground">Claude session</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {run?.hint ?? (
              preferredOwner === 'together'
                ? 'Together opens this task in plan mode.'
                : preferredOwner === 'claude'
                  ? 'Claude opens this task in auto-edits mode.'
                  : 'Choose Claude for auto-edits or Together for plan mode.'
            )}
          </p>
        </div>
        <TaskSessionLauncher
          input={input}
          run={run}
          busy={busy}
          preferredOwner={preferredOwner}
          activeRunCount={activeRunCount}
          onLaunch={onLaunch}
        />
      </div>
      {run && (
        <>
          {run.resultSummary && (
            <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-foreground">
              {run.resultSummary}
            </p>
          )}
          <p className="mt-2 break-all text-[11px] leading-relaxed text-muted-foreground">
            Outputs: {run.outputDir}
          </p>
        </>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-accent-red">{error}</p>}
    </section>
  );
}
