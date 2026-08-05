'use client';

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useBuddy, useBuddyStream } from '@/components/buddy/BuddyProvider';
import type { MorningBriefGeneration, PublicMorningBrief } from '@/lib/day-plan/brief';
import type { DayPlan, DayPlanItem, DayPlanOwner as DayOwner } from '@/lib/day-plan/types';
import {
  arrivalDateLabel,
  focusBandItems,
  isMorningBriefWriting,
  morningArrivalGreeting,
} from '@/lib/day-plan/presentation';
import ArrivalStepBrief from './arrival/ArrivalStepBrief';
import ArrivalPlanGrid from './arrival/ArrivalPlanGrid';
import type { OwnerChipEscapeHandler } from './arrival/OwnerChip';
import StepDots, { morningArrivalSteps, type ArrivalStep } from './arrival/StepDots';

export type MorningArrivalItem = {
  item: DayPlanItem;
  title: string;
  summary?: string;
  description?: string;
  whyToday: string;
  definitionOfDone?: string;
  project?: string;
  deadline?: string;
};

export type MorningArrivalBoardTask = {
  id: string;
  title: string;
  description?: string;
  project?: string;
  due?: string;
};

interface MorningArrivalProps {
  plan: DayPlan;
  items: MorningArrivalItem[];
  notTodayTasks: MorningArrivalBoardTask[];
  recommendation: string;
  brief?: PublicMorningBrief;
  briefGeneration?: MorningBriefGeneration;
  briefAttachTimedOut: boolean;
  arrivalInteracted: boolean;
  recap?: string;
  freshnessLabel?: string;
  busy?: boolean;
  error?: string;
  titleId: string;
  descriptionId: string;
  escapeRef?: RefObject<(() => void) | null>;
  onPlanCanvasChange?: (active: boolean) => void;
  onInteract?: () => void;
  onOwnerChange: (itemId: string, owner: DayOwner) => void | Promise<void>;
  onDragReorder: (activeId: string, overId: string) => void | Promise<void>;
  onRemove: (itemId: string, title: string, taskBacked: boolean) => void | Promise<void>;
  onComplete: (itemId: string, title: string) => void | Promise<void>;
  onAddTask: (taskId: string, title: string) => void | Promise<void>;
  onSnooze: () => void | Promise<void>;
  onSkip: () => void | Promise<void>;
  onBypass: () => void | Promise<void>;
  onStartDay: () => void | Promise<void>;
  onOpenAllWork?: () => void;
  onForceBrief?: () => void;
  forcingBrief?: boolean;
}

const STEP_TITLES: Record<Exclude<ArrivalStep, 'brief'>, string> = {
  plan: 'Plan your day',
};

const STEP_DESCRIPTIONS: Record<ArrivalStep, string> = {
  brief: '',
  plan: 'Build the whole day here. The first three tasks are your focus.',
};

const STEP_ANNOUNCEMENTS: Record<ArrivalStep, string> = {
  brief: 'the brief',
  plan: 'plan your day',
};

export default function MorningArrival({
  plan,
  items,
  notTodayTasks,
  recommendation,
  brief,
  briefGeneration,
  briefAttachTimedOut,
  arrivalInteracted,
  recap,
  freshnessLabel,
  busy = false,
  error,
  titleId,
  descriptionId,
  escapeRef,
  onPlanCanvasChange,
  onInteract,
  onOwnerChange,
  onDragReorder,
  onRemove,
  onComplete,
  onAddTask,
  onSnooze,
  onSkip,
  onBypass,
  onStartDay,
  onOpenAllWork,
  onForceBrief,
  forcingBrief,
}: MorningArrivalProps) {
  const { setPageContext, busy: buddyBusy } = useBuddy();
  const { streamingTurn } = useBuddyStream();
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const ownerChipEscapeRef = useRef<OwnerChipEscapeHandler | null>(null);
  const availableSteps = morningArrivalSteps();
  const [step, setStep] = useState<ArrivalStep>('brief');
  const [stepAnnouncement, setStepAnnouncement] = useState('');
  const previousStepRef = useRef(step);
  const briefWriting = isMorningBriefWriting({
    briefAttached: Boolean(plan.briefId),
    arrivalInteracted,
    attachTimedOut: briefAttachTimedOut,
    generationState: briefGeneration?.state,
  });
  const visibleItems = [...items]
    .filter(
      (view) =>
        view.item.decision === 'pending' ||
        view.item.decision === 'preselected' ||
        view.item.decision === 'accepted',
    )
    .sort((left, right) => left.item.position - right.item.position);
  const focusAgentCount = focusBandItems(visibleItems.map((view) => view.item))
    .filter((item) => item.owner === 'claude' || item.owner === 'together')
    .length;
  const buddyActive = buddyBusy || Boolean(streamingTurn);
  const currentStepIndex = availableSteps.indexOf(step);
  const isFinalStep = step === 'plan';

  useLayoutEffect(() => {
    onPlanCanvasChange?.(step === 'plan');
    return () => onPlanCanvasChange?.(false);
  }, [onPlanCanvasChange, step]);

  useEffect(() => {
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
  }, [step]);

  useEffect(() => {
    if (previousStepRef.current === step) return;
    previousStepRef.current = step;
    const focusFrame = window.requestAnimationFrame(() => {
      document.getElementById(titleId)?.focus();
      setStepAnnouncement(
        `Step ${currentStepIndex + 1} of ${availableSteps.length}: ${STEP_ANNOUNCEMENTS[step]}`,
      );
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [availableSteps.length, currentStepIndex, step, titleId]);

  useEffect(() => {
    setPageContext({
      view: 'morning-arrival',
      step,
      planId: plan.id,
      planVersion: plan.version,
    });
  }, [plan.id, plan.version, setPageContext, step]);

  useEffect(() => () => setPageContext({ view: 'tasks' }), [setPageContext]);

  function handleOwnerChipOpen(handler: OwnerChipEscapeHandler) {
    onInteract?.();
    if (ownerChipEscapeRef.current?.itemId !== handler.itemId) {
      ownerChipEscapeRef.current?.closeAndFocus();
    }
    ownerChipEscapeRef.current = handler;
  }

  function handleOwnerChipClose(itemId: string) {
    if (ownerChipEscapeRef.current?.itemId === itemId) ownerChipEscapeRef.current = null;
  }

  useEffect(() => {
    if (!escapeRef) return;
    escapeRef.current = () => ownerChipEscapeRef.current?.closeAndFocus();
    return () => {
      escapeRef.current = null;
    };
  }, [escapeRef]);

  function changeStep(nextStep: ArrivalStep) {
    ownerChipEscapeRef.current?.closeAndFocus();
    onInteract?.();
    setStep(nextStep);
  }

  return (
    <div
      className={`mx-auto my-auto w-full overflow-hidden rounded-3xl border bg-background shadow-2xl ${
        step === 'brief' ? 'max-w-[80rem]' : 'max-w-none'
      }`}
      data-day-plan-id={plan.id}
    >
      <div ref={scrollContainerRef} className="max-h-[calc(100dvh-7rem)] overflow-y-auto">
        {step === 'brief' ? (
          <header className="sticky top-0 z-20 border-b bg-background/95 py-5 backdrop-blur">
            <div className="mx-auto w-full max-w-[76rem] px-6 sm:px-10">
              <div className="flex items-center justify-between gap-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Morning arrival
                </p>
                <StepDots steps={availableSteps} activeStep={step} />
              </div>
              <div className="mx-auto w-full max-w-[70ch]">
                <h1
                  id={titleId}
                  tabIndex={-1}
                  className="mt-3 text-2xl font-semibold tracking-tight text-foreground outline-none sm:text-3xl"
                >
                  {morningArrivalGreeting(new Date(), plan.timezone)}
                </h1>
                <p id={descriptionId} className="arrival-brief-kicker mt-2.5">
                  {arrivalDateLabel(plan.localDate)}
                </p>
                {freshnessLabel && <p className="mt-2 text-xs text-muted-foreground">{freshnessLabel}</p>}
              </div>
              <p className="sr-only" aria-live="polite" aria-atomic="true">{stepAnnouncement}</p>
            </div>
          </header>
        ) : (
          <header className="sticky top-0 z-20 border-b bg-background/95 py-3 backdrop-blur">
            <div className="flex w-full items-center justify-between gap-5 px-4 sm:px-5">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  Morning arrival
                </p>
                <h1
                  id={titleId}
                  tabIndex={-1}
                  className="text-2xl font-semibold tracking-tight text-foreground outline-none"
                >
                  {STEP_TITLES[step]}
                </h1>
                {freshnessLabel && <p className="text-xs text-muted-foreground">{freshnessLabel}</p>}
                <p id={descriptionId} className="sr-only">{STEP_DESCRIPTIONS[step]}</p>
              </div>
              <StepDots steps={availableSteps} activeStep={step} />
              <p className="sr-only" aria-live="polite" aria-atomic="true">{stepAnnouncement}</p>
            </div>
          </header>
        )}

        {error && (
          <div className={step === 'brief'
            ? 'mx-auto w-full max-w-[76rem] px-6 pt-5 sm:px-10'
            : 'w-full px-[29px] pt-5 sm:px-[33px]'}>
            <p role="alert" className="rounded-xl border border-accent-red/30 bg-accent-red/5 p-3 text-sm text-accent-red">
              {error}
            </p>
          </div>
        )}

        <div key={step} className="day-ritual-swap-in pb-24 sm:pb-0">
          {step === 'brief' ? (
            <ArrivalStepBrief
              recap={recap}
              headline={brief?.headline}
              paragraphs={brief
                ? [
                    ...brief.narrativeParagraphs,
                    ...(brief.managementSummary ? [brief.managementSummary] : []),
                  ]
                : recommendation ? [recommendation] : []}
              watchItems={brief?.watchItems ?? []}
              briefWriting={briefWriting}
              briefGeneration={briefGeneration}
              briefAttached={Boolean(plan.briefId)}
              hasBriefContent={Boolean(brief)}
              onForceBrief={onForceBrief}
              forcingBrief={forcingBrief}
            />
          ) : (
            <ArrivalPlanGrid
              todayItems={visibleItems}
              notTodayTasks={notTodayTasks}
              busy={busy}
              onInteract={onInteract}
              onOwnerChange={onOwnerChange}
              onDragReorder={onDragReorder}
              onRemove={onRemove}
              onComplete={onComplete}
              onAddTask={onAddTask}
              onOpenAllWork={onOpenAllWork}
              onOwnerChipOpen={handleOwnerChipOpen}
              onOwnerChipClose={handleOwnerChipClose}
            />
          )}
        </div>

        <footer className="sticky bottom-0 z-20 border-t !bg-background">
          <div className={step === 'brief'
            ? 'mx-auto flex w-full max-w-[76rem] flex-col items-stretch gap-2 py-3 pl-4 pr-20 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3 sm:py-4 sm:pl-10 sm:pr-24 min-[1120px]:pr-10'
            : 'mx-auto flex w-full max-w-none flex-col items-stretch gap-2 py-3 pl-[29px] pr-20 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3 sm:py-4 sm:pl-[33px] sm:pr-24 min-[1120px]:pr-[33px]'}>
            <div className="flex w-full flex-wrap items-center justify-center gap-x-3 sm:w-auto sm:justify-start sm:gap-x-4 sm:gap-y-1">
              {currentStepIndex > 0 && (
                <button
                  type="button"
                  className="press-scale min-h-8 text-xs text-muted-foreground hover:underline hover:underline-offset-2"
                  onClick={() => changeStep(availableSteps[currentStepIndex - 1])}
                >
                  Back
                </button>
              )}
              <button type="button" disabled={busy} className="press-scale min-h-8 text-xs text-muted-foreground hover:underline disabled:opacity-50" onClick={() => void onSnooze()}>
                Snooze 15 minutes
              </button>
              <button type="button" disabled={busy} className="press-scale min-h-8 text-xs text-muted-foreground hover:underline disabled:opacity-50" onClick={() => void onSkip()}>
                Skip today
              </button>
              <button type="button" disabled={busy} className="press-scale min-h-8 text-xs text-muted-foreground hover:underline disabled:opacity-50" onClick={() => void onBypass()}>
                Continue to Today
              </button>
            </div>

            <div className="sm:ml-auto">
              {isFinalStep && focusAgentCount > 0 && (
                <p className="mb-1 text-center text-xs text-muted-foreground sm:text-right">
                  Claude will start {focusAgentCount} focus {focusAgentCount === 1 ? 'task' : 'tasks'}.
                </p>
              )}
              <button
                type="button"
                data-ritual-primary={isFinalStep ? '' : undefined}
                disabled={isFinalStep && (busy || buddyActive || visibleItems.length === 0)}
                className={`press-scale min-h-11 w-full rounded-xl px-5 text-sm font-semibold disabled:opacity-40 sm:w-auto ${
                  isFinalStep
                    ? 'bg-foreground text-background hover:opacity-90'
                    : 'border text-foreground hover:bg-muted'
                }`}
                onClick={() => {
                  if (isFinalStep) void onStartDay();
                  else changeStep(availableSteps[currentStepIndex + 1]);
                }}
              >
                {isFinalStep ? (busy ? 'Setting your day…' : 'Start my day') : 'Continue'}
              </button>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}

export type { MorningArrivalProps };
