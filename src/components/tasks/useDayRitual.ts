'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  acknowledgeDayPlanReconciliation,
  acknowledgeDayPlanTaskMutation,
  cancelDayPlanExecutionRun,
  configureDayPlanExecution,
  DayPlanApiConflict,
  ensureDayPlan,
  forceMorningBrief,
  getDayPlanExecutionRunState,
  getDayPlanExecutionState,
  getDayPlanState,
  kickoffDayPlanItem,
  markDayPlanArrivalInteraction,
  mutateDayPlan,
  newDayPlanMutationId,
  onceOnlyDayPlanMutationId,
  type DayPlanExecutionState,
} from '@/lib/data/day-plan';
import { launchTaskSessionRun } from '@/lib/data/task-sessions';
import type {
  MorningBriefGeneration,
  PublicMorningBrief,
} from '@/lib/day-plan/brief';
import { isWeekendLocalDate } from '@/lib/day-plan/weekday';
import { morningBriefSyncDecision } from '@/lib/day-plan/brief-view';
import { useDataChanged } from '@/lib/data/refresh-bus';
import type {
  DayPlan,
  DayPlanItem,
  DayPlanExecutionMode,
  DayPlanModelAlias,
  DayPlanMutationAction,
  DayPlanMutationInput,
  DayPlanMutationResult,
  DayPlanOwner,
  DayPlanReconciliation,
  DayPlanTaskMutation,
  DayPlanWeekendGate,
  DaySnapshot,
  RecommendationCandidate,
  SettlementDisposition,
} from '@/lib/day-plan/types';
import {
  advanceMorningBriefAttachPoll,
  executionReadinessMessage,
  focusBandItems,
  shouldAttemptLateBriefAttach,
  shouldPollBriefGeneration,
  startDayReceiptCopy,
} from '@/lib/day-plan/presentation';
import { getRuntimeMode } from '@/lib/runtime/mode';

// While the arrival is open with no brief and one is still being written, re-poll
// the read model at this cadence to pick the brief up the moment it lands.
const BRIEF_GENERATION_POLL_MS = 15_000;
export const EXECUTION_STATUS_POLL_MS = 30_000;
const CLOUD_EXECUTION_POLL_MS = 1_500;
const CLOUD_EXECUTION_RETRY_MS = 2_000;

export function executionPollingPolicy(localMode: boolean): {
  initialMs: number;
  retryMs: number;
  statusOnly: boolean;
} {
  return localMode
    ? {
        initialMs: EXECUTION_STATUS_POLL_MS,
        retryMs: EXECUTION_STATUS_POLL_MS,
        statusOnly: true,
      }
    : {
        initialMs: CLOUD_EXECUTION_POLL_MS,
        retryMs: CLOUD_EXECUTION_RETRY_MS,
        statusOnly: false,
      };
}

export function localTaskSessionKickoffItems<T extends DayPlanItem>(items: readonly T[]): T[] {
  return focusBandItems(items).filter(
    (item) => item.owner === 'claude' || item.owner === 'together',
  );
}

export type DayRitualView =
  | 'checking'
  | 'none'
  | 'arrival'
  | 'settlement';

type UseDayRitualInput = {
  enabled: boolean;
  candidates: RecommendationCandidate[];
  candidatesReady: boolean;
  onBriefPicksChange?: (
    picks: ReadonlyArray<{ taskId: string; whyToday: string }>,
    briefReady: boolean,
  ) => void | Promise<void>;
};

function localDateInTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function inferView(plan?: DayPlan): DayRitualView {
  if (!plan) return 'none';
  if (plan.state === 'settling' && plan.settlementState === 'in_progress') {
    return 'settlement';
  }
  if (plan.state === 'proposed' && plan.arrivalState === 'opened') {
    return 'arrival';
  }
  return 'none';
}

function snoozeHasElapsed(plan: DayPlan, now = new Date()): boolean {
  if (plan.arrivalState !== 'snoozed' || !plan.snoozedUntil) return false;
  const wakeAt = new Date(plan.snoozedUntil).getTime();
  return Number.isFinite(wakeAt) && wakeAt <= now.getTime();
}

function stableMutationId(action: string, plan: DayPlan): string {
  return `${action}:${plan.id}:${plan.version}`;
}

const ACTIVE_EXECUTION_STATES = new Set(['queued', 'starting', 'running', 'cancelling']);

function emptyExecutionState(workerAvailable = true): DayPlanExecutionState {
  return { items: [], runs: [], workspaces: [], workerAvailable };
}

function assertAutonomousSetup(
  mode: DayPlanExecutionMode,
  state: DayPlanExecutionState | undefined,
  workspaceId: string | undefined,
  budgetUsd: number | undefined,
) {
  if (mode !== 'autonomous') return;
  if (!state?.workspaces.length) {
    throw new Error('Tell Buddy which project should be connected to this item.');
  }
  const workspace = state.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) throw new Error('Choose a connected project.');
  if (
    budgetUsd === undefined ||
    !Number.isFinite(budgetUsd) ||
    budgetUsd <= 0 ||
    budgetUsd > workspace.maximumBudgetUsd
  ) {
    throw new Error(`Set a budget between $0.01 and $${workspace.maximumBudgetUsd}.`);
  }
}

export default function useDayRitual({
  enabled,
  candidates,
  candidatesReady,
  onBriefPicksChange,
}: UseDayRitualInput) {
  const [plan, setPlan] = useState<DayPlan>();
  const [morningBrief, setMorningBrief] = useState<PublicMorningBrief>();
  const [briefGeneration, setBriefGeneration] = useState<MorningBriefGeneration>();
  const [briefAttachTimedOut, setBriefAttachTimedOut] = useState(false);
  const [briefTransportReady, setBriefTransportReady] = useState(false);
  const [weekendGate, setWeekendGate] = useState<DayPlanWeekendGate>();
  const [planningWeekend, setPlanningWeekend] = useState(false);
  // In flight for the "write it anyway" tap, so the button can refuse a second
  // press before the first round trip answers.
  const [forcingBrief, setForcingBrief] = useState(false);
  // The arrival's no-hot-swap gate: a late brief may swap into a pristine arrival,
  // but the first real interaction freezes it. The ref guards the sync setter; the
  // state drives the polling effect.
  const [arrivalInteracted, setArrivalInteracted] = useState(false);
  const arrivalInteractedRef = useRef(false);
  // Once-per-page-load (and once per visibility regain) guard for the one-shot
  // attach-only ensure that picks up a brief which landed while the app was
  // closed. Reset when a new plan arrives.
  const lateAttachAttemptedRef = useRef(false);
  const briefAttachPollCountRef = useRef(0);
  const [latestSnapshot, setLatestSnapshot] = useState<DaySnapshot>();
  const [pendingReconciliations, setPendingReconciliations] = useState<DayPlanReconciliation[]>([]);
  const [pendingTaskMutations, setPendingTaskMutations] = useState<DayPlanTaskMutation[]>([]);
  const [view, setView] = useState<DayRitualView>(enabled ? 'checking' : 'none');
  const [busy, setBusy] = useState(false);
  const [savingItemIds, setSavingItemIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>();
  const [announcement, setAnnouncement] = useState('');
  const [startReceipt, setStartReceipt] = useState<string>();
  const [settlementReceipt, setSettlementReceipt] = useState<string>();
  const [startDayApplying, setStartDayApplying] = useState(false);
  const [executionState, setExecutionState] = useState<DayPlanExecutionState>();
  const [executionLoading, setExecutionLoading] = useState(false);
  const [executionBusyItemIds, setExecutionBusyItemIds] = useState<Set<string>>(new Set());
  const [executionError, setExecutionError] = useState<string>();
  const planRef = useRef<DayPlan | undefined>(undefined);
  const morningBriefRef = useRef<PublicMorningBrief | undefined>(undefined);
  const executionStateRef = useRef<DayPlanExecutionState | undefined>(undefined);
  const candidatesRef = useRef(candidates);
  const reconciliationBlockedRef = useRef(false);
  const mutationQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const receiptTimerRef = useRef<number | undefined>(undefined);
  const reportedBriefPicksRef = useRef<string | undefined>(undefined);

  candidatesRef.current = candidates;

  useEffect(() => {
    if (briefGeneration?.state !== 'succeeded') {
      setBriefTransportReady(false);
      if (reportedBriefPicksRef.current !== undefined) {
        reportedBriefPicksRef.current = undefined;
        void onBriefPicksChange?.([], false);
      }
      return;
    }
    const picks = briefGeneration.pickedTasks ?? [];
    const signature = JSON.stringify(picks);
    if (signature === reportedBriefPicksRef.current) return;
    reportedBriefPicksRef.current = signature;
    setBriefTransportReady(false);
    void Promise.resolve(onBriefPicksChange?.(picks, true)).finally(() => {
      if (reportedBriefPicksRef.current === signature) setBriefTransportReady(true);
    });
  }, [briefGeneration, onBriefPicksChange]);

  const applyMorningBrief = useCallback((next: PublicMorningBrief | undefined) => {
    morningBriefRef.current = next;
    setMorningBrief(next);
  }, []);

  // The first content interaction inside an open arrival. It freezes the arrival
  // against any late-brief hot-swap and stops the generation poll for the day,
  // and durably records the interaction on the server so the guarded late-attach
  // will not fire either. Fire-and-forget: the local freeze is authoritative for
  // this session regardless of the request outcome.
  const markArrivalInteraction = useCallback(() => {
    if (arrivalInteractedRef.current) return;
    arrivalInteractedRef.current = true;
    setArrivalInteracted(true);
    const current = planRef.current;
    if (current) {
      void markDayPlanArrivalInteraction({
        planId: current.id,
        mutationId: `arrival_interact:${current.id}:${newDayPlanMutationId()}`,
      }).catch(() => undefined);
    }
  }, []);

  const acceptPlan = useCallback((nextPlan: DayPlan, snapshot?: DaySnapshot) => {
    // A brand-new plan (a new day, or after settlement) is a fresh, untouched
    // arrival; same-id updates from the user's own mutations keep the frozen flag.
    if (planRef.current?.id !== nextPlan.id) {
      arrivalInteractedRef.current = false;
      setArrivalInteracted(false);
      // A new plan gets its own one-shot late-attach attempt.
      lateAttachAttemptedRef.current = false;
      briefAttachPollCountRef.current = 0;
      setBriefAttachTimedOut(false);
    }
    planRef.current = nextPlan;
    setPlan(nextPlan);
    if (snapshot) setLatestSnapshot(snapshot);
    // The held brief is keyed to plan.briefId: a plan that consumed no brief
    // clears it (yesterday's content must never render against today's plan),
    // and a plan whose brief we do not hold refetches the pinned projection.
    const decision = morningBriefSyncDecision(nextPlan.briefId, morningBriefRef.current);
    if (decision === 'clear') {
      applyMorningBrief(undefined);
    } else if (decision === 'refresh') {
      void getDayPlanState()
        .then((readModel) => {
          if (planRef.current?.id !== nextPlan.id) return;
          applyMorningBrief(
            readModel.morningBrief && readModel.morningBrief.id === nextPlan.briefId
              ? readModel.morningBrief
              : undefined,
          );
        })
        .catch(() => undefined);
    }
    setView(inferView(nextPlan));
  }, [applyMorningBrief]);

  useEffect(() => () => {
    if (receiptTimerRef.current !== undefined) {
      window.clearTimeout(receiptTimerRef.current);
    }
  }, []);

  const refreshPlan = useCallback(async () => {
    const readModel = await getDayPlanState();
    setLatestSnapshot(readModel.latestSnapshot);
    setPendingReconciliations(readModel.pendingReconciliations);
    setPendingTaskMutations(readModel.pendingTaskMutations);
    // The projection is pinned to the brief this plan consumed at ensure, so a
    // refresh can only re-deliver the same artifact, never hot-swap content.
    applyMorningBrief(readModel.morningBrief);
    setBriefGeneration(readModel.briefGeneration);
    if (readModel.currentPlan) acceptPlan(readModel.currentPlan, readModel.latestSnapshot);
    return readModel.currentPlan;
  }, [acceptPlan, applyMorningBrief]);

  useDataChanged(['day_plan'], () => void refreshPlan().catch(() => undefined));

  // Keep the ref current because acceptPlan reads it synchronously.
  useEffect(() => {
    morningBriefRef.current = morningBrief;
  }, [morningBrief]);

  useEffect(() => {
    if (plan?.briefId || briefGeneration?.state !== 'succeeded') {
      briefAttachPollCountRef.current = 0;
      if (briefAttachTimedOut) setBriefAttachTimedOut(false);
    }
  }, [briefAttachTimedOut, briefGeneration?.state, plan?.briefId]);

  const acceptExecutionState = useCallback((next: DayPlanExecutionState) => {
    executionStateRef.current = next;
    setExecutionState(next);
  }, []);

  const refreshExecution = useCallback(async (planId?: string) => {
    const targetPlanId = planId ?? planRef.current?.id;
    if (!targetPlanId) return undefined;
    setExecutionLoading(true);
    try {
      const next = await getDayPlanExecutionState(targetPlanId);
      acceptExecutionState(next);
      setExecutionError(undefined);
      return next;
    } catch (nextError) {
      const message = nextError instanceof Error
        ? nextError.message
        : "Cove couldn't refresh Claude execution state.";
      setExecutionError(message);
      throw nextError;
    } finally {
      setExecutionLoading(false);
    }
  }, [acceptExecutionState]);

  const refreshExecutionRuns = useCallback(async (planId?: string) => {
    const targetPlanId = planId ?? planRef.current?.id;
    if (!targetPlanId) return undefined;
    const next = await getDayPlanExecutionRunState(targetPlanId);
    const previous = executionStateRef.current ?? emptyExecutionState(next.workerAvailable);
    const merged = {
      ...previous,
      runs: next.runs,
      workerAvailable: next.workerAvailable,
    };
    acceptExecutionState(merged);
    return merged;
  }, [acceptExecutionState]);

  useEffect(() => {
    if (!enabled) {
      setView('none');
      return;
    }

    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const localDate = localDateInTimezone(new Date(), timezone);
    let cancelled = false;

    async function initialize() {
      setView('checking');
      setError(undefined);
      try {
        const readModel = await getDayPlanState();
        if (cancelled) return;
        setLatestSnapshot(readModel.latestSnapshot);
        setPendingReconciliations(readModel.pendingReconciliations);
        setPendingTaskMutations(readModel.pendingTaskMutations);
        applyMorningBrief(readModel.morningBrief);
        setBriefGeneration(readModel.briefGeneration);

        let nextPlan = readModel.currentPlan;
        if (!nextPlan) {
          if (readModel.pendingReconciliations.length > 0) {
            reconciliationBlockedRef.current = true;
            planRef.current = undefined;
            setPlan(undefined);
            setView('none');
            setError('Cove is finishing the previous day before it prepares today.');
            return;
          }
          if (reconciliationBlockedRef.current) {
            setView('none');
            return;
          }
          if (!candidatesReady && !isWeekendLocalDate(localDate)) {
            setView('none');
            setError('Cove needs a fresh task refresh before it can propose today’s plan.');
            return;
          }
          const ensured = await ensureDayPlan({
            localDate,
            timezone,
            mutationId: onceOnlyDayPlanMutationId('ensure', localDate),
            candidates: candidatesReady ? candidatesRef.current : [],
            creation: 'automatic',
          });
          if ('weekendGate' in ensured) {
            setWeekendGate(ensured.weekendGate);
            setView('none');
            return;
          }
          nextPlan = ensured.plan;
          if (ensured.snapshot) setLatestSnapshot(ensured.snapshot);
          if (nextPlan.briefId) {
            // The plan consumed a Morning Brief at ensure; pick up its
            // loopback projection. Fail-open: arrival never waits on it.
            const refreshed = await getDayPlanState().catch(() => undefined);
            if (!cancelled && refreshed) {
              applyMorningBrief(refreshed.morningBrief);
              setBriefGeneration(refreshed.briefGeneration);
            }
          }
        }

        if (cancelled) return;
        setWeekendGate(undefined);

        if (nextPlan.localDate !== localDate) {
          let stalePlan = nextPlan;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              if (
                stalePlan.state === 'settling' &&
                stalePlan.settlementState === 'in_progress'
              ) {
                break;
              }
              if (stalePlan.state === 'proposed') {
                if (stalePlan.arrivalState === 'failed') {
                  stalePlan = (await mutateDayPlan({
                    planId: stalePlan.id,
                    mutationId: stableMutationId('stale-arrival-reopen', stalePlan),
                    expectedVersion: stalePlan.version,
                    action: 'arrival_reopen',
                  })).plan;
                }
                if (!['skipped', 'bypassed'].includes(stalePlan.arrivalState)) {
                  stalePlan = (await mutateDayPlan({
                    planId: stalePlan.id,
                    mutationId: stableMutationId('stale-arrival-bypass', stalePlan),
                    expectedVersion: stalePlan.version,
                    action: 'arrival_bypass',
                  })).plan;
                }
              }
              stalePlan = (await mutateDayPlan({
                planId: stalePlan.id,
                mutationId: stableMutationId('stale-settlement-start', stalePlan),
                expectedVersion: stalePlan.version,
                action: 'settlement_start',
              })).plan;
              break;
            } catch (nextError) {
              if (nextError instanceof DayPlanApiConflict) {
                stalePlan = nextError.currentPlan;
                continue;
              }
              throw nextError;
            }
          }
          if (
            stalePlan.state !== 'settling' ||
            stalePlan.settlementState !== 'in_progress'
          ) {
            throw new Error('Cove could not prepare the previous workday to close.');
          }
          if (cancelled) return;
          setAnnouncement('Close the previous workday before planning today.');
          acceptPlan(stalePlan, readModel.latestSnapshot);
          return;
        }

        planRef.current = nextPlan;
        setPlan(nextPlan);

        if (
          nextPlan.state === 'proposed' &&
          (nextPlan.arrivalState === 'due' ||
            nextPlan.arrivalState === 'not_due' ||
            nextPlan.arrivalState === 'failed' ||
            snoozeHasElapsed(nextPlan))
        ) {
          const opened = await mutateDayPlan({
            planId: nextPlan.id,
            mutationId: stableMutationId('arrival-open', nextPlan),
            expectedVersion: nextPlan.version,
            action: 'arrival_open',
          });
          if (!cancelled) acceptPlan(opened.plan, opened.snapshot);
          return;
        }

        acceptPlan(nextPlan, readModel.latestSnapshot);
      } catch (nextError) {
        if (cancelled) return;
        setView('none');
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Cove couldn't load the morning start. Today is still available.",
        );
      }
    }

    void initialize();
    return () => {
      cancelled = true;
    };
  }, [acceptPlan, applyMorningBrief, candidatesReady, enabled]);

  useEffect(() => {
    if (!enabled || !plan?.id || getRuntimeMode() === 'local') return;
    void refreshExecution(plan.id).catch(() => undefined);
  }, [enabled, plan?.id, plan?.version, refreshExecution]);

  useEffect(() => {
    if (!executionState?.runs.some((run) => ACTIVE_EXECUTION_STATES.has(run.status))) return;
    const localMode = getRuntimeMode() === 'local';
    const polling = executionPollingPolicy(localMode);
    let cancelled = false;
    let timeout: number | undefined;

    async function poll() {
      try {
        if (polling.statusOnly) {
          await refreshExecutionRuns(planRef.current?.id);
        } else {
          await refreshExecution(planRef.current?.id);
        }
      } catch {
        if (!cancelled) {
          timeout = window.setTimeout(
            () => void poll(),
            polling.retryMs,
          );
        }
      }
    }

    timeout = window.setTimeout(
      () => void poll(),
      polling.initialMs,
    );
    return () => {
      cancelled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [executionState, refreshExecution, refreshExecutionRuns]);

  // One poll/heal step. When the arrival has no brief or no items, it re-ensures
  // with fresh candidates: the store can attach a synced brief and/or rebuild
  // the empty proposal. A plain GET could only re-deliver the same artifact.
  // A succeeded brief can attach with an empty candidate list; item healing
  // still requires fresh candidates. Falls back to a GET when neither applies.
  const pollForLateBrief = useCallback(async () => {
    const current = planRef.current;
    const candidates = candidatesRef.current;
    const hasFreshCandidates = candidatesReady && candidates.length > 0;
    const shouldAttachSucceededBrief =
      Boolean(current && !current.briefId) &&
      briefGeneration?.state === 'succeeded' &&
      briefTransportReady;
    const shouldHealItems = Boolean(current?.items.length === 0 && hasFreshCandidates);
    if (
      current &&
      (shouldAttachSucceededBrief || shouldHealItems)
    ) {
      try {
        const ensured = await ensureDayPlan({
          localDate: current.localDate,
          timezone: current.timezone,
          mutationId: `ensure:late-brief:${current.id}:${newDayPlanMutationId()}`,
          candidates: hasFreshCandidates ? candidates : [],
          // Attach-or-silent-no-op: the server records nothing unless a brief
          // actually attaches, so this 15s poll never grows the event ledger.
          attachOnly: true,
        });
        if ('weekendGate' in ensured) return;
        acceptPlan(ensured.plan, ensured.snapshot);
        const refreshed = await getDayPlanState().catch(() => undefined);
        if (refreshed) {
          applyMorningBrief(refreshed.morningBrief);
          setBriefGeneration(refreshed.briefGeneration);
        }
        return;
      } catch {
        // Fall through to a plain refresh; the arrival never waits on the brief.
      }
    }
    await refreshPlan().catch(() => undefined);
  }, [acceptPlan, applyMorningBrief, briefGeneration, briefTransportReady, candidatesReady, refreshPlan]);

  // When the arrival is open with no consumed brief and one is still being
  // written, re-poll so a late brief can swap in gently (via the existing
  // morningBriefSyncDecision in acceptPlan). The poll runs only while the
  // arrival is visible and untouched; the first interaction or a consumed brief
  // closes the gate for the day (never a hot-swap after interaction).
  useEffect(() => {
    if (!enabled) return;
    const gateOpen = () =>
      shouldPollBriefGeneration({
        view,
        documentVisible:
          typeof document === 'undefined' || document.visibilityState === 'visible',
        briefAttached: Boolean(planRef.current?.briefId),
        arrivalInteracted:
          arrivalInteractedRef.current || Boolean(planRef.current?.arrivalInteractedAt),
        attachTimedOut: briefAttachTimedOut,
        generationState: briefGeneration?.state,
      });
    if (!gateOpen()) return;

    let cancelled = false;
    let timeout: number | undefined;

    const tick = async () => {
      if (cancelled) return;
      let polled = false;
      // Skip the fetch while hidden or interacted, but keep the timer so polling
      // resumes on its own when the document becomes visible again.
      if (
        (typeof document === 'undefined' || document.visibilityState === 'visible') &&
        !arrivalInteractedRef.current
      ) {
        // Re-ensure so the server imports + late-attaches a synced brief;
        // acceptPlan applies the sync decision, so it swaps in here.
        await pollForLateBrief();
        polled = true;
      }
      if (polled && !cancelled) {
        const next = advanceMorningBriefAttachPoll({
          consecutiveSucceededPolls: briefAttachPollCountRef.current,
          briefAttached: Boolean(planRef.current?.briefId),
          generationState: briefGeneration?.state,
        });
        briefAttachPollCountRef.current = next.consecutiveSucceededPolls;
        setBriefAttachTimedOut(next.attachTimedOut);
        if (next.attachTimedOut) return;
      }
      if (!cancelled) timeout = window.setTimeout(() => void tick(), BRIEF_GENERATION_POLL_MS);
    };

    timeout = window.setTimeout(() => void tick(), BRIEF_GENERATION_POLL_MS);
    return () => {
      cancelled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [
    enabled,
    view,
    arrivalInteracted,
    briefAttachTimedOut,
    briefGeneration?.state,
    plan?.briefId,
    plan?.arrivalInteractedAt,
    pollForLateBrief,
  ]);

  // One-shot arrival heal. On initialization (and again when the document
  // regains visibility), a pristine arrival sends one attach-only ensure when
  // either its brief is missing or its item list is empty. The server can attach
  // a synced brief and/or rebuild candidates in one versioned mutation.
  useEffect(() => {
    if (!enabled) return;
    const attempt = () => {
      const current = planRef.current;
      const open = shouldAttemptLateBriefAttach({
        planState: current?.state,
        arrivalState: current?.arrivalState,
        hasConsumedBrief: Boolean(current?.briefId),
        arrivalInteractedAt: current?.arrivalInteractedAt,
        interacted: arrivalInteractedRef.current,
        documentVisible:
          typeof document === 'undefined' || document.visibilityState === 'visible',
        candidatesReady,
        candidateCount: candidatesRef.current.length,
        generationState: briefGeneration?.state,
        itemCount: current?.items.length,
        alreadyAttempted: lateAttachAttemptedRef.current,
      });
      if (!open) return;
      lateAttachAttemptedRef.current = true;
      void pollForLateBrief();
    };
    attempt();
    if (typeof document === 'undefined') return;
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      // A fresh look at the app earns one fresh attempt; the durable
      // interaction marker and briefId still gate inside attempt().
      lateAttachAttemptedRef.current = false;
      attempt();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [
    enabled,
    plan?.id,
    plan?.state,
    plan?.briefId,
    plan?.arrivalState,
    plan?.arrivalInteractedAt,
    plan?.items.length,
    candidatesReady,
    candidates.length,
    briefGeneration?.state,
    pollForLateBrief,
  ]);

  const enqueueMutation = useCallback(
    async (
      action: DayPlanMutationAction,
      patch: Partial<Omit<DayPlanMutationInput, 'planId' | 'mutationId' | 'expectedVersion' | 'action'>> = {},
      options: { mutationId?: string; itemId?: string; announce?: string } = {},
    ): Promise<DayPlanMutationResult> => {
      const run = async () => {
        const current = planRef.current;
        if (!current) throw new Error('The day plan is not ready.');
        setBusy(true);
        setError(undefined);
        if (options.itemId) {
          setSavingItemIds((items) => new Set(items).add(options.itemId!));
        }
        try {
          const result = await mutateDayPlan({
            planId: current.id,
            mutationId: options.mutationId ?? newDayPlanMutationId(),
            expectedVersion: current.version,
            action,
            ...patch,
          });
          acceptPlan(result.plan, result.snapshot);
          if (result.pendingReconciliations) {
            setPendingReconciliations(result.pendingReconciliations);
            if (result.pendingReconciliations.length > 0) {
              reconciliationBlockedRef.current = true;
            }
          }
          if (options.announce) setAnnouncement(options.announce);
          return result;
        } catch (nextError) {
          if (nextError instanceof DayPlanApiConflict) {
            acceptPlan(nextError.currentPlan);
          }
          const message =
            nextError instanceof Error ? nextError.message : "Cove couldn't update the day plan.";
          setError(message);
          throw nextError;
        } finally {
          setBusy(false);
          if (options.itemId) {
            setSavingItemIds((items) => {
              const next = new Set(items);
              next.delete(options.itemId!);
              return next;
            });
          }
        }
      };

      const queued = mutationQueueRef.current.then(run, run);
      mutationQueueRef.current = queued.catch(() => undefined);
      return queued;
    },
    [acceptPlan],
  );

  const openArrival = useCallback(async () => {
    const current = planRef.current;
    if (!current) throw new Error('There is no day plan to open.');
    if (current.state === 'settled') throw new Error('Today is already closed.');
    if (current.state === 'proposed' && current.arrivalState === 'opened') {
      setView('arrival');
      return;
    }
    const action = current.state === 'active' || current.state === 'settling' ||
      current.arrivalState === 'skipped' || current.arrivalState === 'bypassed'
        ? 'arrival_reopen'
        : 'arrival_open';
    await enqueueMutation(action, {}, { announce: 'Morning Arrival opened.' });
  }, [enqueueMutation]);

  const snooze = useCallback(async () => {
    const snoozedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    await enqueueMutation('arrival_snooze', { snoozedUntil }, {
      announce: 'Morning Arrival snoozed for 15 minutes.',
    });
    setView('none');
  }, [enqueueMutation]);

  const skip = useCallback(async () => {
    await enqueueMutation('arrival_skip', {}, { announce: 'Morning Arrival skipped for today.' });
    setView('none');
  }, [enqueueMutation]);

  const bypass = useCallback(async () => {
    await enqueueMutation('arrival_bypass', {}, { announce: 'Continued to Today.' });
    setView('none');
  }, [enqueueMutation]);

  const setOwner = useCallback(async (itemId: string, owner: DayPlanOwner) => {
    markArrivalInteraction();
    await enqueueMutation('item_owner', { itemId, owner }, {
      itemId,
      announce: `Owner changed to ${owner === 'me' ? 'Me' : owner === 'claude' ? 'Claude' : 'Together'}.`,
    });
  }, [enqueueMutation, markArrivalInteraction]);

  const addTask = useCallback(async (taskId: string, title: string) => {
    markArrivalInteraction();
    const result = await enqueueMutation('item_add', { taskId });
    setAnnouncement(`${title} added to today.`);
    return result;
  }, [enqueueMutation, markArrivalInteraction]);

  const reorder = useCallback(async (itemId: string, position: number, title: string) => {
    markArrivalInteraction();
    await enqueueMutation('item_reorder', { itemId, position }, {
      itemId,
      announce: `${title} moved to priority ${position + 1}.`,
    });
  }, [enqueueMutation, markArrivalInteraction]);

  const dismissItem = useCallback(async (itemId: string, title: string) => {
    markArrivalInteraction();
    await enqueueMutation('item_dismiss', { itemId }, {
      itemId,
      announce: `${title} removed from today’s essentials. The task is still in All Work.`,
    });
  }, [enqueueMutation, markArrivalInteraction]);

  const laterItem = useCallback(async (itemId: string, title: string) => {
    markArrivalInteraction();
    await enqueueMutation('item_later', { itemId }, {
      itemId,
      announce: `${title} moved to Not today.`,
    });
  }, [enqueueMutation, markArrivalInteraction]);

  const completeItem = useCallback(async (itemId: string, title: string) => {
    markArrivalInteraction();
    return await enqueueMutation('item_complete', { itemId }, {
      itemId,
      announce: `${title} completed.`,
    });
  }, [enqueueMutation, markArrivalInteraction]);

  const reopenItem = useCallback(async (itemId: string, title: string) => {
    markArrivalInteraction();
    return await enqueueMutation('item_reopen', { itemId }, {
      itemId,
      announce: `${title} restored to Today.`,
    });
  }, [enqueueMutation, markArrivalInteraction]);

  const configureExecution = useCallback(async (
    itemId: string,
    mode: DayPlanExecutionMode,
    modelAlias: DayPlanModelAlias,
    workspaceId?: string,
    budgetUsd?: number,
  ) => {
    const current = planRef.current;
    if (!current) throw new Error('The day plan is not ready.');
    if (current.state !== 'active') {
      const message = 'Start your day before handing work to Claude.';
      setExecutionError(message);
      throw new Error(message);
    }
    setExecutionBusyItemIds((items) => new Set(items).add(itemId));
    setExecutionError(undefined);
    try {
      assertAutonomousSetup(
        mode,
        executionStateRef.current,
        workspaceId,
        budgetUsd,
      );
      const result = await configureDayPlanExecution({
        planId: current.id,
        itemId,
        expectedVersion: current.version,
        mutationId: `configure:${current.id}:${itemId}:${mode}:${modelAlias}:${workspaceId ?? 'none'}:${budgetUsd ?? 'none'}:${current.version}`,
        mode,
        modelAlias,
        workspaceId: mode === 'autonomous' ? workspaceId : undefined,
        budgetUsd: mode === 'autonomous' ? budgetUsd : undefined,
      });
      const previous = executionStateRef.current ?? emptyExecutionState();
      acceptExecutionState({
        ...previous,
        items: [
          ...previous.items.filter((item) => item.itemId !== itemId),
          { itemId, config: result.config, readiness: result.readiness },
        ],
      });
      setAnnouncement(result.readiness.ready
        ? 'Claude execution is ready to queue.'
        : 'Execution mode saved, but the brief still needs attention.');
      return result;
    } catch (nextError) {
      if (nextError instanceof DayPlanApiConflict) acceptPlan(nextError.currentPlan);
      const message = nextError instanceof Error
        ? nextError.message
        : "Cove couldn't save that execution mode.";
      setExecutionError(message);
      throw nextError;
    } finally {
      setExecutionBusyItemIds((items) => {
        const next = new Set(items);
        next.delete(itemId);
        return next;
      });
    }
  }, [acceptExecutionState, acceptPlan]);

  const kickoffExecution = useCallback(async (
    itemId: string,
    mode: DayPlanExecutionMode,
    modelAlias: DayPlanModelAlias,
    workspaceId?: string,
    budgetUsd?: number,
  ) => {
    const current = planRef.current;
    if (!current) throw new Error('The day plan is not ready.');
    if (current.state !== 'active') {
      const message = 'Start your day before handing work to Claude.';
      setExecutionError(message);
      throw new Error(message);
    }
    setExecutionBusyItemIds((items) => new Set(items).add(itemId));
    setExecutionError(undefined);
    try {
      assertAutonomousSetup(
        mode,
        executionStateRef.current,
        workspaceId,
        budgetUsd,
      );
      let itemState = executionStateRef.current?.items.find((item) => item.itemId === itemId);
      const needsConfiguration =
        !itemState?.config ||
        itemState.config.mode !== mode ||
        itemState.config.modelAlias !== modelAlias ||
        (mode === 'autonomous' && itemState.config.workspaceId !== workspaceId) ||
        (mode === 'autonomous' && itemState.config.budgetUsd !== budgetUsd) ||
        itemState.readiness.codes.includes('brief_changed');
      if (needsConfiguration) {
        const configured = await configureDayPlanExecution({
          planId: current.id,
          itemId,
          expectedVersion: current.version,
          mutationId: `configure:${current.id}:${itemId}:${mode}:${modelAlias}:${workspaceId ?? 'none'}:${budgetUsd ?? 'none'}:${current.version}`,
          mode,
          modelAlias,
          workspaceId: mode === 'autonomous' ? workspaceId : undefined,
          budgetUsd: mode === 'autonomous' ? budgetUsd : undefined,
        });
        itemState = { itemId, config: configured.config, readiness: configured.readiness };
        const previous = executionStateRef.current ?? emptyExecutionState();
        acceptExecutionState({
          ...previous,
          items: [...previous.items.filter((item) => item.itemId !== itemId), itemState],
        });
      }
      if (!itemState?.readiness.ready) {
        const owner = current.items.find((item) => item.id === itemId)?.owner ?? 'claude';
        const message = executionReadinessMessage(itemState?.readiness, owner);
        setExecutionError(message);
        setAnnouncement(message);
        return undefined;
      }

      const result = await kickoffDayPlanItem({
        planId: current.id,
        itemId,
        expectedVersion: current.version,
        mutationId: `kickoff:${current.id}:${itemId}:${mode}:${modelAlias}:${workspaceId ?? 'none'}:${budgetUsd ?? 'none'}:${current.version}`,
      });
      acceptPlan(result.plan);
      if (result.run) {
        const previous = executionStateRef.current ?? emptyExecutionState(
          result.worker?.workerAvailable ?? true,
        );
        acceptExecutionState({
          ...previous,
          workerAvailable: result.worker?.workerAvailable ?? previous.workerAvailable,
          runs: [...previous.runs.filter((run) => run.id !== result.run!.id), result.run],
        });
        setAnnouncement('Claude work is queued.');
      } else {
        const message = executionReadinessMessage(
          result.readiness,
          current.items.find((item) => item.id === itemId)?.owner ?? 'claude',
        );
        setExecutionError(message);
        setAnnouncement(message);
      }
      return result.run;
    } catch (nextError) {
      if (nextError instanceof DayPlanApiConflict) acceptPlan(nextError.currentPlan);
      const message = nextError instanceof Error
        ? nextError.message
        : "Cove couldn't queue that task.";
      setExecutionError(message);
      throw nextError;
    } finally {
      setExecutionBusyItemIds((items) => {
        const next = new Set(items);
        next.delete(itemId);
        return next;
      });
    }
  }, [acceptExecutionState, acceptPlan]);

  const cancelExecution = useCallback(async (runId: string) => {
    const run = executionStateRef.current?.runs.find((candidate) => candidate.id === runId);
    if (!run) throw new Error('That Claude run is no longer available.');
    setExecutionBusyItemIds((items) => new Set(items).add(run.itemId));
    setExecutionError(undefined);
    try {
      const result = await cancelDayPlanExecutionRun(runId);
      const previous = executionStateRef.current ?? emptyExecutionState();
      acceptExecutionState({
        ...previous,
        runs: [...previous.runs.filter((candidate) => candidate.id !== runId), result.run],
      });
      setAnnouncement(result.run.status === 'cancelling'
        ? 'Cancellation requested.'
        : 'Claude run cancelled.');
      return result.run;
    } catch (nextError) {
      const message = nextError instanceof Error
        ? nextError.message
        : "Cove couldn't cancel that Claude run.";
      setExecutionError(message);
      throw nextError;
    } finally {
      setExecutionBusyItemIds((items) => {
        const next = new Set(items);
        next.delete(run.itemId);
        return next;
      });
    }
  }, [acceptExecutionState]);

  const startDay = useCallback(async (): Promise<string | undefined> => {
    const current = planRef.current;
    if (!current) throw new Error('The day plan is not ready.');
    setStartDayApplying(true);
    try {
      const result = await enqueueMutation('start_day', {}, {
        mutationId: stableMutationId('start-day', current),
        announce: 'Your day is set.',
      });
      const executionRuns = result.executionRuns ?? [];
      const localFocusItems = localTaskSessionKickoffItems(result.plan.items);
      const sessionLaunches = getRuntimeMode() === 'local'
        ? await Promise.allSettled(
            localFocusItems
              .map((item) => launchTaskSessionRun({
                taskId: item.taskId,
                dayPlanId: result.plan.id,
                itemId: item.id,
                owner: item.owner === 'together' ? 'together' : 'claude',
                promptSnapshot: {
                  title: item.title,
                  detail: item.outcome || item.title,
                  outcome: item.outcome,
                  definitionOfDone: item.definitionOfDone,
                  project: item.project,
                  dueAt: item.dueAt,
                },
              })),
          )
        : [];
      const handedOffCount = getRuntimeMode() === 'local'
        ? sessionLaunches.filter(
            (launch) =>
              launch.status === 'fulfilled' &&
              launch.value.status !== 'failed',
          ).length
        : executionRuns.filter((run) => run.status === 'queued').length;
      const alreadyHandledCount = result.kickoffSkips?.filter(
        (skip) => skip.reason === 'already_live' || skip.reason === 'result_available',
      ).length ?? 0;
      const failedTitles = getRuntimeMode() === 'local'
        ? localFocusItems.flatMap((item, index) => {
            const launch = sessionLaunches[index];
            return !launch || launch.status === 'rejected' || launch.value.status === 'failed'
              ? [item.title]
              : [];
          })
        : result.kickoffSkips?.flatMap((skip) =>
            skip.reason === 'not_ready' ? [skip.title] : []
          ) ?? [];
      const receipt = startDayReceiptCopy(
        handedOffCount,
        alreadyHandledCount,
        failedTitles,
      );
      setAnnouncement(receipt);
      setStartReceipt(receipt);
      if (receiptTimerRef.current !== undefined) window.clearTimeout(receiptTimerRef.current);
      receiptTimerRef.current = window.setTimeout(() => setStartReceipt(undefined), 7000);
      if (executionRuns.length) {
        const previous = executionStateRef.current ?? emptyExecutionState(
          result.worker?.available ?? true,
        );
        acceptExecutionState({
          ...previous,
          workerAvailable: result.worker?.available ?? previous.workerAvailable,
          runs: [
            ...previous.runs.filter(
              (run) => !executionRuns.some((queued) => queued.id === run.id),
            ),
            ...executionRuns,
          ],
        });
      }
      setView('none');
      return result.plan.recommendedFirstTaskId;
    } finally {
      setStartDayApplying(false);
    }
  }, [acceptExecutionState, enqueueMutation]);

  const openSettlement = useCallback(async () => {
    const current = planRef.current;
    if (!current) throw new Error('There is no day plan to settle.');
    if (current.state === 'settled') throw new Error('Today is already closed.');
    await enqueueMutation('settlement_start', {}, {
      mutationId: stableMutationId('settlement-start', current),
      announce: 'Closing your day opened.',
    });
  }, [enqueueMutation]);

  const cancelSettlement = useCallback(async () => {
    const current = planRef.current;
    let saved = true;
    if (current?.state === 'settling' && current.settlementState === 'in_progress') {
      try {
        await enqueueMutation('settlement_cancel', {}, {
          mutationId: stableMutationId('settlement-cancel', current),
          announce: 'Closing your day was left open for later.',
        });
      } catch {
        saved = false;
      } finally {
        setView('none');
      }
    } else {
      setView('none');
    }
    if (saved) setAnnouncement('Closing your day was left open for later.');
  }, [enqueueMutation]);

  const decideSettlement = useCallback(async (
    itemId: string,
    disposition: SettlementDisposition,
    progress?: { progressNote?: string; nextStep?: string },
  ) => {
    const deferUntil = disposition === 'defer'
      ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      : undefined;
    await enqueueMutation('settlement_decide', {
      itemId,
      disposition,
      deferUntil,
      ...(disposition === 'progress' ? progress : {}),
    }, {
      itemId,
      announce: `Closing choice saved: ${disposition}.`,
    });
  }, [enqueueMutation]);

  const commitSettlement = useCallback(async (
    completedHumanTaskIds: string[],
    nextDayNote?: string,
  ): Promise<DayPlanMutationResult> => {
    const current = planRef.current;
    if (!current) throw new Error('The day plan is not ready.');
    const result = await enqueueMutation(
      'settlement_commit',
      { completedHumanTaskIds, nextDayNote },
      {
        mutationId: onceOnlyDayPlanMutationId('settlement-commit', current.id),
        announce: 'The day is closed.',
      },
    );
    if (nextDayNote?.trim()) {
      const receipt = "Got it. I'll have your notes processed into tomorrow's brief.";
      setAnnouncement(receipt);
      setSettlementReceipt(receipt);
      if (receiptTimerRef.current !== undefined) window.clearTimeout(receiptTimerRef.current);
      receiptTimerRef.current = window.setTimeout(() => setSettlementReceipt(undefined), 7000);
    }
    setView('none');
    return result;
  }, [enqueueMutation]);

  const openCurrentDayAfterSettlement = useCallback(async (
    settledLocalDate: string,
    excludedTaskIds: ReadonlySet<string> = new Set(),
  ) => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const localDate = localDateInTimezone(new Date(), timezone);
    if (settledLocalDate === localDate) return;
    if (!candidatesReady && !isWeekendLocalDate(localDate)) {
      throw new Error('Cove needs a fresh task refresh before it can prepare today.');
    }
    const readModel = await getDayPlanState();
    // The post-settlement refetch carries the fresh projection; acceptPlan
    // below reconciles it against the plan that ends up current.
    applyMorningBrief(readModel.morningBrief);
    setBriefGeneration(readModel.briefGeneration);
    let nextPlan = readModel.currentPlan;
    if (!nextPlan) {
      const ensured = await ensureDayPlan({
        localDate,
        timezone,
        mutationId: onceOnlyDayPlanMutationId('ensure', localDate),
        candidates: candidatesReady
          ? candidatesRef.current.filter(
              (candidate) => !excludedTaskIds.has(candidate.taskId),
            )
          : [],
        creation: 'automatic',
      });
      if ('weekendGate' in ensured) {
        setWeekendGate(ensured.weekendGate);
        reconciliationBlockedRef.current = false;
        setAnnouncement('The previous day is closed.');
        return;
      }
      nextPlan = ensured.plan;
    }
    if (
      nextPlan.localDate === localDate &&
      nextPlan.state === 'proposed' &&
      ['due', 'not_due', 'failed'].includes(nextPlan.arrivalState)
    ) {
      nextPlan = (await mutateDayPlan({
        planId: nextPlan.id,
        mutationId: stableMutationId('arrival-open', nextPlan),
        expectedVersion: nextPlan.version,
        action: 'arrival_open',
      })).plan;
    }
    acceptPlan(nextPlan, readModel.latestSnapshot);
    reconciliationBlockedRef.current = false;
    setAnnouncement('The previous day is closed. Morning Arrival is ready.');
  }, [acceptPlan, applyMorningBrief, candidatesReady]);

  const planWeekendAnyway = useCallback(async () => {
    const gate = weekendGate;
    if (!gate || planningWeekend) return;
    setPlanningWeekend(true);
    setError(undefined);
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const ensured = await ensureDayPlan({
        localDate: gate.localDate,
        timezone,
        mutationId: onceOnlyDayPlanMutationId('ensure', gate.localDate),
        candidates: candidatesReady ? candidatesRef.current : [],
        creation: 'manual',
      });
      if ('weekendGate' in ensured) {
        throw new Error("Cove couldn't open the weekend plan.");
      }
      let nextPlan = ensured.plan;
      if (
        nextPlan.state === 'proposed' &&
        ['due', 'not_due', 'failed'].includes(nextPlan.arrivalState)
      ) {
        nextPlan = (await mutateDayPlan({
          planId: nextPlan.id,
          mutationId: stableMutationId('arrival-open', nextPlan),
          expectedVersion: nextPlan.version,
          action: 'arrival_open',
        })).plan;
      }
      setWeekendGate(undefined);
      acceptPlan(nextPlan, ensured.snapshot);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Cove couldn't open the weekend plan.",
      );
    } finally {
      setPlanningWeekend(false);
    }
  }, [acceptPlan, candidatesReady, planningWeekend, weekendGate]);

  // "Write it anyway." Queues a brief the gate is withholding, or re-runs one
  // after a failure. The optimistic 'queued' means the progress UI appears on the
  // tap instead of up to 15 seconds later when the poll catches up; the poll then
  // replaces it with the real row.
  const forceBrief = useCallback(async () => {
    const current = planRef.current;
    if (!current) return;
    setForcingBrief(true);
    setBriefGeneration({ state: 'queued' });
    try {
      const result = await forceMorningBrief(current.localDate);
      // Unconditional, including undefined: the server declining to start one
      // (it attached an existing brief, or the other machine is already writing)
      // must clear the optimistic 'queued' rather than leave a progress bar
      // counting down against nothing.
      setBriefGeneration(result.briefGeneration);
      // The server attached a brief that was already written but held out by the
      // no-hot-swap guard. The late-brief poll is already closed by then (it
      // stops at the first interaction), so this refetch is the only thing that
      // puts the brief on screen.
      if (result.attached) await refreshPlan().catch(() => undefined);
    } catch (nextError) {
      setBriefGeneration(undefined);
      setError(
        nextError instanceof Error ? nextError.message : "Cove couldn't start the brief.",
      );
    } finally {
      setForcingBrief(false);
    }
  }, [refreshPlan]);

  const acknowledgeReconciliation = useCallback(async (reconciliationId: string) => {
    await acknowledgeDayPlanReconciliation(reconciliationId);
    setPendingReconciliations((current) =>
      current.filter((reconciliation) => reconciliation.id !== reconciliationId),
    );
  }, []);

  const acknowledgeTaskMutation = useCallback(async (mutationId: string) => {
    await acknowledgeDayPlanTaskMutation(mutationId);
    setPendingTaskMutations((current) => current.filter((mutation) => mutation.id !== mutationId));
  }, []);

  return {
    plan,
    morningBrief,
    briefGeneration,
    briefAttachTimedOut,
    weekendGate,
    planningWeekend,
    planWeekendAnyway,
    arrivalInteracted: arrivalInteracted || Boolean(plan?.arrivalInteractedAt),
    forceBrief,
    forcingBrief,
    latestSnapshot,
    pendingReconciliations,
    pendingTaskMutations,
    view,
    busy,
    savingItemIds,
    error,
    announcement,
    startReceipt,
    settlementReceipt,
    startDayApplying,
    executionState,
    executionLoading,
    executionBusyItemIds,
    executionError,
    ritualOpen:
      view === 'arrival' ||
      view === 'settlement',
    openArrival,
    markArrivalInteraction,
    snooze,
    skip,
    bypass,
    addTask,
    setOwner,
    reorder,
    dismissItem,
    laterItem,
    completeItem,
    reopenItem,
    configureExecution,
    kickoffExecution,
    cancelExecution,
    refreshExecution,
    startDay,
    openSettlement,
    cancelSettlement,
    decideSettlement,
    commitSettlement,
    openCurrentDayAfterSettlement,
    acknowledgeReconciliation,
    acknowledgeTaskMutation,
  };
}
