'use client';

import {
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { useBuddy, useBuddyStream } from '@/components/buddy/BuddyProvider';
import { matchesArrivalAddition } from '@/lib/day-plan/arrival-addition';
import type {
  MorningBriefGeneration,
  MorningBriefSalesActionState,
  MorningBriefSuggestedAddition,
  PublicMorningBrief,
} from '@/lib/day-plan/brief';
import type {
  DayPlan,
  DayPlanItem,
  DayPlanMutationResult,
  DayPlanOwner as DayOwner,
} from '@/lib/day-plan/types';
import {
  arrivalDateLabel,
  morningArrivalGreeting,
  resolveArrivalEscape,
  selectEssentialItems,
} from '@/lib/day-plan/presentation';
import ArrivalStepBrief from './arrival/ArrivalStepBrief';
import ArrivalStepExtras from './arrival/ArrivalStepExtras';
import ArrivalStepPriorities from './arrival/ArrivalStepPriorities';
import type { OwnerChipEscapeHandler } from './arrival/OwnerChip';
import StepDots, { type ArrivalStep } from './arrival/StepDots';

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

interface MorningArrivalProps {
  plan: DayPlan;
  items: MorningArrivalItem[];
  recommendation: string;
  brief?: PublicMorningBrief;
  briefGeneration?: MorningBriefGeneration;
  recap?: string;
  freshnessLabel?: string;
  expandedItemId?: string | null;
  busy?: boolean;
  error?: string;
  titleId: string;
  descriptionId: string;
  escapeRef?: RefObject<(() => void) | null>;
  onInteract?: () => void;
  onExpand: (itemId: string) => void;
  onOwnerChange: (itemId: string, owner: DayOwner) => void | Promise<void>;
  onDragReorder: (activeId: string, overId: string) => void | Promise<void>;
  onDismiss: (itemId: string, title: string) => void | Promise<void>;
  onSalesAction?: (
    actionIndex: number,
    state: MorningBriefSalesActionState,
    editedText?: string,
  ) => void | Promise<void>;
  onAddSuggestion?: (
    addition: MorningBriefSuggestedAddition,
    owner: DayOwner,
  ) => Promise<DayPlanMutationResult>;
  onSnooze: () => void | Promise<void>;
  onSkip: () => void | Promise<void>;
  onBypass: () => void | Promise<void>;
  onStartDay: () => void | Promise<void>;
  onAddWhatChanged?: () => void;
  onForceBrief?: () => void;
  forcingBrief?: boolean;
  onOpenAllWork?: () => void;
}

const STEP_TITLES: Record<Exclude<ArrivalStep, 'brief'>, string> = {
  priorities: 'Choose where your attention goes.',
  extras: 'Anything else?',
};

// The brief step has no description sentence: it gets the date instead. A line
// explaining what a brief is reads as chrome written by a machine, and the brief
// itself is under standing orders never to state the date, so this is the one
// place it appears.
const STEP_DESCRIPTIONS: Record<ArrivalStep, string> = {
  brief: '',
  priorities: 'Drag three outcomes into priority order, then choose who owns each one. Items you give to Claude start planning when you begin your day.',
  extras: 'Review the optional details, make any final refinements, and begin your day.',
};

const STEP_ANNOUNCEMENTS: Record<ArrivalStep, string> = {
  brief: 'the brief',
  priorities: 'your priorities',
  extras: 'anything else',
};

export default function MorningArrival({
  plan,
  items,
  recommendation,
  brief,
  briefGeneration,
  recap,
  freshnessLabel,
  expandedItemId,
  busy = false,
  error,
  titleId,
  descriptionId,
  escapeRef,
  onInteract,
  onExpand,
  onOwnerChange,
  onDragReorder,
  onDismiss,
  onSalesAction,
  onAddSuggestion,
  onSnooze,
  onSkip,
  onBypass,
  onStartDay,
  onAddWhatChanged,
  onForceBrief,
  forcingBrief,
  onOpenAllWork,
}: MorningArrivalProps) {
  const { setPageContext, busy: buddyBusy } = useBuddy();
  const { streamingTurn } = useBuddyStream();
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const draggingRef = useRef(false);
  const disclosureRefs = useRef(new Map<string, HTMLButtonElement>());
  const ownerChipEscapeRef = useRef<OwnerChipEscapeHandler | null>(null);
  const hasExtras = useRef(
    Boolean(
      (brief?.salesActions.length && onSalesAction) || brief?.suggestedAdditions.length,
    ),
  ).current;
  const briefWriting =
    !brief && (briefGeneration?.state === 'queued' || briefGeneration?.state === 'running');
  const hasBrief = useRef(Boolean(recap || brief || briefWriting || recommendation)).current;
  const availableSteps: ArrivalStep[] = [
    ...(hasBrief ? ['brief' as const] : []),
    'priorities',
    ...(hasExtras ? ['extras' as const] : []),
  ];
  const [step, setStep] = useState<ArrivalStep>(() => hasBrief ? 'brief' : 'priorities');
  const [stepAnnouncement, setStepAnnouncement] = useState('');
  const previousStepRef = useRef(step);
  const visibleItems = selectEssentialItems(items.map((view) => view.item), 3)
    .map((item) => items.find((view) => view.item.id === item.id))
    .filter((view): view is MorningArrivalItem => Boolean(view));
  const addedSuggestionIndexes = new Set(
    brief?.suggestedAdditions.flatMap((addition, index) =>
      plan.items.some((item) => matchesArrivalAddition(item, addition)) ? [index] : [],
    ) ?? [],
  );
  const buddyActive = buddyBusy || Boolean(streamingTurn);
  const currentStepIndex = Math.max(0, availableSteps.indexOf(step));
  const isFinalStep = currentStepIndex === availableSteps.length - 1;

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

  function setDisclosureRef(itemId: string, node: HTMLButtonElement | null) {
    if (node) disclosureRefs.current.set(itemId, node);
    else disclosureRefs.current.delete(itemId);
  }

  function focusDisclosure(itemId: string | undefined) {
    if (!itemId) return;
    window.requestAnimationFrame(() => disclosureRefs.current.get(itemId)?.focus());
  }

  function handleOwnerChipOpen(handler: OwnerChipEscapeHandler) {
    if (ownerChipEscapeRef.current?.itemId !== handler.itemId) {
      ownerChipEscapeRef.current?.closeAndFocus();
    }
    ownerChipEscapeRef.current = handler;
  }

  function handleOwnerChipClose(itemId: string) {
    if (ownerChipEscapeRef.current?.itemId === itemId) ownerChipEscapeRef.current = null;
  }

  function handleEscape() {
    const openOwnerChip = ownerChipEscapeRef.current;
    if (openOwnerChip) {
      openOwnerChip.closeAndFocus();
      return;
    }
    const decision = resolveArrivalEscape({
      dragging: draggingRef.current,
      expandedItemId,
    });
    if (decision.type === 'collapse') {
      onExpand(decision.itemId);
      focusDisclosure(decision.itemId);
    }
  }

  useEffect(() => {
    if (!escapeRef) return;
    escapeRef.current = handleEscape;
    return () => {
      escapeRef.current = null;
    };
  });

  async function handleDismiss(itemId: string, title: string) {
    const nextItemId = visibleItems.find((view) => view.item.id !== itemId)?.item.id;
    if (expandedItemId === itemId) onExpand(itemId);
    await onDismiss(itemId, title);
    focusDisclosure(nextItemId);
  }

  function changeStep(nextStep: ArrivalStep) {
    ownerChipEscapeRef.current?.closeAndFocus();
    onInteract?.();
    setStep(nextStep);
  }

  return (
    <div
      className="mx-auto my-auto w-full max-w-[64rem] overflow-hidden rounded-3xl border bg-background shadow-2xl min-[1500px]:max-w-[80rem]"
      data-day-plan-id={plan.id}
    >
      <div className="max-h-[calc(100dvh-7rem)] overflow-y-auto">
        <header className="sticky top-0 z-20 border-b bg-background/95 py-5 backdrop-blur">
          <div className="mx-auto w-full max-w-[60rem] px-6 sm:px-10 min-[1500px]:max-w-[76rem]">
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
                {step === 'brief'
                  ? morningArrivalGreeting(new Date(), plan.timezone)
                  : STEP_TITLES[step]}
              </h1>
              <p
                id={descriptionId}
                className={
                  step === 'brief'
                    ? 'arrival-brief-kicker mt-2.5'
                    : 'mt-2 text-sm leading-relaxed text-muted-foreground'
                }
              >
                {step === 'brief' ? arrivalDateLabel(plan.localDate) : STEP_DESCRIPTIONS[step]}
              </p>
              {freshnessLabel && <p className="mt-2 text-xs text-muted-foreground">{freshnessLabel}</p>}
            </div>
            <p className="sr-only" aria-live="polite" aria-atomic="true">{stepAnnouncement}</p>
          </div>
        </header>

        {error && (
          <div className="mx-auto w-full max-w-[60rem] space-y-2 px-6 pt-5 sm:px-10 min-[1500px]:max-w-[76rem]">
            {error && (
              <p role="alert" className="rounded-xl border border-accent-red/30 bg-accent-red/5 p-3 text-sm text-accent-red">
                {error}
              </p>
            )}
          </div>
        )}

        <div
          key={step}
          className="day-ritual-swap-in pb-24 sm:pb-0 min-[1500px]:[&>section]:max-w-[76rem]"
        >
          {step === 'brief' ? (
            <ArrivalStepBrief
              recap={recap}
              headline={brief?.headline}
              // No brief yet means the deterministic recommendation stands in,
              // and it is one sentence, so it becomes the headline rather than
              // an orphan paragraph under an empty heading.
              paragraphs={brief?.narrativeParagraphs ?? (recommendation ? [recommendation] : [])}
              watchItems={brief?.watchItems ?? []}
              briefWriting={briefWriting}
              briefGeneration={briefGeneration}
              hasBriefContent={Boolean(brief)}
              onForceBrief={onForceBrief}
              forcingBrief={forcingBrief}
            />
          ) : step === 'priorities' ? (
            <ArrivalStepPriorities
              visibleItems={visibleItems}
              expandedItemId={expandedItemId}
              busy={busy}
              draggingRef={draggingRef}
              onExpand={onExpand}
              onOwnerChange={onOwnerChange}
              onDragReorder={onDragReorder}
              onDismiss={handleDismiss}
              setDisclosureRef={setDisclosureRef}
              onOwnerChipOpen={handleOwnerChipOpen}
              onOwnerChipClose={handleOwnerChipClose}
              onAddWhatChanged={onAddWhatChanged}
              onOpenAllWork={onOpenAllWork}
            />
          ) : (
            <ArrivalStepExtras
              brief={brief}
              onSalesAction={onSalesAction}
              onAddSuggestion={onAddSuggestion}
              busy={busy}
              editingIndex={editingIndex}
              setEditingIndex={setEditingIndex}
              editDraft={editDraft}
              setEditDraft={setEditDraft}
              addedSuggestionIndexes={addedSuggestionIndexes}
              onOwnerChoiceOpen={handleOwnerChipOpen}
              onOwnerChoiceClose={handleOwnerChipClose}
            />
          )}
        </div>

        <footer className="sticky bottom-0 z-20 border-t !bg-background">
          <div className="mx-auto flex w-full max-w-[60rem] flex-col items-stretch gap-2 py-3 pl-4 pr-20 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3 sm:py-4 sm:pl-10 sm:pr-24 min-[1120px]:pr-10 min-[1500px]:max-w-[76rem]">
            <div className="flex w-full flex-wrap items-center justify-center gap-x-3 sm:w-auto sm:justify-start sm:gap-x-4 sm:gap-y-1">
              {currentStepIndex > 0 && (
                <button
                  type="button"
                  className="press-scale min-h-8 whitespace-nowrap text-[11px] text-muted-foreground hover:underline hover:underline-offset-2 sm:min-h-9 sm:text-xs"
                  onClick={() => changeStep(availableSteps[currentStepIndex - 1])}
                >
                  Back
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                className="press-scale min-h-8 whitespace-nowrap text-[11px] text-muted-foreground hover:underline hover:underline-offset-2 disabled:opacity-50 sm:min-h-9 sm:text-xs"
                onClick={() => void onSnooze()}
              >
                Snooze 15 minutes
              </button>
              <button
                type="button"
                disabled={busy}
                className="press-scale min-h-8 whitespace-nowrap text-[11px] text-muted-foreground hover:underline hover:underline-offset-2 disabled:opacity-50 sm:min-h-9 sm:text-xs"
                onClick={() => void onSkip()}
              >
                Skip today
              </button>
              <button
                type="button"
                disabled={busy}
                className="press-scale min-h-8 whitespace-nowrap text-[11px] text-muted-foreground hover:underline hover:underline-offset-2 disabled:opacity-50 sm:min-h-9 sm:text-xs"
                onClick={() => void onBypass()}
              >
                Enter Living Current
              </button>
            </div>

            <button
              type="button"
              data-ritual-primary={isFinalStep ? '' : undefined}
              disabled={isFinalStep && (
                busy ||
                buddyActive ||
                visibleItems.length === 0
              )}
              className={`press-scale min-h-11 w-full rounded-xl px-5 text-sm font-semibold disabled:opacity-40 sm:ml-auto sm:w-auto ${
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
        </footer>
      </div>
    </div>
  );
}

export type { MorningArrivalProps };
