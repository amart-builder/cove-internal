'use client';

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useBuddy, useBuddyStream } from '@/components/buddy/BuddyProvider';
import type { MorningBriefGeneration, PublicMorningBrief } from '@/lib/day-plan/brief';
import type {
  DayPlan,
  DayPlanItem,
  DayPlanMutationResult,
  DayPlanOwner as DayOwner,
} from '@/lib/day-plan/types';
import {
  arrivalDateLabel,
  focusBandItems,
  isMorningBriefWriting,
  morningArrivalGreeting,
} from '@/lib/day-plan/presentation';
import ArrivalStepBrief from './arrival/ArrivalStepBrief';
import ArrivalPlanGrid from './arrival/ArrivalPlanGrid';
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
  focusCount: 1 | 2 | 3;
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
  completingTaskId?: string | null;
  error?: string;
  titleId: string;
  descriptionId: string;
  escapeRef?: RefObject<(() => void) | null>;
  onPlanCanvasChange?: (active: boolean) => void;
  onInteract?: () => void;
  onOwnerChange: (itemId: string, owner: DayOwner) => void | Promise<void>;
  onMoveToPosition: (itemId: string, position: number, title: string) => void | Promise<void>;
  onFocusCountChange: (count: 1 | 2 | 3) => void | Promise<void>;
  onRemove: (itemId: string, title: string, taskBacked: boolean) => void | Promise<void>;
  onComplete: (itemId: string, title: string) => void | Promise<void>;
  onCompleteBoardTask: (taskId: string, title: string) => void | Promise<void>;
  onAddTask: (
    taskId: string,
    title: string,
  ) => DayPlanMutationResult | void | Promise<DayPlanMutationResult | void>;
  onSnooze: () => void | Promise<void>;
  onBypass: () => void | Promise<void>;
  onStartDay: () => void | Promise<void>;
  onForceBrief?: () => void;
  forcingBrief?: boolean;
}

const STEP_TITLES: Record<Exclude<ArrivalStep, 'brief'>, string> = {
  plan: 'Plan your day',
};

const STEP_DESCRIPTIONS: Record<ArrivalStep, string> = {
  brief: '',
  plan: 'Build the whole day here.',
};

const STEP_ANNOUNCEMENTS: Record<ArrivalStep, string> = {
  brief: 'the brief',
  plan: 'plan your day',
};

export default function MorningArrival({
  plan,
  focusCount,
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
  completingTaskId,
  error,
  titleId,
  descriptionId,
  escapeRef,
  onPlanCanvasChange,
  onInteract,
  onOwnerChange,
  onMoveToPosition,
  onFocusCountChange,
  onRemove,
  onComplete,
  onCompleteBoardTask,
  onAddTask,
  onSnooze,
  onBypass,
  onStartDay,
  onForceBrief,
  forcingBrief,
}: MorningArrivalProps) {
  const { setPageContext, busy: buddyBusy } = useBuddy();
  const { streamingTurn } = useBuddyStream();
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
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
  const focusAgentCount = focusBandItems(
    visibleItems.map((view) => view.item),
    focusCount,
  )
    .filter((item) => item.owner === 'claude' || item.owner === 'together')
    .length;
  const buddyActive = buddyBusy || Boolean(streamingTurn);
  const currentStepIndex = availableSteps.indexOf(step);
  const isFinalStep = step === 'plan';

  useLayoutEffect(() => {
    onPlanCanvasChange?.(true);
    return () => onPlanCanvasChange?.(false);
  }, [onPlanCanvasChange]);

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

  useEffect(() => {
    if (step === 'brief' && escapeRef) escapeRef.current = null;
  }, [escapeRef, step]);

  function changeStep(nextStep: ArrivalStep) {
    onInteract?.();
    setStep(nextStep);
  }

  const title = step === 'brief'
    ? morningArrivalGreeting(new Date(), plan.timezone)
    : STEP_TITLES[step];

  return (
    <div
      className="mx-auto my-auto flex max-h-full min-h-0 w-full max-w-[63rem] flex-col overflow-hidden rounded-3xl border bg-card"
      data-day-plan-id={plan.id}
      data-arrival-shell
    >
      <div ref={scrollContainerRef} className="min-h-0 overflow-y-auto">
        <header className="bg-card px-6 pt-8 sm:px-10 lg:px-16 lg:pt-[52px]">
          <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-4">
            <div className="min-w-0">
              <p className="mb-2.5 text-[10.5px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
                Morning arrival
              </p>
              <h1
                id={titleId}
                tabIndex={-1}
                className="text-[30px] font-semibold leading-[1.15] tracking-[-0.022em] text-foreground outline-none"
              >
                {title}
              </h1>
            </div>
            <div className="flex items-center gap-3.5 text-xs text-muted-foreground" title={freshnessLabel}>
              <span>{arrivalDateLabel(plan.localDate)}</span>
              <StepDots steps={availableSteps} activeStep={step} />
            </div>
          </div>
          <p id={descriptionId} className="sr-only">
            {STEP_DESCRIPTIONS[step]}{' '}
            {step === 'plan'
              ? `The first ${focusCount} ${focusCount === 1 ? 'task is' : 'tasks are'} your initial ${focusCount === 1 ? 'priority' : 'priorities'}. `
              : ''}
            {freshnessLabel}
          </p>
          <p className="sr-only" aria-live="polite" aria-atomic="true">{stepAnnouncement}</p>
        </header>

        {error && (
          <div className="px-6 pt-5 sm:px-10 lg:px-16">
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
              focusCount={focusCount}
              busy={busy}
              completingTaskId={completingTaskId}
              onInteract={onInteract}
              onOwnerChange={onOwnerChange}
              onMoveToPosition={onMoveToPosition}
              onFocusCountChange={onFocusCountChange}
              onRemove={onRemove}
              onComplete={onComplete}
              onCompleteBoardTask={onCompleteBoardTask}
              onAddTask={onAddTask}
              escapeRef={escapeRef}
            />
          )}
        </div>

        <footer className="sticky bottom-0 z-20 mt-12 border-t bg-card px-6 pb-6 pt-5 sm:px-10 lg:px-16">
          <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <div className="flex w-full flex-wrap items-center justify-center gap-x-5 sm:w-auto sm:justify-start sm:gap-x-7 sm:gap-y-1">
              {currentStepIndex > 0 && (
                <button
                  type="button"
                  className="press-scale min-h-8 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent-blue/40"
                  onClick={() => changeStep(availableSteps[currentStepIndex - 1])}
                >
                  Back
                </button>
              )}
              <button type="button" disabled={busy} className="press-scale min-h-8 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent-blue/40 disabled:opacity-50" onClick={() => void onSnooze()}>
                Snooze 15 minutes
              </button>
              <button type="button" disabled={busy} className="press-scale min-h-8 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent-blue/40 disabled:opacity-50" onClick={() => void onBypass()}>
                Continue to Today
              </button>
            </div>

            <div className="flex flex-col items-stretch gap-1.5 sm:ml-auto sm:items-end">
              {isFinalStep && focusAgentCount > 0 && (
                <p className="text-center text-[11.5px] leading-[1.35] text-muted-foreground sm:text-right">
                  Claude will start {focusAgentCount} focus {focusAgentCount === 1 ? 'task' : 'tasks'}.
                </p>
              )}
              <button
                type="button"
                data-ritual-primary={isFinalStep ? '' : undefined}
                disabled={isFinalStep && (busy || buddyActive || visibleItems.length === 0)}
                className="min-h-11 w-full rounded-[13px] bg-foreground px-6 text-[14.5px] font-semibold tracking-[-0.005em] text-background shadow-lg outline-none transition-[transform,box-shadow,opacity] duration-150 hover:-translate-y-px hover:shadow-xl focus-visible:ring-2 focus-visible:ring-accent-blue/40 active:translate-y-0 active:shadow-md disabled:opacity-40 motion-reduce:transform-none sm:w-auto"
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
