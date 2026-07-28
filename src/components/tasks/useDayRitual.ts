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
  getDayPlanExecutionState,
  getDayPlanState,
  kickoffDayPlanItem,
  markDayPlanArrivalInteraction,
  markMorningBriefSalesAction,
  mutateDayPlan,
  newDayPlanMutationId,
  onceOnlyDayPlanMutationId,
  type DayPlanExecutionState,
} from '@/lib/data/day-plan';
import type {
  MorningBriefGeneration,
  MorningBriefSalesActionState,
  MorningBriefSuggestedAddition,
  PublicMorningBrief,
} from '@/lib/day-plan/brief';
import { morningBriefSyncDecision } from '@/lib/day-plan/brief-view';
import { useDataChanged } from '@/lib/data/refresh-bus';
import { matchesArrivalAddition } from '@/lib/day-plan/arrival-addition';
import type {
  DayPlan,
  DayPlanExecutionMode,
  DayPlanModelAlias,
  DayPlanMutationAction,
  DayPlanMutationInput,
  DayPlanMutationResult,
  DayPlanOwner,
  DayPlanReconciliation,
  DayPlanTaskMutation,
  DaySnapshot,
  RecommendationCandidate,
  SettlementDisposition,
} from '@/lib/day-plan/types';
import {
  executionReadinessMessage,
  shouldAttemptLateBriefAttach,
  shouldPollBriefGeneration,
  startDayReceiptCopy,
} from '@/lib/day-plan/presentation';

// While the arrival is open with no brief and one is still being written, re-poll
// the read model at this cadence to pick the brief up the moment it lands.
const BRIEF_GENERATION_POLL_MS = 15_000;

export type DayRitualView =
  | 'checking'
  | 'none'
  | 'arrival'
  | 'settlement';

type UseDayRitualInput = {
  enabled: boolean;
  candidates: RecommendationCandidate[];
  candidatesReady: boolean;
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
}: UseDayRitualInput) {
  const [plan, setPlan] = useState<DayPlan>();
  const [morningBrief, setMorningBrief] = useState<PublicMorningBrief>();
  const [briefGeneration, setBriefGeneration] = useState<MorningBriefGeneration>();
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

  candidatesRef.current = candidates;

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

  // Keep the ref current for paths that update brief state functionally
  // (optimistic sales-action marks); acceptPlan reads it synchronously.
  useEffect(() => {
    morningBriefRef.current = morningBrief;
  }, [morningBrief]);

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
          if (!candidatesReady) {
            setView('none');
            setError('Cove needs a fresh task refresh before it can propose today’s plan.');
            return;
          }
          const ensured = await ensureDayPlan({
            localDate,
            timezone,
            mutationId: onceOnlyDayPlanMutationId('ensure', localDate),
            candidates: candidatesRef.current,
          });
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
            throw new Error('Cove could not prepare the previous workday for Settlement.');
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
            : "Cove couldn't load the morning ritual. Living Current is still available.",
        );
      }
    }

    void initialize();
    return () => {
      cancelled = true;
    };
  }, [acceptPlan, applyMorningBrief, candidatesReady, enabled]);

  useEffect(() => {
    if (!enabled || !plan?.id) return;
    void refreshExecution(plan.id).catch(() => undefined);
  }, [enabled, plan?.id, plan?.version, refreshExecution]);

  useEffect(() => {
    if (!executionState?.runs.some((run) => ACTIVE_EXECUTION_STATES.has(run.status))) return;
    let cancelled = false;
    let timeout: number | undefined;

    async function poll() {
      try {
        await refreshExecution(planRef.current?.id);
      } catch {
        if (!cancelled) timeout = window.setTimeout(() => void poll(), 2000);
      }
    }

    timeout = window.setTimeout(() => void poll(), 1500);
    return () => {
      cancelled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [executionState, refreshExecution]);

  // One poll/heal step. When the arrival has no brief or no items, it re-ensures
  // with fresh candidates: the store can attach a synced brief and/or rebuild
  // the empty proposal. A plain GET could only re-deliver the same artifact.
  // Falls back to a GET refresh when candidates are not fresh enough.
  const pollForLateBrief = useCallback(async () => {
    const current = planRef.current;
    const candidates = candidatesRef.current;
    const hasFreshCandidates = candidatesReady && candidates.length > 0;
    if (
      current &&
      (!current.briefId || current.items.length === 0) &&
      hasFreshCandidates
    ) {
      try {
        const ensured = await ensureDayPlan({
          localDate: current.localDate,
          timezone: current.timezone,
          mutationId: `ensure:late-brief:${current.id}:${newDayPlanMutationId()}`,
          candidates,
          // Attach-or-silent-no-op: the server records nothing unless a brief
          // actually attaches, so this 15s poll never grows the event ledger.
          attachOnly: true,
        });
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
  }, [acceptPlan, applyMorningBrief, candidatesReady, refreshPlan]);

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
        interacted: arrivalInteractedRef.current,
        hasConsumedBrief: Boolean(planRef.current?.briefId),
        generationState: briefGeneration?.state,
      });
    if (!gateOpen()) return;

    let cancelled = false;
    let timeout: number | undefined;

    const tick = async () => {
      if (cancelled) return;
      // Skip the fetch while hidden or interacted, but keep the timer so polling
      // resumes on its own when the document becomes visible again.
      if (
        (typeof document === 'undefined' || document.visibilityState === 'visible') &&
        !arrivalInteractedRef.current
      ) {
        // Re-ensure so the server imports + late-attaches a synced brief;
        // acceptPlan applies the sync decision, so it swaps in here.
        await pollForLateBrief();
      }
      if (!cancelled) timeout = window.setTimeout(() => void tick(), BRIEF_GENERATION_POLL_MS);
    };

    timeout = window.setTimeout(() => void tick(), BRIEF_GENERATION_POLL_MS);
    return () => {
      cancelled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [enabled, view, arrivalInteracted, briefGeneration?.state, plan?.briefId, pollForLateBrief]);

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
    await enqueueMutation('arrival_bypass', {}, { announce: 'Entered Living Current.' });
    setView('none');
  }, [enqueueMutation]);

  const setOwner = useCallback(async (itemId: string, owner: DayPlanOwner) => {
    markArrivalInteraction();
    await enqueueMutation('item_owner', { itemId, owner }, {
      itemId,
      announce: `Owner changed to ${owner === 'me' ? 'Me' : owner === 'claude' ? 'Claude' : 'Together'}.`,
    });
  }, [enqueueMutation, markArrivalInteraction]);

  const addItem = useCallback(async (
    addition: MorningBriefSuggestedAddition,
    owner: DayPlanOwner,
  ): Promise<DayPlanMutationResult> => {
    const existingItemIds = new Set(planRef.current?.items.map((item) => item.id) ?? []);
    markArrivalInteraction();
    const result = await enqueueMutation('item_add', {
      title: addition.title,
      outcome: addition.outcome,
      why: addition.why,
      owner,
    });
    const added = result.plan.items.some(
      (item) =>
        !existingItemIds.has(item.id) &&
        matchesArrivalAddition(item, addition) &&
        item.sourceRefs.some((source) => source.sourceType === 'decision') &&
        item.rankReasons.includes('accepted_today'),
    );
    if (!added) {
      const message = "Cove couldn't confirm that the addition reached today's plan.";
      setError(message);
      throw new Error(message);
    }
    setAnnouncement(`${addition.title} added to today.`);
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
      const handedOffCount = executionRuns.filter((run) => run.status === 'queued').length;
      const alreadyHandledCount = result.kickoffSkips?.filter(
        (skip) => skip.reason === 'already_live' || skip.reason === 'result_available',
      ).length ?? 0;
      const receipt = startDayReceiptCopy(handedOffCount, alreadyHandledCount);
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
      announce: 'Day Settlement opened.',
    });
  }, [enqueueMutation]);

  const cancelSettlement = useCallback(() => {
    setView('none');
    setAnnouncement('Day Settlement left open for later.');
  }, []);

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
      announce: `Settlement decision saved: ${disposition}.`,
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
    if (!candidatesReady) {
      throw new Error('Cove needs a fresh task refresh before it can prepare today.');
    }
    const readModel = await getDayPlanState();
    // The post-settlement refetch carries the fresh projection; acceptPlan
    // below reconciles it against the plan that ends up current.
    applyMorningBrief(readModel.morningBrief);
    setBriefGeneration(readModel.briefGeneration);
    let nextPlan = readModel.currentPlan;
    if (!nextPlan) {
      nextPlan = (await ensureDayPlan({
        localDate,
        timezone,
        mutationId: onceOnlyDayPlanMutationId('ensure', localDate),
        candidates: candidatesRef.current.filter(
          (candidate) => !excludedTaskIds.has(candidate.taskId),
        ),
      })).plan;
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

  // Marks one brief sales action approved, edited, or skipped. State only;
  // Cove never sends anything. Optimistic, reconciled from the server reply.
  const markBriefSalesAction = useCallback(async (
    actionIndex: number,
    state: MorningBriefSalesActionState,
    editedText?: string,
  ) => {
    const current = morningBrief;
    if (!current) return;
    setMorningBrief({
      ...current,
      salesActions: current.salesActions.map((action, index) =>
        index === actionIndex ? { ...action, state, editedText } : action,
      ),
    });
    try {
      const result = await markMorningBriefSalesAction({
        briefId: current.id,
        actionIndex,
        state,
        editedText,
      });
      setMorningBrief((latest) => {
        if (!latest || latest.id !== current.id) return latest;
        const byIndex = new Map(result.states.map((record) => [record.actionIndex, record]));
        return {
          ...latest,
          salesActions: latest.salesActions.map((action, index) => {
            const record = byIndex.get(index);
            return { ...action, state: record?.state, editedText: record?.editedText };
          }),
        };
      });
    } catch (nextError) {
      // Roll back the optimistic mark, but only when the held brief is still
      // the one we marked: a plan transition mid-flight may have cleared or
      // replaced it, and restoring the old brief would break the briefId key.
      setMorningBrief((latest) =>
        latest && latest.id === current.id ? current : latest,
      );
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Cove couldn't save that sales action.",
      );
    }
  }, [morningBrief]);

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
    addItem,
    setOwner,
    reorder,
    dismissItem,
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
    markBriefSalesAction,
  };
}
