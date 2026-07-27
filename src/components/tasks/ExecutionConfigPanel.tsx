'use client';

import { useId, useState } from 'react';
import type { DayPlanExecutionState } from '@/lib/data/day-plan';
import type {
  DayPlanExecutionMode,
  DayPlanItem,
  DayPlanModelAlias,
} from '@/lib/day-plan/types';
import {
  executionReadinessMessage,
  executionRestartLabel,
  executionRunStatusLabel,
  executionWorkspaceLabel,
  isRetryableRunStatus,
  selectCurrentExecutionRow,
} from '@/lib/day-plan/presentation';
import { OpenInClaudeCode } from './ClaudeRunIndicators';

const ACTIVE_RUN_STATUSES = ['queued', 'starting', 'running', 'cancelling'];

export type ExecutionConfigPanelProps = {
  item: DayPlanItem;
  ariaTitle: string;
  // Kept in the shared panel contract for its existing callers.
  complexityText: string;
  executionItem?: DayPlanExecutionState['items'][number];
  runs: DayPlanExecutionState['runs'];
  workspaces: DayPlanExecutionState['workspaces'];
  busy: boolean;
  executionBusy: boolean;
  executionLoading: boolean;
  error?: string;
  planActionHandledExternally?: boolean;
  onKickoffExecution: (
    itemId: string,
    mode: DayPlanExecutionMode,
    modelAlias: DayPlanModelAlias,
    workspaceId?: string,
    budgetUsd?: number,
  ) => void | Promise<unknown>;
  onCancelExecution: (runId: string) => void | Promise<unknown>;
};

// Post-start controls for a single agent-owned item. Kickoff is shown only for a
// never-started item or a retryable terminal attempt; live and ready work opens instead.
export default function ExecutionConfigPanel({
  item,
  ariaTitle,
  complexityText,
  executionItem,
  runs,
  workspaces,
  busy,
  executionBusy,
  executionLoading,
  error,
  planActionHandledExternally = false,
  onKickoffExecution,
  onCancelExecution,
}: ExecutionConfigPanelProps) {
  const titleId = useId();
  const [executionDraft, setExecutionDraft] = useState<{
    mode?: DayPlanExecutionMode;
    workspaceId?: string;
    budgetUsd?: string;
    readinessCheckedAt?: string;
  }>({});

  if (item.owner !== 'claude' && item.owner !== 'together') return null;

  const { latestRun, currentRun } = selectCurrentExecutionRow(
    runs,
    item.id,
    executionItem?.config,
  );
  const activeRun = latestRun && ACTIVE_RUN_STATUSES.includes(latestRun.status)
    ? latestRun
    : undefined;
  const readiness = executionItem?.readiness;
  const briefChanged = readiness?.codes.includes('brief_changed') ?? false;
  const configuredMode = briefChanged ||
    (item.owner === 'together' && executionItem?.config?.mode === 'autonomous')
    ? undefined
    : executionItem?.config?.mode;
  const selectedMode: DayPlanExecutionMode = item.owner === 'together'
    ? 'plan_review'
    : executionDraft.mode ?? configuredMode ?? 'plan_review';
  void complexityText;
  const selectedModel: DayPlanModelAlias = 'fable';
  const selectedWorkspaceId = executionDraft.workspaceId ?? (
    configuredMode === 'autonomous' ? executionItem?.config?.workspaceId : undefined
  ) ?? '';
  const selectedBudgetText = executionDraft.budgetUsd ?? (
    configuredMode === 'autonomous' && executionItem?.config?.budgetUsd !== undefined
      ? String(executionItem.config.budgetUsd)
      : undefined
  ) ?? '';
  const selectedWorkspace = workspaces.find(
    (workspace) => workspace.id === selectedWorkspaceId,
  );
  const selectedBudget = Number(selectedBudgetText);
  const autonomousSetupReady = selectedMode !== 'autonomous' || Boolean(
    selectedWorkspace &&
    selectedBudgetText &&
    Number.isFinite(selectedBudget) &&
    selectedBudget > 0 &&
    selectedBudget <= selectedWorkspace.maximumBudgetUsd
  );
  const locallyFixableReadinessCodes = new Set([
    'mode_required',
    'owner_not_agent',
    'brief_changed',
    'workspace_required',
    'workspace_not_allowlisted',
    'budget_required',
    'budget_exceeds_limit',
  ]);
  const readinessAllowsAttempt = Boolean(
    selectedMode &&
    autonomousSetupReady &&
    (
      readiness?.ready ||
      readiness?.codes.every((code) => locallyFixableReadinessCodes.has(code))
    ),
  );
  const controlBusy = busy || executionBusy;
  const displayedRun = activeRun ?? currentRun;
  // A current run only blocks a new kickoff while it is live or holds a result. Runs
  // that ended failed, interrupted, or cancelled are retryable: the store supports a
  // fresh attempt under the same authorization, so Kick Off stays available.
  const actionRun = currentRun ?? latestRun;
  const reviewableActionRun = actionRun &&
    ['plan_ready', 'ready_to_join', 'awaiting_review'].includes(actionRun.status)
    ? actionRun
    : undefined;
  const missingSessionRun = reviewableActionRun && !reviewableActionRun.claudeSessionId
    ? reviewableActionRun
    : undefined;
  const showKickoff = !actionRun || isRetryableRunStatus(actionRun.status) || Boolean(missingSessionRun);
  const showKickoffControl = showKickoff && !(
    planActionHandledExternally && selectedMode === 'plan_review'
  );
  const reviewRun = currentRun &&
    ['plan_ready', 'ready_to_join', 'awaiting_review'].includes(currentRun.status) &&
    currentRun.resultSummary?.text
    ? currentRun
    : undefined;
  const openableRun = reviewableActionRun?.claudeSessionId ? reviewableActionRun : undefined;
  const reviewHeadingId = `${titleId}-claude-review`;
  const executionStatusMessage = selectedMode === 'autonomous' && workspaces.length === 0
    ? 'Tell Buddy which project should be connected to this item.'
    : selectedMode === 'autonomous' && !selectedWorkspaceId
      ? 'Choose a connected project.'
      : selectedMode === 'autonomous' && !selectedBudgetText
        ? 'Set a budget before kickoff.'
        : selectedMode === 'autonomous' && !autonomousSetupReady
          ? `Budget must be between $0.01 and $${selectedWorkspace?.maximumBudgetUsd ?? 0}.`
          : selectedMode === 'plan_review' && readiness?.codes.includes('mode_required')
            ? 'Ready to plan with Claude.'
          : briefChanged
            ? executionReadinessMessage(readiness, item.owner)
            : missingSessionRun
              ? "Claude's session reference is missing — restart planning to reopen it."
            : displayedRun
              ? executionRunStatusLabel(displayedRun.status)
              : executionLoading
                ? 'Checking readiness…'
                : executionReadinessMessage(readiness, item.owner);

  function chooseWorkspace(workspaceId: string) {
    setExecutionDraft((current) => ({
      ...current,
      workspaceId,
      budgetUsd: undefined,
      readinessCheckedAt: readiness?.checkedAt,
    }));
  }

  return (
    <section
      className="mt-3 rounded-xl border bg-muted/40 p-3"
      aria-label={`Claude execution for ${ariaTitle}`}
      data-card-control
    >
      {showKickoff && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {item.owner === 'claude' ? (
            (['plan_review', 'autonomous'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                disabled={controlBusy}
                aria-pressed={selectedMode === mode}
                className={`rounded-full border px-2.5 py-1 font-medium ${
                  selectedMode === mode
                    ? 'border-accent-blue/40 bg-accent-blue/10 text-foreground'
                    : 'text-muted-foreground'
                }`}
                onClick={() => setExecutionDraft((current) => ({ ...current, mode }))}
              >
                {mode === 'plan_review' ? 'Plan with Claude' : 'Hands-off (Claude does it)'}
              </button>
            ))
          ) : (
            <span className="rounded-full border border-accent-blue/40 bg-accent-blue/10 px-2.5 py-1 font-medium text-foreground">
              Plan with Claude
            </span>
          )}
        </div>
      )}
      {selectedMode === 'autonomous' && workspaces.length > 0 && (
        <div className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(7.5rem,0.7fr)] gap-2">
          <label className="min-w-0 text-xs text-muted-foreground">
            <span className="mb-1 block">Project</span>
            <select
              value={selectedWorkspaceId}
              disabled={controlBusy || Boolean(activeRun)}
              className="h-9 w-full rounded-lg border bg-background px-2 text-xs text-foreground"
              onChange={(event) => chooseWorkspace(event.target.value)}
            >
              <option value="">Project…</option>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {executionWorkspaceLabel(workspace.id)} — ${workspace.maximumBudgetUsd} limit
                </option>
              ))}
            </select>
          </label>
          <label className="min-w-0 text-xs text-muted-foreground">
            <span className="mb-1 block">Spend limit ($)</span>
            <span className="flex items-center rounded-lg border bg-background px-2">
              <input
              type="number"
              inputMode="decimal"
              min="0.01"
              max={selectedWorkspace?.maximumBudgetUsd}
              step="0.01"
              value={selectedBudgetText}
              disabled={controlBusy || Boolean(activeRun) || !selectedWorkspace}
              className="h-8 min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none"
              aria-label="Spend limit ($)"
              placeholder={selectedWorkspace
                ? `up to ${selectedWorkspace.maximumBudgetUsd}`
                : 'budget'}
              onChange={(event) => setExecutionDraft((current) => ({
                ...current,
                budgetUsd: event.target.value,
                readinessCheckedAt: readiness?.checkedAt,
              }))}
              />
            </span>
          </label>
        </div>
      )}
      <div className="mt-2 flex items-end gap-2">
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-muted-foreground" role="status">
          {/* Keyed so a status change replays the subtle enter; the live region itself
              stays mounted so screen readers still announce the new text. */}
          <span key={executionStatusMessage} className="panel-pop-in inline-block">
            {executionStatusMessage}
          </span>
        </p>
        {activeRun && (
          <button
            type="button"
            disabled={controlBusy || activeRun.status === 'cancelling'}
            className="press-scale min-h-9 shrink-0 rounded-lg border px-2.5 text-xs font-medium text-muted-foreground disabled:opacity-40"
            onClick={() => void Promise.resolve(onCancelExecution(activeRun.id)).catch(() => undefined)}
          >
            {activeRun.status === 'cancelling' ? 'Stopping…' : 'Cancel'}
          </button>
        )}
        {showKickoffControl && (
          <button
            type="button"
            disabled={
              controlBusy ||
              executionLoading ||
              Boolean(activeRun) ||
              !readinessAllowsAttempt
            }
            className="press-scale min-h-9 shrink-0 rounded-lg bg-foreground px-3 text-xs font-semibold text-background disabled:opacity-40"
            onClick={() => {
              void Promise.resolve(
                onKickoffExecution(
                  item.id,
                  selectedMode,
                  selectedModel,
                  selectedMode === 'autonomous' ? selectedWorkspaceId : undefined,
                  selectedMode === 'autonomous' ? selectedBudget : undefined,
                ),
              ).catch(() => undefined);
            }}
          >
            {executionBusy
              ? 'Preparing…'
              : missingSessionRun
                ? 'Restart'
              : actionRun && isRetryableRunStatus(actionRun.status)
                ? executionRestartLabel(actionRun.status)
                : selectedMode === 'plan_review'
                  ? 'Ask Claude to plan'
                  : 'Start hands-off work'}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs leading-relaxed text-accent-red">
          {error}
        </p>
      )}
      {activeRun ? (
        <div className="panel-pop-in mt-2 flex justify-end">
          <button
            type="button"
            disabled
            className={`min-h-9 shrink-0 rounded-lg border px-3 text-xs font-semibold opacity-60 ${
              activeRun.status === 'running'
                ? 'border-accent-blue/50 bg-accent-blue/10 text-foreground'
                : 'border-border/70 bg-muted/60 text-muted-foreground'
            }`}
          >
            {activeRun.status === 'running'
              ? 'Working…'
              : activeRun.status === 'cancelling'
                ? 'Stopping…'
                : 'Waiting to start'}
          </button>
        </div>
      ) : openableRun && (
        <div className="panel-pop-in mt-2 flex justify-end">
          <OpenInClaudeCode
            sessionId={openableRun.claudeSessionId}
            mode={openableRun.mode}
            title={ariaTitle}
            label="Review plan"
            resumeCommand={openableRun.resumeCommand}
          />
        </div>
      )}
      {reviewRun && (
        <div
          className="panel-pop-in mt-2 max-h-28 overflow-y-auto rounded-lg border bg-background p-2.5 text-xs"
          role="region"
          aria-labelledby={reviewHeadingId}
          tabIndex={0}
        >
          <p id={reviewHeadingId} className="font-semibold text-foreground">
            {reviewRun.status === 'plan_ready' ? 'Plan ready' : 'Review Claude’s work'}
          </p>
          <p className="mt-1 whitespace-pre-wrap leading-relaxed text-muted-foreground">
            {reviewRun.resultSummary?.text}
          </p>
        </div>
      )}
    </section>
  );
}
