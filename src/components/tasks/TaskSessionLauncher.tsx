'use client';

import type {
  LaunchTaskSessionInput,
  TaskSessionLaunchMode,
  TaskSessionOwner,
  TaskSessionRun,
} from '@/lib/task-sessions/types';
import {
  ACTIVE_TASK_SESSION_STATUSES,
  TASK_SESSION_STATUS_LABELS,
} from '@/lib/task-sessions/types';

function modeLabel(mode: TaskSessionLaunchMode): string {
  return mode === 'planning' ? 'Planning' : 'Auto';
}

function modeForOwner(owner: TaskSessionOwner): TaskSessionLaunchMode {
  return owner === 'together' ? 'planning' : 'auto';
}

function ownerForMode(mode: TaskSessionLaunchMode): TaskSessionOwner {
  return mode === 'planning' ? 'together' : 'claude';
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

export function taskSessionModeButtons(
  run: Pick<TaskSessionRun, 'status'> | undefined,
  preferredOwner: TaskSessionOwner | undefined,
): TaskSessionLaunchMode[] {
  return taskSessionOwnerButtons(run, preferredOwner).map(modeForOwner);
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
  input: Omit<LaunchTaskSessionInput, 'owner' | 'mode'>;
  run?: TaskSessionRun;
  busy?: boolean;
  preferredOwner?: TaskSessionOwner;
  compact?: boolean;
  activeRunCount?: number;
  onLaunch: (input: LaunchTaskSessionInput) => void | Promise<unknown>;
}) {
  const modes = taskSessionModeButtons(run, preferredOwner);
  const baseClass = compact
    ? 'min-h-8 rounded-full border px-2 text-[12px] font-medium'
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
        {modeLabel(run.permissionMode === 'plan' ? 'planning' : 'auto')} · {TASK_SESSION_STATUS_LABELS[run.status]}
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
      {activeRunCount >= 3 && modes.length > 0 && (
        <span className="text-[12px] leading-snug text-muted-foreground">
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
            {modeLabel(run.permissionMode === 'plan' ? 'planning' : 'auto')} · {TASK_SESSION_STATUS_LABELS[run.status]}
          </a>
        )}
        {modes.map((mode) => (
          <button
            key={mode}
            type="button"
            disabled={busy}
            className={`${baseClass} press-scale border-border/70 bg-background/55 text-muted-foreground hover:text-foreground disabled:opacity-50`}
            onClick={(event) => {
              event.stopPropagation();
              void Promise.resolve(onLaunch({
                ...input,
                owner: ownerForMode(mode),
                mode,
              })).catch(() => undefined);
            }}
          >
            {busy ? 'Starting…' : modeLabel(mode)}
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
  input: Omit<LaunchTaskSessionInput, 'owner' | 'mode'>;
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
                ? 'Planning opens this task in plan mode.'
                : preferredOwner === 'claude'
                  ? 'Auto opens this task in auto-edits mode.'
                  : 'Choose Planning for plan mode or Auto for auto-edits.'
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
          <p className="mt-2 break-all text-[12px] leading-relaxed text-muted-foreground">
            Outputs: {run.outputDir}
          </p>
        </>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-accent-red">{error}</p>}
    </section>
  );
}
