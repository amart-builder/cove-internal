'use client';

import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { TaskSessionOwner, TaskSessionRun } from '@/lib/task-sessions/types';
import { reduceFocusSeats } from '@/lib/tasks/focus-seats';
import { taskSessionOwnerButtons } from './TaskSessionLauncher';
import { OpenInClaudeCode } from './ClaudeRunIndicators';
import DayRitualLayer from './DayRitualLayer';
import {
  beginCompletionMotion,
  beginUndoMotion,
  boundToday2MotionData,
  hideToday2Seat,
  prefersToday2ReducedMotion,
  TODAY2_MOTION_WATCHDOG_MS,
} from './today2/motion';

const ROMAN = ['I', 'II', 'III'] as const;
const RIVER_PATH = 'M365 -20 C458 160 272 276 351 420 C433 571 286 675 345 795 C371 848 374 911 352 990';

export type TodayRiverTaskV2 = {
  id: string;
  itemId: string;
  title: string;
  description: string;
  owner: string;
  provenance: string;
  run?: TaskSessionRun;
  sessionBusy: boolean;
};

export type SecondCurrentItemV2 = {
  id: string;
  kicker: string;
  title: string;
  kind: 'email' | 'rhythm';
};

export type TodayRiverStageV2Model = {
  timeLabel: string;
  timeIso: string;
  greeting: string;
  sunPoint: { x: number; y: number };
  doneCount: number;
  doneTitles: string[];
  focusCount: 1 | 2 | 3;
  orderedTasks: TodayRiverTaskV2[];
  selectedTaskId?: string;
  completingTaskId?: string;
  activeRunCount: number;
  localMode: boolean;
  reorderEnabled: boolean;
  focusCountBusy: boolean;
  rhythmCount: number;
  secondCurrentItems: SecondCurrentItemV2[];
  statusMessage?: string;
  errorMessage?: string;
  morningArrivalDisabled?: boolean;
  morningArrivalTitle?: string;
  closeDayDisabled?: boolean;
  weekendGate?: {
    weekday: string;
    planning: boolean;
  };
  ritualOpen: boolean;
};

export type TodayRiverStageV2Callbacks = {
  onOpenMorningArrival: () => void;
  onOpenCloseDay: () => void;
  onPlanWeekend: () => void;
  onFocusTask: (taskId: string) => void;
  onCompleteTask: (taskId: string, seatIndex: number) => Promise<void>;
  onStartSession: (taskId: string, owner: TaskSessionOwner) => void;
  onRetrySession: (taskId: string, owner: TaskSessionOwner) => void;
  onReorder: (orderedTaskIds: string[]) => void | Promise<void>;
  onFocusCountChange: (count: 1 | 2 | 3) => void;
  onGridOpenChange: (open: boolean) => void;
  onOpenSecondCurrentItem: (item: SecondCurrentItemV2) => void;
  onMotionDataFailure: () => void;
};

type TodayRiverStageV2Props = {
  model: TodayRiverStageV2Model;
  callbacks: TodayRiverStageV2Callbacks;
  headerSupplement?: ReactNode;
  rhythmManager?: ReactNode;
};

export type TodayRiverStageV2MotionHandle = {
  runUndo: (
    taskId: string,
    seatIndex: number,
    mutation: () => Promise<void>,
  ) => Promise<void>;
};

function refillCardTemplate(
  source: HTMLElement,
  task: TodayRiverTaskV2,
  seatIndex: number,
): HTMLElement {
  const template = source.cloneNode(true) as HTMLElement;
  template.classList.remove('is-selected', 'is-completing');
  const kicker = template.querySelector<HTMLElement>('.today2-kicker');
  const title = template.querySelector<HTMLElement>('h2');
  const footer = template.querySelector<HTMLElement>('.today2-card-footer');
  if (kicker) kicker.textContent = `Focus ${ROMAN[seatIndex]}`;
  if (title) title.textContent = task.title;
  if (footer) {
    footer.replaceChildren();
    const owner = document.createElement('span');
    owner.className = 'today2-owner-chip';
    owner.dataset.owner = task.owner;
    owner.textContent = task.owner;
    footer.appendChild(owner);
  }
  template.querySelectorAll('.today2-task-state, .today2-session-failed').forEach((node) => node.remove());
  return template;
}

function onKeyboardActivate(event: React.KeyboardEvent, action: () => void) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  action();
}

function SessionState({
  task,
  compact,
  onRetry,
}: {
  task: TodayRiverTaskV2;
  compact: boolean;
  onRetry: (owner: TaskSessionOwner) => void;
}) {
  const run = task.run;
  if (!run) return null;
  if (run.status === 'running') {
    return (
      <span className="today2-task-state">
        <i aria-hidden="true" />
        {run.owner === 'together' ? 'Planning with Claude' : 'Claude working'}
      </span>
    );
  }
  if (run.status === 'awaiting_approval') {
    return run.claudeSessionId ? (
      <span className="today2-session-link" onClick={(event) => event.stopPropagation()}>
        <OpenInClaudeCode
          sessionId={run.claudeSessionId}
          title={task.title}
          label="Needs you"
          resumeCommand={run.resumeCommand}
          className="today2-needs-you"
        />
      </span>
    ) : <span className="today2-task-state is-needs-you">Needs you</span>;
  }
  if (run.status === 'output_ready') {
    return run.claudeSessionId ? (
      <span className="today2-session-link" onClick={(event) => event.stopPropagation()}>
        <OpenInClaudeCode
          sessionId={run.claudeSessionId}
          title={task.title}
          label="Ready"
          resumeCommand={run.resumeCommand}
          className="today2-ready-button"
        />
      </span>
    ) : <span className="today2-task-state">Ready</span>;
  }
  if (run.status === 'failed') {
    return (
      <span className={`today2-session-failed ${compact ? 'is-compact' : ''}`}>
        <a href={run.resumeUrl} onClick={(event) => event.stopPropagation()}>Didn&apos;t finish ·</a>
        <button type="button" onClick={(event) => {
          event.stopPropagation();
          onRetry(run.owner);
        }}>
          Retry
        </button>
      </span>
    );
  }
  return null;
}

function FocusCard({
  task,
  index,
  single,
  selected,
  detailOpen,
  completing,
  localMode,
  activeRunCount,
  onSelect,
  onToggleDetail,
  onComplete,
  onStart,
  onRetry,
}: {
  task: TodayRiverTaskV2;
  index: number;
  single: boolean;
  selected: boolean;
  detailOpen: boolean;
  completing: boolean;
  localMode: boolean;
  activeRunCount: number;
  onSelect: () => void;
  onToggleDetail: () => void;
  onComplete: () => void;
  onStart: (owner: TaskSessionOwner) => void;
  onRetry: (owner: TaskSessionOwner) => void;
}) {
  const run = task.run;
  const owners = taskSessionOwnerButtons(run, undefined);
  const launchDisabled = task.sessionBusy || activeRunCount >= 6;
  const cardClass = single ? 'today2-focus-card is-hero' : 'today2-focus-card is-compact';

  return (
    <div className={`today2-focus-unit ${single ? 'is-single' : ''}`}>
      <article
        className={`${cardClass} ${selected ? 'is-selected' : ''} ${completing ? 'is-completing' : ''}`}
        data-today2-task-id={task.id}
      >
        <button
          type="button"
          className="today2-focus-open"
          aria-label={`Open details for ${task.title}`}
          aria-expanded={detailOpen}
          onClick={() => {
            onSelect();
            onToggleDetail();
          }}
        />
        <div className="today2-focus-copy">
          <p className="today2-kicker">{`Focus ${ROMAN[index]}`}</p>
          <h2>{task.title}</h2>
          {run?.status === 'running' && (
            <SessionState task={task} compact={!single} onRetry={onRetry} />
          )}
          <div className="today2-card-footer">
            <span className="today2-owner-chip" data-owner={task.owner}>{task.owner}</span>
            {run?.status !== 'running' && (
              <SessionState task={task} compact={!single} onRetry={onRetry} />
            )}
          </div>
        </div>
        <button
          type="button"
          className="today2-check-orb"
          aria-label={`Complete ${task.title}`}
          disabled={completing}
          onClick={(event) => {
            event.stopPropagation();
            onComplete();
          }}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path className="today2-check-rest" d="m5 12 4 4L19 6" />
            <path className="today2-check-draw" d="m5 12 4 4L19 6" />
          </svg>
        </button>
      </article>

      <section
        className={`today2-task-detail ${detailOpen ? 'is-open' : ''}`}
        aria-hidden={!detailOpen}
        aria-label={`${task.title} details`}
      >
        <p className="today2-detail-block today2-task-description" style={{ '--today2-delay': '0ms' } as CSSProperties}>
          {task.description || 'No additional detail has been added yet.'}
        </p>
        <p className="today2-detail-block today2-task-meta" style={{ '--today2-delay': '35ms' } as CSSProperties}>
          {task.owner} · {task.provenance}
        </p>
        <div className="today2-detail-block" style={{ '--today2-delay': '70ms' } as CSSProperties}>
          <p className="today2-detail-label">Start with Claude</p>
          {localMode ? (
            <div className="today2-detail-actions">
              <button
                type="button"
                disabled={launchDisabled || !owners.includes('together')}
                onClick={() => onStart('together')}
              >
                <i aria-hidden="true" /> Planning
              </button>
              <button
                type="button"
                disabled={launchDisabled || !owners.includes('claude')}
                onClick={() => onStart('claude')}
              >
                <i aria-hidden="true" /> Auto
              </button>
            </div>
          ) : (
            <p className="today2-local-note">Claude sessions are available in local Cove.</p>
          )}
          {activeRunCount >= 6 && owners.length > 0 && (
            <p className="today2-local-note">Six Claude sessions are already active.</p>
          )}
        </div>
      </section>
    </div>
  );
}

function SortableGridCard({
  task,
  position,
  focusCount,
  disabled,
}: {
  task: TodayRiverTaskV2;
  position: number;
  focusCount: number;
  disabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    disabled,
  });
  const inBand = position < focusCount;
  const state = task.run?.status === 'running'
    ? task.run.owner === 'together' ? 'Planning with Claude' : 'Claude working'
    : task.run?.status === 'awaiting_approval'
      ? 'Needs you'
      : task.run?.status === 'output_ready'
        ? 'Ready'
        : task.run?.status === 'failed'
          ? "Didn't finish"
          : undefined;
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        '--today2-stagger': `${position * 35}ms`,
      } as CSSProperties}
      className={isDragging ? 'is-dragging' : ''}
    >
      <article
        className={`today2-grid-card ${inBand ? 'is-focus' : ''}`}
        {...attributes}
        {...listeners}
      >
        <p className="today2-grid-kicker">{inBand ? `Focus ${ROMAN[position]}` : 'Today'}</p>
        <h3>{task.title}</h3>
        <div className="today2-grid-card-bottom">
          <span className="today2-owner-chip" data-owner={task.owner}>{task.owner}</span>
          {state && <span className="today2-grid-state">{state}</span>}
        </div>
      </article>
    </li>
  );
}

const TodayRiverStageV2 = forwardRef<TodayRiverStageV2MotionHandle, TodayRiverStageV2Props>(function TodayRiverStageV2({
  model,
  callbacks,
  headerSupplement,
  rhythmManager,
}, motionHandleRef) {
  const [gridOpen, setGridOpen] = useState(false);
  const [gridClosing, setGridClosing] = useState(false);
  const [detailTaskId, setDetailTaskId] = useState<string>();
  const [secondCurrentOpen, setSecondCurrentOpen] = useState(false);
  const [wakeOpen, setWakeOpen] = useState(false);
  const [displayDoneCount, setDisplayDoneCount] = useState(model.doneCount);
  const [beadPoints, setBeadPoints] = useState<Array<{ x: number; y: number }>>([]);
  const [visualTaskIds, setVisualTaskIds] = useState(() => model.orderedTasks.map((task) => task.id));
  const contentRef = useRef<HTMLDivElement>(null);
  const focusBandRef = useRef<HTMLDivElement>(null);
  const doneMarkerRef = useRef<HTMLButtonElement>(null);
  const doneLabelRef = useRef<HTMLSpanElement>(null);
  const motionLayerRef = useRef<HTMLDivElement>(null);
  const riverPathRef = useRef<SVGPathElement>(null);
  const gridHeadingRef = useRef<HTMLHeadingElement>(null);
  const gridButtonRef = useRef<HTMLButtonElement>(null);
  const gridPanelRef = useRef<HTMLElement>(null);
  const gridOriginRef = useRef<{ x: number; y: number; target?: Element } | undefined>(undefined);
  const gridCloseTimerRef = useRef<number | undefined>(undefined);
  const gridClosingRef = useRef(false);
  const motionBusyRef = useRef(false);
  const motionIdleRef = useRef<Promise<void>>(Promise.resolve());
  const resolveMotionIdleRef = useRef<(() => void) | undefined>(undefined);
  const motionSequenceRef = useRef(0);
  const activeMotionRef = useRef<{ id: number; expire: () => void } | undefined>(undefined);
  const watchdogCompletionTaskRef = useRef<string | undefined>(undefined);
  const displayDoneCountRef = useRef(model.doneCount);
  const lastCompletionRef = useRef<{
    taskId: string;
    seatIndex: number;
    template: HTMLElement;
  } | undefined>(undefined);
  const gridOpenCallbackRef = useRef(callbacks.onGridOpenChange);
  const reorderCallbackRef = useRef(callbacks.onReorder);
  const reorderPendingRef = useRef(false);
  const modelOrderRef = useRef(model.orderedTasks.map((task) => task.id));
  const modelDoneCountRef = useRef(model.doneCount);
  gridOpenCallbackRef.current = callbacks.onGridOpenChange;
  reorderCallbackRef.current = callbacks.onReorder;
  modelOrderRef.current = model.orderedTasks.map((task) => task.id);
  modelDoneCountRef.current = model.doneCount;
  const taskById = useMemo(
    () => new Map(model.orderedTasks.map((task) => [task.id, task])),
    [model.orderedTasks],
  );
  const displayTasks = useMemo(
    () => visualTaskIds.map((id) => taskById.get(id)).filter(Boolean) as TodayRiverTaskV2[],
    [taskById, visualTaskIds],
  );
  const focusTasks = displayTasks.slice(0, model.focusCount);
  const downstreamTasks = displayTasks.slice(model.focusCount);

  function acquireMotionLock(): number {
    const id = motionSequenceRef.current + 1;
    motionSequenceRef.current = id;
    motionBusyRef.current = true;
    motionIdleRef.current = new Promise((resolve) => {
      resolveMotionIdleRef.current = resolve;
    });
    activeMotionRef.current = { id, expire: () => undefined };
    return id;
  }

  function setMotionExpiry(id: number, expire: () => void) {
    if (activeMotionRef.current?.id === id) activeMotionRef.current.expire = expire;
  }

  function releaseMotionLock(id: number) {
    if (activeMotionRef.current?.id !== id) return;
    activeMotionRef.current = undefined;
    motionBusyRef.current = false;
    resolveMotionIdleRef.current?.();
    resolveMotionIdleRef.current = undefined;
    displayDoneCountRef.current = modelDoneCountRef.current;
    setDisplayDoneCount(modelDoneCountRef.current);
    setVisualTaskIds((current) => {
      const latest = modelOrderRef.current;
      return current.length === latest.length && current.every((taskId, index) => taskId === latest[index])
        ? current
        : latest;
    });
  }

  async function waitForMotionIdle() {
    if (!motionBusyRef.current) return;
    const active = activeMotionRef.current;
    const idle = motionIdleRef.current;
    let timer: number | undefined;
    const timedOut = await Promise.race([
      idle.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = window.setTimeout(() => resolve(true), TODAY2_MOTION_WATCHDOG_MS);
      }),
    ]);
    if (timer !== undefined) window.clearTimeout(timer);
    const stillActive = activeMotionRef.current;
    if (timedOut && stillActive && stillActive.id === active?.id) {
      stillActive.expire();
      await idle;
    }
  }

  const tickDoneCounter = useCallback((nextCount: number, reducedMotion = false) => {
    displayDoneCountRef.current = nextCount;
    setDisplayDoneCount(nextCount);
    if (reducedMotion) return;
    window.requestAnimationFrame(() => {
      doneLabelRef.current?.animate([
        { opacity: 0, filter: 'blur(1px)' },
        { opacity: 1, filter: 'blur(0)' },
      ], { duration: 150, easing: 'ease-out' });
    });
  }, []);

  const openGridFrom = useCallback((target?: Element | null) => {
    if (gridOpen || gridClosingRef.current) return;
    const rect = target?.getBoundingClientRect();
    gridOriginRef.current = rect
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, ...(target ? { target } : {}) }
      : undefined;
    setDetailTaskId(undefined);
    setGridClosing(false);
    setGridOpen(true);
  }, [gridOpen]);

  const closeGrid = useCallback(() => {
    if (!gridOpen || gridClosingRef.current) return;
    gridClosingRef.current = true;
    setGridClosing(true);
    gridCloseTimerRef.current = window.setTimeout(() => {
      setGridOpen(false);
      setGridClosing(false);
      gridClosingRef.current = false;
      const target = gridOriginRef.current?.target;
      if (target instanceof HTMLElement || target instanceof SVGElement) {
        window.requestAnimationFrame(() => target.focus());
      }
    }, prefersToday2ReducedMotion() ? 120 : 260);
  }, [gridOpen]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 10 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  async function handleCompleteTask(task: TodayRiverTaskV2, seatIndex: number) {
    if (motionBusyRef.current || reorderPendingRef.current) return;
    const card = Array.from(
      contentRef.current?.querySelectorAll<HTMLElement>('[data-today2-task-id]') ?? [],
    ).find((candidate) => candidate.dataset.today2TaskId === task.id);
    const band = focusBandRef.current;
    const doneMarker = doneMarkerRef.current;
    const layer = motionLayerRef.current;
    if (!card || !band || !doneMarker || !layer) {
      try {
        await boundToday2MotionData(callbacks.onCompleteTask(task.id, seatIndex));
      } catch {
        callbacks.onMotionDataFailure();
      }
      return;
    }

    const motionId = acquireMotionLock();
    setDetailTaskId(undefined);
    const reducedMotion = prefersToday2ReducedMotion();
    const startingDoneCount = displayDoneCountRef.current;
    const completedTemplate = card.cloneNode(true) as HTMLElement;
    const nextTask = displayTasks[model.focusCount];

    if (reducedMotion) {
      let cancelled = false;
      const watchdog = window.setTimeout(
        () => releaseMotionLock(motionId),
        TODAY2_MOTION_WATCHDOG_MS,
      );
      const tick = new Promise<void>((resolve) => window.setTimeout(() => {
        if (!cancelled) tickDoneCounter(startingDoneCount + 1, true);
        resolve();
      }, 120));
      try {
        await Promise.all([
          boundToday2MotionData(callbacks.onCompleteTask(task.id, seatIndex)),
          tick,
        ]);
        lastCompletionRef.current = { taskId: task.id, seatIndex, template: completedTemplate };
      } catch {
        cancelled = true;
        tickDoneCounter(modelDoneCountRef.current, true);
        callbacks.onMotionDataFailure();
      } finally {
        window.clearTimeout(watchdog);
        releaseMotionLock(motionId);
      }
      return;
    }

    const completedRect = card.getBoundingClientRect();
    const doneRect = doneMarker.getBoundingClientRect();
    const laneRect = contentRef.current?.querySelector<HTMLElement>('.today2-lane')?.getBoundingClientRect();
    const refillTemplate = nextTask ? refillCardTemplate(card, nextTask, seatIndex) : undefined;
    const revealSeat = hideToday2Seat(band, seatIndex);
    let seatVisible = false;
    const revealMotionSeat = () => {
      if (seatVisible) return;
      seatVisible = true;
      revealSeat();
    };
    const motion = beginCompletionMotion({
      layer,
      completedTemplate,
      completedRect,
      doneRect,
      refillTemplate,
      refillRect: nextTask ? completedRect : undefined,
      riverStartY: laneRect ? laneRect.top + laneRect.height * .71 : completedRect.bottom + 180,
      onMerge: () => tickDoneCounter(startingDoneCount + 1),
      onWatchdog: () => {
        watchdogCompletionTaskRef.current = task.id;
        revealMotionSeat();
        releaseMotionLock(motionId);
      },
    });
    setMotionExpiry(motionId, motion.expire);
    try {
      const [, motionOutcome] = await Promise.all([
        boundToday2MotionData(callbacks.onCompleteTask(task.id, seatIndex)),
        motion.finished,
      ]);
      if (motionOutcome === 'finished') {
        watchdogCompletionTaskRef.current = undefined;
        lastCompletionRef.current = { taskId: task.id, seatIndex, template: completedTemplate };
      } else if (motionOutcome === 'watchdog') {
        lastCompletionRef.current = undefined;
        tickDoneCounter(startingDoneCount + 1);
      }
      motion.cleanup();
    } catch {
      motion.cancel();
      tickDoneCounter(modelDoneCountRef.current);
      callbacks.onMotionDataFailure();
    } finally {
      revealMotionSeat();
      releaseMotionLock(motionId);
    }
  }

  const runUndoMotion = useCallback(async (
    taskId: string,
    seatIndex: number,
    mutation: () => Promise<void>,
  ) => {
    await waitForMotionIdle();
    await Promise.resolve();
    const stored = lastCompletionRef.current;
    const reducedMotion = prefersToday2ReducedMotion();
    const startingDoneCount = displayDoneCountRef.current;
    if (
      watchdogCompletionTaskRef.current === taskId ||
      !stored ||
      stored.taskId !== taskId
    ) {
      await boundToday2MotionData(mutation());
      tickDoneCounter(Math.max(0, startingDoneCount - 1), reducedMotion);
      watchdogCompletionTaskRef.current = undefined;
      return;
    }
    const motionId = acquireMotionLock();

    if (reducedMotion) {
      let cancelled = false;
      const watchdog = window.setTimeout(
        () => releaseMotionLock(motionId),
        TODAY2_MOTION_WATCHDOG_MS,
      );
      const tick = new Promise<void>((resolve) => window.setTimeout(() => {
        if (!cancelled) tickDoneCounter(Math.max(0, startingDoneCount - 1), true);
        resolve();
      }, 120));
      try {
        await Promise.all([boundToday2MotionData(mutation()), tick]);
        lastCompletionRef.current = undefined;
      } catch (error) {
        cancelled = true;
        tickDoneCounter(modelDoneCountRef.current, true);
        throw error;
      } finally {
        window.clearTimeout(watchdog);
        releaseMotionLock(motionId);
      }
      return;
    }

    const band = focusBandRef.current;
    const layer = motionLayerRef.current;
    const doneRect = doneMarkerRef.current?.getBoundingClientRect();
    const seat = band?.querySelectorAll<HTMLElement>('[data-today2-focus-unit]')[seatIndex];
    const displaced = seat?.querySelector<HTMLElement>('.today2-focus-card');
    const seatRect = displaced?.getBoundingClientRect();
    if (!band || !layer || !doneRect || !seatRect) {
      try {
        await boundToday2MotionData(mutation());
        tickDoneCounter(Math.max(0, startingDoneCount - 1));
        lastCompletionRef.current = undefined;
      } finally {
        releaseMotionLock(motionId);
      }
      return;
    }

    const beadRect = contentRef.current?.querySelector<SVGGraphicsElement>('.today2-bead')?.getBoundingClientRect();
    const laneRect = contentRef.current?.querySelector<HTMLElement>('.today2-lane')?.getBoundingClientRect();
    const riverTarget = beadRect
      ? { x: beadRect.left + beadRect.width / 2, y: beadRect.top + beadRect.height / 2 }
      : {
          x: seatRect.left + seatRect.width / 2,
          y: laneRect ? laneRect.top + laneRect.height * .71 : seatRect.bottom + 180,
        };
    const revealSeat = hideToday2Seat(band, seatIndex);
    let seatVisible = false;
    const revealMotionSeat = () => {
      if (seatVisible) return;
      seatVisible = true;
      revealSeat();
    };
    const motion = beginUndoMotion({
      layer,
      displacedTemplate: displaced ?? undefined,
      restoredTemplate: stored.template,
      seatRect,
      doneRect,
      riverTarget,
      onDetach: () => tickDoneCounter(Math.max(0, startingDoneCount - 1)),
      onWatchdog: () => {
        revealMotionSeat();
        releaseMotionLock(motionId);
      },
    });
    setMotionExpiry(motionId, motion.expire);
    try {
      const [, motionOutcome] = await Promise.all([
        boundToday2MotionData(mutation()),
        motion.finished,
      ]);
      lastCompletionRef.current = undefined;
      if (motionOutcome === 'watchdog') {
        tickDoneCounter(Math.max(0, startingDoneCount - 1));
      }
      motion.cleanup();
    } catch (error) {
      motion.cancel();
      tickDoneCounter(modelDoneCountRef.current);
      throw error;
    } finally {
      revealMotionSeat();
      releaseMotionLock(motionId);
    }
  }, [tickDoneCounter]);

  useImperativeHandle(motionHandleRef, () => ({ runUndo: runUndoMotion }), [runUndoMotion]);

  useEffect(() => {
    gridOpenCallbackRef.current(gridOpen);
    return () => gridOpenCallbackRef.current(false);
  }, [gridOpen]);

  useEffect(() => {
    if (motionBusyRef.current) return;
    displayDoneCountRef.current = model.doneCount;
    setDisplayDoneCount(model.doneCount);
  }, [model.doneCount]);

  useEffect(() => () => {
    if (gridCloseTimerRef.current !== undefined) {
      window.clearTimeout(gridCloseTimerRef.current);
    }
  }, []);

  useLayoutEffect(() => {
    if (reorderPendingRef.current || motionBusyRef.current) return;
    const modelIds = model.orderedTasks.map((task) => task.id);
    const vanishedSeatIds = visualTaskIds
      .slice(0, model.focusCount)
      .filter((taskId) => !taskById.has(taskId));
    if (vanishedSeatIds.length === 0) {
      if (
        visualTaskIds.length !== modelIds.length ||
        visualTaskIds.some((taskId, index) => taskId !== modelIds[index])
      ) {
        setVisualTaskIds(modelIds);
      }
      return;
    }

    let next = visualTaskIds;
    for (const taskId of vanishedSeatIds) {
      next = reduceFocusSeats(next, model.focusCount, { type: 'task_vanished', taskId });
    }
    next = [
      ...next.filter((taskId) => taskById.has(taskId)),
      ...modelIds.filter((taskId) => !next.includes(taskId)),
    ];
    setVisualTaskIds(next);
    reorderPendingRef.current = true;
    void Promise.resolve()
      .then(() => reorderCallbackRef.current(next))
      .catch(() => undefined)
      .finally(() => {
        reorderPendingRef.current = false;
        setVisualTaskIds((current) => {
          const latest = modelOrderRef.current;
          return current.length === latest.length && current.every((taskId, index) => taskId === latest[index])
            ? current
            : latest;
        });
      });
  }, [model.focusCount, model.orderedTasks, taskById, visualTaskIds]);

  useEffect(() => {
    function handlePointer(event: PointerEvent) {
      const target = event.target as Element | null;
      if (gridOpen && target?.closest('[data-day-ritual-layer]') && !target.closest('.today2-grid-panel')) {
        closeGrid();
        return;
      }
      if (!target?.closest('[data-today2-focus-unit]')) setDetailTaskId(undefined);
      if (!target?.closest('[data-today2-second-current]')) setSecondCurrentOpen(false);
    }
    document.addEventListener('pointerdown', handlePointer);
    return () => document.removeEventListener('pointerdown', handlePointer);
  }, [closeGrid, gridOpen]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (gridOpen) {
        if (event.key === '1' || event.key === '2' || event.key === '3') {
          event.preventDefault();
          callbacks.onFocusCountChange(Number(event.key) as 1 | 2 | 3);
        }
        return;
      }
      if (event.key === 'Escape') {
        setDetailTaskId(undefined);
        setSecondCurrentOpen(false);
        return;
      }
      const target = event.target as HTMLElement | null;
      const typing = target?.matches('input, textarea, select') || target?.isContentEditable;
      if (
        !typing &&
        !model.ritualOpen &&
        event.key.toLowerCase() === 'g' &&
        !event.metaKey &&
        !event.ctrlKey
      ) {
        event.preventDefault();
        openGridFrom(gridButtonRef.current);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [callbacks, gridOpen, model.ritualOpen, openGridFrom]);

  useLayoutEffect(() => {
    if (!gridOpen || !gridPanelRef.current) return;
    const panelRect = gridPanelRef.current.getBoundingClientRect();
    const origin = gridOriginRef.current;
    const x = origin ? origin.x - panelRect.left : panelRect.width / 2;
    const y = origin ? origin.y - panelRect.top : panelRect.height;
    gridPanelRef.current.style.transformOrigin = `${x}px ${y}px`;
  }, [gridOpen]);

  useLayoutEffect(() => {
    const path = riverPathRef.current;
    if (!path) return;
    const length = path.getTotalLength();
    const samples = Array.from({ length: 121 }, (_, index) =>
      path.getPointAtLength(length * index / 120));
    const fractions = [.66, .75, .84];
    setBeadPoints(fractions.map((fraction) => {
      const targetY = fraction * 960;
      return samples.reduce((best, point) =>
        Math.abs(point.y - targetY) < Math.abs(best.y - targetY) ? point : best,
      samples[0]);
    }));
  }, []);

  const gridItems = visualTaskIds;

  async function handleDragEnd(event: DragEndEvent) {
    if (reorderPendingRef.current) return;
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : undefined;
    if (!overId || activeId === overId) return;
    const source = displayTasks.findIndex((task) => task.id === activeId);
    const target = displayTasks.findIndex((task) => task.id === overId);
    if (source < 0 || target < 0) return;
    const next = displayTasks.map((task) => task.id);
    if (source < model.focusCount || target < model.focusCount) {
      [next[source], next[target]] = [next[target], next[source]];
    } else {
      const [moved] = next.splice(source, 1);
      next.splice(target, 0, moved);
    }
    setVisualTaskIds(next);
    reorderPendingRef.current = true;
    try {
      await callbacks.onReorder(next);
    } finally {
      reorderPendingRef.current = false;
      setVisualTaskIds(modelOrderRef.current);
    }
  }

  return (
    <div className={`today2-root ${gridOpen ? 'is-grid-open' : ''} ${gridClosing ? 'is-grid-closing' : ''}`}>
      <div ref={contentRef} className="today2-stage-content">
        <header className="today2-header" aria-label={`Today at ${model.timeLabel}`}>
          <p className="today2-eyebrow">Today</p>
          <time dateTime={model.timeIso} suppressHydrationWarning>{model.timeLabel}</time>
          <p className="today2-greeting">{model.greeting}</p>
          <div className="today2-quiet-actions">
            <button
              type="button"
              disabled={model.morningArrivalDisabled}
              title={model.morningArrivalTitle}
              onClick={callbacks.onOpenMorningArrival}
            >
              Morning Arrival
            </button>
            <button type="button" disabled={model.closeDayDisabled} onClick={callbacks.onOpenCloseDay}>
              Close My Day
            </button>
          </div>
          {model.weekendGate && (
            <div className="today2-weekend-gate">
              <p>It&apos;s {model.weekendGate.weekday}. Cove plans weekdays.</p>
              <button
                type="button"
                disabled={model.weekendGate.planning}
                onClick={callbacks.onPlanWeekend}
              >
                {model.weekendGate.planning ? 'Planning…' : 'Plan today anyway'}
              </button>
            </div>
          )}
          {headerSupplement}
          {model.statusMessage && <p className="today2-status" role="status">{model.statusMessage}</p>}
          {model.errorMessage && <p className="today2-error" role="alert">{model.errorMessage}</p>}
        </header>

        <svg className="today2-sun-arc" viewBox="0 0 290 120" aria-hidden="true">
          <path d="M8 104 C58 46 134 17 274 28" />
          <circle className="today2-sun-now" cx={model.sunPoint.x} cy={model.sunPoint.y} r="3.2" />
          <g className="today2-sun-glyph" transform="translate(269 29)">
            <circle r="4.2" />
            <path d="M0 -9 V-12 M0 9 V12 M-9 0 H-12 M9 0 H12 M-6.4 -6.4 L-8.5 -8.5 M6.4 -6.4 L8.5 -8.5 M-6.4 6.4 L-8.5 8.5 M6.4 6.4 L8.5 8.5" />
          </g>
        </svg>

        <aside
          className={`today2-second-current ${secondCurrentOpen ? 'is-open' : ''}`}
          data-today2-second-current
        >
          <button
            type="button"
            className="today2-second-current-card"
            aria-expanded={secondCurrentOpen}
            onClick={() => setSecondCurrentOpen((current) => !current)}
          >
            <span>Second Current</span>
            <svg viewBox="0 0 198 26" preserveAspectRatio="none" aria-hidden="true">
              <defs>
                <linearGradient id="today2-mini-gradient" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stopColor="#e9c98f" />
                  <stop offset=".5" stopColor="#86bde1" />
                  <stop offset="1" stopColor="#45a7e8" />
                </linearGradient>
              </defs>
              <path className="today2-mini-glow" d="M1 18 C43 1 67 25 101 12 C132 0 158 24 197 7" />
              <path className="today2-mini-path" d="M1 18 C43 1 67 25 101 12 C132 0 158 24 197 7" />
            </svg>
            <small>Email · {model.rhythmCount} {model.rhythmCount === 1 ? 'rhythm' : 'rhythms'}</small>
          </button>
          <div className="today2-second-current-column" aria-hidden={!secondCurrentOpen}>
            {model.secondCurrentItems.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className="today2-second-current-item"
                style={{ '--today2-item-index': index } as CSSProperties}
                onClick={() => callbacks.onOpenSecondCurrentItem(item)}
              >
                <span>{item.kicker}</span>
                <strong>{item.title}</strong>
              </button>
            ))}
            {rhythmManager && (
              <div
                className="today2-rhythm-entry"
                style={{ '--today2-item-index': model.secondCurrentItems.length } as CSSProperties}
              >
                {rhythmManager}
              </div>
            )}
          </div>
        </aside>

        <section className="today2-lane" aria-label="Today focus lane">
          <svg className="today2-river" viewBox="0 0 700 960" preserveAspectRatio="none" role="group" aria-label="More tasks in Today">
            <defs>
              <linearGradient id="today2-river-gradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--current-line-warm)" />
                <stop offset=".46" stopColor="var(--current-line-core)" />
                <stop offset="1" stopColor="var(--current-line-cool)" />
              </linearGradient>
            </defs>
            <path className="today2-river-glow" d={RIVER_PATH} />
            <path className="today2-river-soft" d={RIVER_PATH} />
            <path ref={riverPathRef} className="today2-river-core" d={RIVER_PATH} />
            <path className="today2-river-shimmer" d={RIVER_PATH} />
            {downstreamTasks.slice(0, 3).map((task, index) => {
              const point = beadPoints[index];
              if (!point) return null;
              return (
                <circle
                  key={task.id}
                  className={`today2-bead is-${index + 1}`}
                  cx={point.x}
                  cy={point.y}
                  r="7"
                  role="button"
                  tabIndex={0}
                  aria-label={`Open Focus Grid for ${task.title}`}
                  onClick={(event) => openGridFrom(event.currentTarget)}
                  onKeyDown={(event) => onKeyboardActivate(event, () => openGridFrom(event.currentTarget))}
                />
              );
            })}
          </svg>

          <button
            ref={doneMarkerRef}
            type="button"
            className="today2-done-marker"
            aria-expanded={wakeOpen}
            onClick={() => setWakeOpen((current) => !current)}
          >
            <span className="today2-done-dots" aria-hidden="true"><i /><i /><i /></span>
            <span ref={doneLabelRef} className="today2-done-label">{displayDoneCount} done today</span>
          </button>
          {wakeOpen && model.doneTitles.length > 0 && (
            <div className="today2-done-list">
              {model.doneTitles.slice(0, 5).map((title) => <p key={title}>{title}</p>)}
            </div>
          )}

          {focusTasks.length > 0 ? (
            <div ref={focusBandRef} className={`today2-focus-band count-${model.focusCount}`}>
              {focusTasks.map((task, index) => (
                <div key={task.id} data-today2-focus-unit>
                  <FocusCard
                    task={task}
                    index={index}
                    single={model.focusCount === 1}
                    selected={model.selectedTaskId === task.id}
                    detailOpen={detailTaskId === task.id}
                    completing={model.completingTaskId === task.id}
                    localMode={model.localMode}
                    activeRunCount={model.activeRunCount}
                    onSelect={() => callbacks.onFocusTask(task.id)}
                    onToggleDetail={() => setDetailTaskId((current) => current === task.id ? undefined : task.id)}
                    onComplete={() => void handleCompleteTask(task, index)}
                    onStart={(owner) => {
                      setDetailTaskId(undefined);
                      callbacks.onStartSession(task.id, owner);
                    }}
                    onRetry={(owner) => callbacks.onRetrySession(task.id, owner)}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="today2-clear-state">
              <h2>You&apos;re clear for now.</h2>
              <button
                type="button"
                disabled={model.closeDayDisabled}
                onClick={callbacks.onOpenCloseDay}
              >
                Close My Day
              </button>
            </div>
          )}

          <button
            ref={gridButtonRef}
            type="button"
            className={`today2-grid-button ${gridOpen ? 'is-open' : ''}`}
            aria-label={gridOpen ? 'Close Focus Grid' : 'Open Focus Grid'}
            aria-expanded={gridOpen}
            onClick={(event) => gridOpen ? closeGrid() : openGridFrom(event.currentTarget)}
          >
            <span className="today2-grid-dots" aria-hidden="true"><i /><i /><i /><i /></span>
            <span className="today2-grid-x" aria-hidden="true" />
          </button>
        </section>
      </div>

      {gridOpen && (
        <DayRitualLayer
          labelledBy="today2-grid-title"
          initialFocusRef={gridHeadingRef}
          inertTargetRef={contentRef}
          width="wide"
          onEscape={closeGrid}
        >
          <div
            className="today2-grid-hit-area"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeGrid();
            }}
          >
            <section ref={gridPanelRef} className="today2-grid-panel">
              <header className="today2-grid-header">
                <div className="today2-grid-heading">
                  <h2 ref={gridHeadingRef} id="today2-grid-title" tabIndex={-1}>Your day</h2>
                  <span>{displayTasks.length} open · {model.doneCount} done</span>
                </div>
                <div className="today2-grid-tools">
                  <div className="today2-focus-dial" role="radiogroup" aria-label="Tasks in focus">
                    <span
                      className="today2-dial-thumb"
                      style={{ transform: `translateX(${(model.focusCount - 1) * 100}%)` }}
                      aria-hidden="true"
                    />
                    {ROMAN.map((label, index) => {
                      const count = index + 1 as 1 | 2 | 3;
                      return (
                        <button
                          key={label}
                          type="button"
                          role="radio"
                          aria-checked={model.focusCount === count}
                          tabIndex={model.focusCount === count ? 0 : -1}
                          className={model.focusCount === count ? 'is-active' : ''}
                          disabled={model.focusCountBusy}
                          onClick={() => callbacks.onFocusCountChange(count)}
                          onKeyDown={(event) => {
                            let nextIndex: number | undefined;
                            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                              nextIndex = (index + 1) % ROMAN.length;
                            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                              nextIndex = (index + ROMAN.length - 1) % ROMAN.length;
                            } else if (event.key === 'Home') {
                              nextIndex = 0;
                            } else if (event.key === 'End') {
                              nextIndex = ROMAN.length - 1;
                            }
                            if (nextIndex === undefined) return;
                            event.preventDefault();
                            const nextCount = nextIndex + 1 as 1 | 2 | 3;
                            callbacks.onFocusCountChange(nextCount);
                            const radios = event.currentTarget.parentElement
                              ?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
                            radios?.[nextIndex]?.focus();
                          }}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                  <p>drag to reorder · drag onto Focus to swap · esc to close</p>
                </div>
              </header>
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={gridItems} strategy={rectSortingStrategy}>
                  <ol className="today2-focus-grid">
                    {displayTasks.map((task, position) => (
                      <SortableGridCard
                        key={task.id}
                        task={task}
                        position={position}
                        focusCount={model.focusCount}
                        disabled={!model.reorderEnabled}
                      />
                    ))}
                  </ol>
                </SortableContext>
              </DndContext>
            </section>
          </div>
        </DayRitualLayer>
      )}
      <div ref={motionLayerRef} className="today2-motion-layer" aria-hidden="true" />
    </div>
  );
});

export default TodayRiverStageV2;
