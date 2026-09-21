'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type ScreenReaderInstructions,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import type { MorningArrivalBoardTask, MorningArrivalItem, MorningArrivalProps } from '../MorningArrival';
import type { Task } from '../TaskFieldsEditor';
import TaskSheet, { type TaskSheetDetail } from './TaskSheet';
import { arrivalDropOutcome, type ArrivalDropZone } from '@/lib/day-plan/presentation';

export const INITIAL_PRIORITY_ZONE_ID = 'arrival-initial-priorities-zone';
export const ALSO_TODAY_ZONE_ID = 'arrival-also-today-zone';
export const NOT_TODAY_ZONE_ID = 'arrival-not-today-zone';
// Kept as an alias for older callers that treated all of Today as one zone.
export const TODAY_ZONE_ID = ALSO_TODAY_ZONE_ID;
const BOARD_TASK_LIMIT = 7;
const DROP_ZONES: Record<string, ArrivalDropZone> = {
  [INITIAL_PRIORITY_ZONE_ID]: 'priority',
  [ALSO_TODAY_ZONE_ID]: 'also-today',
  [NOT_TODAY_ZONE_ID]: 'not-today',
};
const ZONE_LABELS: Record<ArrivalDropZone, string> = {
  priority: 'Initial priorities',
  'also-today': 'Also today',
  'not-today': 'Not today',
};
const TODAY_TAG_CLASS = 'mb-2 inline-block rounded-full bg-muted px-2 py-[3px] text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground';
const EXPANSION_KEY_PREFIX = 'cove.arrival.not-today-expanded.';

const bucketCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(args);
};

type OpenTaskSheet = {
  detail: TaskSheetDetail;
  returnFocus: HTMLElement;
};

function firstPreview(...values: Array<string | undefined>) {
  return values.find((value) => value?.trim())?.trim();
}

function cardKeyDown(event: React.KeyboardEvent<HTMLElement>, onOpen: (trigger: HTMLElement) => void) {
  if (event.target !== event.currentTarget) return;
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  onOpen(event.currentTarget);
}

export function addNotTodayDropToToday(
  activeId: string,
  overId: string,
  notTodayTasks: readonly MorningArrivalBoardTask[],
  addTask: (task: MorningArrivalBoardTask) => boolean | Promise<boolean>,
): boolean {
  if (!activeId.startsWith('not-today:')) return false;
  if (overId !== INITIAL_PRIORITY_ZONE_ID && overId !== ALSO_TODAY_ZONE_ID) return true;
  const task = notTodayTasks.find((candidate) => candidate.id === activeId.slice(10));
  if (task) void Promise.resolve(addTask(task)).catch(() => undefined);
  return true;
}

export async function persistArrivalPriorityDrag({
  itemId,
  title,
  originalPosition,
  nextPosition,
  focusCount,
  nextFocusCount,
  onMoveToPosition,
  onFocusCountChange,
}: {
  itemId: string;
  title: string;
  originalPosition: number;
  nextPosition: number;
  focusCount: 1 | 2 | 3;
  nextFocusCount: 1 | 2 | 3;
  onMoveToPosition: (itemId: string, position: number, title: string) => void | Promise<void>;
  onFocusCountChange: (count: 1 | 2 | 3) => void | Promise<void>;
}) {
  const moved = nextPosition !== originalPosition;
  if (moved) await onMoveToPosition(itemId, nextPosition, title);
  try {
    if (nextFocusCount !== focusCount) await onFocusCountChange(nextFocusCount);
  } catch (error) {
    if (moved) await onMoveToPosition(itemId, originalPosition, title);
    throw error;
  }
}

function ArrivalDropBucket({
  id,
  label,
  dragActive,
  children,
}: {
  id: string;
  label: string;
  dragActive: boolean;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      aria-label={`${label} drop area`}
      className={`min-h-[134px] rounded-[20px] border-2 p-2 transition-[border-color,background-color,box-shadow] duration-150 ${
        isOver
          ? 'border-accent-blue/70 bg-accent-blue/[0.07] shadow-[0_0_0_4px_rgb(90_141_238_/_0.12)]'
          : dragActive
            ? 'border-dashed border-muted-foreground/35 bg-muted/15'
            : 'border-transparent'
      }`}
    >
      {children}
    </div>
  );
}

function KeyboardDragHandle({
  title,
  disabled,
  attributes,
  setActivatorNodeRef,
  onKeyDown,
}: {
  title: string;
  disabled: boolean;
  attributes: ReturnType<typeof useDraggable>['attributes'];
  setActivatorNodeRef: ReturnType<typeof useDraggable>['setActivatorNodeRef'];
  onKeyDown?: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      ref={setActivatorNodeRef}
      type="button"
      {...attributes}
      aria-label={`Drag ${title}`}
      disabled={disabled}
      className="pointer-events-none absolute bottom-2 right-2 z-20 grid size-8 translate-y-1 place-items-center rounded-full border bg-card text-sm text-muted-foreground opacity-0 shadow-sm outline-none transition-[opacity,transform] duration-150 focus-visible:pointer-events-auto focus-visible:translate-y-0 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent-blue/40 disabled:opacity-0"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        onKeyDown?.(event);
      }}
    >
      <span aria-hidden="true">⠿</span>
    </button>
  );
}

function CompletionButton({
  title,
  busy,
  inverted = false,
  onComplete,
}: {
  title: string;
  busy: boolean;
  inverted?: boolean;
  onComplete: () => void | Promise<void>;
}) {
  return (
    <button
      type="button"
      aria-label={`Mark ${title} complete`}
      title="Mark complete"
      disabled={busy}
      className={`press-scale absolute right-2.5 top-2.5 z-20 grid size-8 place-items-center rounded-full border opacity-0 outline-none transition-[opacity,border-color,background-color,color] duration-150 focus-visible:opacity-100 focus-visible:ring-2 group-hover:opacity-100 disabled:opacity-0 ${
        inverted
          ? 'border-white/20 bg-white/10 text-white/75 hover:border-white/45 hover:bg-white/15 hover:text-white focus-visible:ring-white/35'
          : 'border-border bg-card text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground focus-visible:ring-accent-blue/40'
      }`}
      onClick={(event) => {
        event.stopPropagation();
        void Promise.resolve(onComplete()).catch(() => undefined);
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="none">
        <path d="m3.25 8.1 2.85 2.85 6.65-6.65" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

function FocusCard({
  view,
  focusNumber,
  busy,
  onOpen,
  onComplete,
}: {
  view: MorningArrivalItem;
  focusNumber: number;
  busy: boolean;
  onOpen: (trigger: HTMLElement) => void;
  onComplete: () => void | Promise<void>;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    isDragging,
  } = useDraggable({ id: `today:${view.item.id}`, disabled: busy });
  const suppressClickRef = useRef(false);
  const preview = firstPreview(view.summary, view.whyToday, view.description);

  useEffect(() => {
    if (isDragging) {
      suppressClickRef.current = true;
      return;
    }
    if (!suppressClickRef.current) return;
    const timeout = window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [isDragging]);

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={isDragging ? 'group relative z-30 h-full opacity-80' : 'group relative h-full'}
    >
      <article
        role="button"
        tabIndex={busy ? -1 : 0}
        aria-label={`Focus ${focusNumber}: ${view.title}`}
        aria-haspopup="dialog"
        aria-disabled={busy}
        className="relative flex h-full min-h-[134px] cursor-pointer flex-col rounded-[20px] border border-white/10 bg-[linear-gradient(160deg,#33302b_0%,#2a2724_70%)] px-[22px] pb-[18px] pt-5 text-left shadow-lg outline-none transition-[transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:shadow-2xl focus-visible:ring-2 focus-visible:ring-accent-blue/70 active:translate-y-0 active:shadow-md motion-reduce:transform-none dark:border-white/15 dark:bg-[linear-gradient(160deg,#262320_0%,#1d1b19_70%)]"
        onPointerDown={(event) => listeners?.onPointerDown?.(event)}
        onTouchStart={(event) => listeners?.onTouchStart?.(event)}
        onClick={(event) => {
          if (busy || suppressClickRef.current) return;
          onOpen(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (!busy) cardKeyDown(event, onOpen);
        }}
      >
        <span className="mb-3.5 grid size-6 place-items-center rounded-full bg-white/10 text-xs font-semibold text-white/70">
          {focusNumber}
        </span>
        <h3 className="line-clamp-3 text-[15.5px] font-medium leading-[1.42] tracking-[-0.004em] text-white/95">
          {view.title}
        </h3>
        {view.item.commitment === 'pencil' && (
          <p className="mt-2 text-xs opacity-70">Proposed, awaiting your acceptance</p>
        )}
        {view.item.planningState && view.item.planningState !== 'ready' && (
          <p className="mt-2 text-xs opacity-70">
            {view.item.planningState === 'resolved'
              ? 'Source closed or changed. Review before starting.'
              : view.item.planningState}
          </p>
        )}
        <p
          className="mt-auto truncate pt-3.5 text-xs leading-[1.4] text-white/60"
          aria-hidden={preview ? undefined : true}
        >
          {preview ?? '\u00a0'}
        </p>
      </article>
      <CompletionButton title={view.title} busy={busy || view.item.commitment === 'pencil' || view.item.planningState === 'resolved'} inverted onComplete={onComplete} />
      <KeyboardDragHandle
        title={view.title}
        disabled={busy}
        attributes={attributes}
        setActivatorNodeRef={setActivatorNodeRef}
        onKeyDown={(event) => listeners?.onKeyDown?.(event)}
      />
    </li>
  );
}

function AlsoTodayCard({
  view,
  busy,
  onOpen,
  onComplete,
}: {
  view: MorningArrivalItem;
  busy: boolean;
  onOpen: (trigger: HTMLElement) => void;
  onComplete: () => void | Promise<void>;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    isDragging,
  } = useDraggable({ id: `today:${view.item.id}`, disabled: busy });
  const suppressClickRef = useRef(false);

  useEffect(() => {
    if (isDragging) {
      suppressClickRef.current = true;
      return;
    }
    if (!suppressClickRef.current) return;
    const timeout = window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [isDragging]);

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={isDragging ? 'group relative z-30 h-full opacity-80' : 'group relative h-full'}
    >
      <article
        role="button"
        tabIndex={busy ? -1 : 0}
        aria-label={`Today: ${view.title}`}
        aria-haspopup="dialog"
        aria-disabled={busy}
        className="relative flex h-full min-h-24 cursor-pointer flex-col items-start rounded-[14px] border bg-background px-[18px] py-4 text-left outline-none transition-[transform,box-shadow,background-color,border-color] duration-150 hover:-translate-y-0.5 hover:border-muted-foreground/40 hover:bg-card hover:shadow-lg focus-visible:ring-2 focus-visible:ring-accent-blue/40 active:translate-y-0 active:shadow-sm motion-reduce:transform-none dark:bg-muted/35 dark:hover:bg-muted/70"
        onPointerDown={(event) => listeners?.onPointerDown?.(event)}
        onTouchStart={(event) => listeners?.onTouchStart?.(event)}
        onClick={(event) => {
          if (busy || suppressClickRef.current) return;
          onOpen(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (!busy) cardKeyDown(event, onOpen);
        }}
      >
        <span className={TODAY_TAG_CLASS}>Today</span>
        <h3 className="line-clamp-2 min-w-0 pr-6 text-[13.5px] font-medium leading-[1.4] tracking-[-0.004em] text-foreground/80 dark:text-foreground/90">
          {view.title}
        </h3>
        {view.item.commitment === 'pencil' && (
          <p className="mt-2 text-xs opacity-70">Proposed, awaiting your acceptance</p>
        )}
        {view.item.planningState && view.item.planningState !== 'ready' && (
          <p className="mt-2 text-xs opacity-70">
            {view.item.planningState === 'resolved'
              ? 'Source closed or changed. Review before starting.'
              : view.item.planningState}
          </p>
        )}
      </article>
      <CompletionButton title={view.title} busy={busy || view.item.commitment === 'pencil' || view.item.planningState === 'resolved'} onComplete={onComplete} />
      <KeyboardDragHandle
        title={view.title}
        disabled={busy}
        attributes={attributes}
        setActivatorNodeRef={setActivatorNodeRef}
        onKeyDown={(event) => listeners?.onKeyDown?.(event)}
      />
    </li>
  );
}

function BenchCard({
  task,
  busy,
  onOpen,
  onComplete,
}: {
  task: MorningArrivalBoardTask;
  busy: boolean;
  onOpen: (trigger: HTMLElement) => void;
  onComplete: () => void | Promise<void>;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    isDragging,
  } = useDraggable({ id: `not-today:${task.id}`, disabled: busy });
  const suppressClickRef = useRef(false);

  useEffect(() => {
    if (isDragging) {
      suppressClickRef.current = true;
      return;
    }
    if (!suppressClickRef.current) return;
    const timeout = window.setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [isDragging]);

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={isDragging ? 'group relative z-30 h-full opacity-75' : 'group relative h-full'}
    >
      <article
        role="button"
        tabIndex={busy ? -1 : 0}
        aria-label={task.title}
        aria-haspopup="dialog"
        aria-disabled={busy}
        className="relative flex h-full min-h-24 cursor-pointer items-start rounded-[14px] border bg-background px-[18px] py-4 text-left outline-none transition-[transform,box-shadow,background-color,border-color] duration-150 hover:-translate-y-0.5 hover:border-muted-foreground/40 hover:bg-card hover:shadow-lg focus-visible:ring-2 focus-visible:ring-accent-blue/40 active:translate-y-0 active:shadow-sm motion-reduce:transform-none dark:bg-muted/35 dark:hover:bg-muted/70"
        onPointerDown={(event) => listeners?.onPointerDown?.(event)}
        onTouchStart={(event) => listeners?.onTouchStart?.(event)}
        onClick={(event) => {
          if (busy || suppressClickRef.current) return;
          onOpen(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (!busy) cardKeyDown(event, onOpen);
        }}
      >
        <h3 className="line-clamp-3 min-w-0 pr-6 text-[13.5px] font-medium leading-[1.4] tracking-[-0.004em] text-foreground/80 dark:text-foreground/90">
          {task.title}
        </h3>
      </article>
      <CompletionButton title={task.title} busy={busy} onComplete={onComplete} />
      <KeyboardDragHandle
        title={task.title}
        disabled={busy}
        attributes={attributes}
        setActivatorNodeRef={setActivatorNodeRef}
        onKeyDown={(event) => listeners?.onKeyDown?.(event)}
      />
    </li>
  );
}

export default function ArrivalPlanGrid({
  localDate,
  todayItems,
  notTodayTasks,
  tasksById,
  focusCount,
  busy,
  completingTaskId,
  escapeRef,
  onInteract,
  onOwnerChange,
  onMoveToPosition,
  onFocusCountChange,
  onRemove,
  onComplete,
  onCompleteBoardTask,
  onAddTask,
  onSaveTask,
}: {
  localDate: string;
  todayItems: MorningArrivalItem[];
  notTodayTasks: MorningArrivalBoardTask[];
  tasksById: ReadonlyMap<string, Task>;
  focusCount: 1 | 2 | 3;
  busy: boolean;
  completingTaskId?: string | null;
  escapeRef?: RefObject<(() => void) | null>;
  onInteract?: () => void;
  onOwnerChange: MorningArrivalProps['onOwnerChange'];
  onMoveToPosition: MorningArrivalProps['onMoveToPosition'];
  onFocusCountChange: MorningArrivalProps['onFocusCountChange'];
  onRemove: MorningArrivalProps['onRemove'];
  onComplete: MorningArrivalProps['onComplete'];
  onCompleteBoardTask: MorningArrivalProps['onCompleteBoardTask'];
  onAddTask: MorningArrivalProps['onAddTask'];
  onSaveTask: MorningArrivalProps['onSaveTask'];
}) {
  const [openSheet, setOpenSheet] = useState<OpenTaskSheet>();
  const [expanded, setExpanded] = useState(false);
  const [dropNote, setDropNote] = useState<string>();
  const [activeDragId, setActiveDragId] = useState<string>();
  const pendingAddIdsRef = useRef(new Set<string>());
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 3 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 140, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );
  const orderedToday = useMemo(
    () => [...todayItems].sort((left, right) => left.item.position - right.item.position),
    [todayItems],
  );
  const focusViews = orderedToday.slice(0, focusCount);
  const alsoTodayViews = orderedToday.slice(focusCount);
  const visibleFocusCount = Math.max(1, focusViews.length);
  const focusGridClass = visibleFocusCount === 1
    ? 'sm:grid-cols-1'
    : visibleFocusCount === 2
      ? 'sm:grid-cols-2'
      : 'sm:grid-cols-3';
  const boardTasks = expanded ? notTodayTasks : notTodayTasks.slice(0, BOARD_TASK_LIMIT);
  const hiddenTaskCount = Math.max(0, notTodayTasks.length - BOARD_TASK_LIMIT);
  const allWorkTileLabel = expanded ? 'Show fewer' : `${hiddenTaskCount} more in All Work`;

  useEffect(() => {
    let restored = false;
    try {
      restored = window.localStorage.getItem(`${EXPANSION_KEY_PREFIX}${localDate}`) === '1';
    } catch {
      restored = false;
    }
    // Restore the operator's saved expansion choice when the ritual day changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExpanded(restored);
  }, [localDate]);

  useEffect(() => {
    const todayTaskIds = new Set(orderedToday.map((view) => view.item.taskId));
    for (const taskId of pendingAddIdsRef.current) {
      if (todayTaskIds.has(taskId)) pendingAddIdsRef.current.delete(taskId);
    }
  }, [orderedToday]);

  useEffect(() => {
    if (!escapeRef) return;
    escapeRef.current = openSheet ? () => setOpenSheet(undefined) : null;
    return () => {
      escapeRef.current = null;
    };
  }, [escapeRef, openSheet]);

  function toggleExpanded() {
    onInteract?.();
    const next = !expanded;
    try {
      const key = `${EXPANSION_KEY_PREFIX}${localDate}`;
      if (next) window.localStorage.setItem(key, '1');
      else window.localStorage.removeItem(key);
    } catch {
      // Expansion still works for this session when storage is unavailable.
    }
    setExpanded(next);
  }

  async function addTask(task: MorningArrivalBoardTask) {
    onInteract?.();
    if (pendingAddIdsRef.current.has(task.id)) return true;
    setDropNote(undefined);
    pendingAddIdsRef.current.add(task.id);
    try {
      const result = await onAddTask(task.id, task.title);
      return result ?? true;
    } catch (error) {
      pendingAddIdsRef.current.delete(task.id);
      throw error;
    }
  }

  async function applyDragEnd(event: DragEndEvent) {
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : undefined;
    if (!overId) return;
    onInteract?.();
    setDropNote(undefined);

    // What this drop does is decided in one place, so the note here and the
    // announcement a screen reader hears cannot disagree.
    const outcome = arrivalDropOutcome(readDrop(activeId, overId));
    if (outcome.kind === 'refused') {
      setDropNote(outcome.note);
      return;
    }
    if (outcome.kind === 'unchanged') return;

    if (activeId.startsWith('not-today:')) {
      const task = notTodayTasks.find((candidate) => candidate.id === activeId.slice(10));
      if (!task) return;
      const result = await addTask(task);
      if (!result || overId !== INITIAL_PRIORITY_ZONE_ID || typeof result === 'boolean') return;
      const addedItem = result.plan.items.find((item) => item.taskId === task.id);
      if (!addedItem) return;
      const originalPosition = result.plan.items
        .filter((item) => item.decision === 'pending' || item.decision === 'preselected' || item.decision === 'accepted')
        .sort((left, right) => left.position - right.position)
        .findIndex((item) => item.id === addedItem.id);
      if (originalPosition < 0) return;
      try {
        await persistArrivalPriorityDrag({
          itemId: addedItem.id,
          title: task.title,
          originalPosition,
          nextPosition: focusCount,
          focusCount,
          nextFocusCount: (focusCount + 1) as 2 | 3,
          onMoveToPosition,
          onFocusCountChange,
        });
      } catch (error) {
        try {
          await onRemove(addedItem.id, task.title, true);
        } catch {
          // Preserve the original promotion failure. The normal surface error
          // still reports any rollback failure from the queued mutation path.
        }
        throw error;
      }
      return;
    }
    if (!activeId.startsWith('today:')) return;

    const activeItemId = activeId.slice(6);
    const activeView = orderedToday.find((view) => view.item.id === activeItemId);
    const originalPosition = orderedToday.findIndex((view) => view.item.id === activeItemId);
    if (!activeView || originalPosition < 0) return;
    const startedInFocus = originalPosition < focusCount;

    if (overId === NOT_TODAY_ZONE_ID) {
      const nextFocusCount = startedInFocus && focusCount > 1
        ? ((focusCount - 1) as 1 | 2) : focusCount;
      if (nextFocusCount !== focusCount) await onFocusCountChange(nextFocusCount);
      try {
        await onRemove(
          activeItemId,
          activeView.title,
          Boolean(activeView.task) || activeView.item.sourceRefs.some(
            (source) => source.sourceType === 'task' && source.recordId === activeView.item.taskId,
          ),
        );
      } catch (error) {
        if (nextFocusCount !== focusCount) await onFocusCountChange(focusCount);
        throw error;
      }
      return;
    }

    if (overId === INITIAL_PRIORITY_ZONE_ID) {
      await persistArrivalPriorityDrag({
        itemId: activeItemId,
        title: activeView.title,
        originalPosition,
        nextPosition: focusCount,
        focusCount,
        nextFocusCount: (focusCount + 1) as 2 | 3,
        onMoveToPosition,
        onFocusCountChange,
      });
      return;
    }

    if (overId !== ALSO_TODAY_ZONE_ID) return;

    await persistArrivalPriorityDrag({
      itemId: activeItemId,
      title: activeView.title,
      originalPosition,
      nextPosition: orderedToday.length - 1,
      focusCount,
      nextFocusCount: (focusCount - 1) as 1 | 2,
      onMoveToPosition,
      onFocusCountChange,
    });
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDragId(undefined);
    void applyDragEnd(event).catch(() => undefined);
  }

  // The one description of a drop, read by the spoken announcement and by the
  // handler that carries it out, so the two can never tell different stories.
  const readDrop = useCallback((activeId: string, overId: string | undefined) => {
    const origin = activeId.startsWith('not-today:') ? 'not-today' as const : 'today' as const;
    const position = origin === 'today'
      ? orderedToday.findIndex((view) => view.item.id === activeId.slice(6))
      : -1;
    return {
      origin,
      startedInFocus: position >= 0 && position < focusCount,
      over: overId ? DROP_ZONES[overId] : undefined,
      focusCount,
    };
  }, [orderedToday, focusCount]);

  const dragAccessibility = useMemo(() => {
    const itemLabel = (id: string | number) => {
      const value = String(id);
      if (value.startsWith('today:')) {
        return orderedToday.find((view) => view.item.id === value.slice(6))?.title ?? 'Today task';
      }
      if (value.startsWith('not-today:')) {
        return notTodayTasks.find((task) => task.id === value.slice(10))?.title ?? 'Not today task';
      }
      return 'Task';
    };
    const bucketLabel = (id: string | number | undefined) => {
      if (id === INITIAL_PRIORITY_ZONE_ID) return 'Initial priorities';
      if (id === ALSO_TODAY_ZONE_ID) return 'Also today';
      if (id === NOT_TODAY_ZONE_ID) return 'Not today';
      return undefined;
    };
    const announcements: Announcements = {
      onDragStart: ({ active }) =>
        `Picked up ${itemLabel(active.id)}. Move to Initial priorities, Also today, or Not today.`,
      onDragOver: ({ active, over }) => {
        const bucket = bucketLabel(over?.id);
        return bucket ? `${itemLabel(active.id)} is over ${bucket}.` : undefined;
      },
      onDragEnd: ({ active, over }) => {
        const outcome = arrivalDropOutcome(readDrop(String(active.id), over ? String(over.id) : undefined));
        if (outcome.kind === 'moved') return `Dropped ${itemLabel(active.id)} in ${ZONE_LABELS[outcome.zone]}.`;
        if (outcome.kind === 'refused') return outcome.note;
        return `${itemLabel(active.id)} was not moved.`;
      },
      onDragCancel: ({ active }) => `Stopped moving ${itemLabel(active.id)}.`,
    };
    const screenReaderInstructions: ScreenReaderInstructions = {
      draggable: 'Press Space to pick up a task. Use the arrow keys to choose a section, then press Space again to drop it. Press Escape to cancel.',
    };
    return { announcements, screenReaderInstructions };
  }, [notTodayTasks, orderedToday, readDrop]);

  return (
    <section className="w-full px-6 pb-2 pt-10 sm:px-10 lg:px-16 lg:pt-11" aria-label="Plan your day">
      <DndContext
        sensors={sensors}
        accessibility={dragAccessibility}
        collisionDetection={bucketCollisionDetection}
        onDragStart={(event) => {
          setActiveDragId(String(event.active.id));
          setDropNote(undefined);
          onInteract?.();
        }}
        onDragCancel={() => setActiveDragId(undefined)}
        onDragEnd={handleDragEnd}
      >
          <section aria-labelledby="arrival-initial-priorities-title">
            <h2
              id="arrival-initial-priorities-title"
              className="mb-[18px] text-[10.5px] font-semibold uppercase tracking-[0.24em] text-muted-foreground"
            >
            Initial priorities
          </h2>
            <ArrivalDropBucket
              id={INITIAL_PRIORITY_ZONE_ID}
              label="Initial priorities"
              dragActive={Boolean(activeDragId)}
            >
              <ol className={`grid grid-cols-1 gap-[18px] ${focusGridClass}`}>
                {focusViews.map((view, index) => (
                  <FocusCard
                    key={view.item.id}
                    view={view}
                    focusNumber={index + 1}
                    busy={busy}
                    onComplete={() => onComplete(view.item.id, view.title)}
                    onOpen={(returnFocus) => {
                      onInteract?.();
                      setOpenSheet({
                        returnFocus,
                        detail: { kind: 'today', view, focusNumber: index + 1 },
                      });
                    }}
                  />
                ))}
                {focusViews.length === 0 && (
                  <li className="flex min-h-24 items-center px-2 text-[13px] leading-relaxed text-muted-foreground">
                    Drop tasks here to make them an initial priority.
                  </li>
                )}
              </ol>
            </ArrivalDropBucket>
          </section>

          <section className="mt-12" aria-labelledby="arrival-also-today-title">
              <h2
                id="arrival-also-today-title"
                className="mb-[18px] text-[10.5px] font-semibold uppercase tracking-[0.24em] text-muted-foreground"
              >
            Also today
          </h2>
            <ArrivalDropBucket
              id={ALSO_TODAY_ZONE_ID}
              label="Also today"
              dragActive={Boolean(activeDragId)}
            >
              <ol className="grid min-h-24 grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
                {alsoTodayViews.map((view) => (
                  <AlsoTodayCard
                    key={view.item.id}
                    view={view}
                    busy={busy}
                    onComplete={() => onComplete(view.item.id, view.title)}
                    onOpen={(returnFocus) => {
                      onInteract?.();
                      setOpenSheet({ returnFocus, detail: { kind: 'today', view } });
                    }}
                  />
                ))}
                {alsoTodayViews.length === 0 && (
                  <li className="flex min-h-24 items-center px-2 text-[13px] leading-relaxed text-muted-foreground">
                  Drop tasks here to keep them in Today without making them an initial priority.
                </li>
                )}
              </ol>
            </ArrivalDropBucket>
            </section>

        <section className="mt-12" aria-labelledby="arrival-not-today-title">
          <h2
            id="arrival-not-today-title"
            className="mb-[18px] text-[10.5px] font-semibold uppercase tracking-[0.24em] text-muted-foreground"
          >
            Not today
          </h2>
          <ArrivalDropBucket
            id={NOT_TODAY_ZONE_ID}
            label="Not today"
            dragActive={Boolean(activeDragId)}
          >
          <ul className="grid min-h-24 grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
            {boardTasks.map((task) => (
              <BenchCard
                key={task.id}
                task={task}
                busy={busy || completingTaskId === task.id}
                onOpen={(returnFocus) => {
                  onInteract?.();
                  setOpenSheet({ returnFocus, detail: { kind: 'bench', task } });
                }}
                onComplete={() => onCompleteBoardTask(task.id, task.title)}
              />
            ))}
            {boardTasks.length === 0 && (
              <li className="flex min-h-24 items-center text-[13px] leading-relaxed text-muted-foreground">
                  No other open tasks are ready to plan.
                </li>
            )}
            {hiddenTaskCount > 0 && (
              <li className="h-full">
                <button
                  type="button"
                  className="press-scale flex h-full min-h-24 w-full flex-col items-center justify-center gap-1.5 rounded-[14px] border border-dashed bg-transparent px-[18px] py-4 text-[13px] font-medium text-muted-foreground outline-none transition-[transform,box-shadow,color,border-color] duration-150 hover:-translate-y-0.5 hover:border-muted-foreground/50 hover:text-foreground hover:shadow-md focus-visible:ring-2 focus-visible:ring-accent-blue/40 active:translate-y-0 active:shadow-sm motion-reduce:transform-none"
                  aria-label={allWorkTileLabel}
                  aria-expanded={expanded}
                  onClick={toggleExpanded}
                >
                  <span className="text-[17px] leading-none" aria-hidden="true">
                    {expanded ? '−' : '＋'}
                  </span>
                  <span>{allWorkTileLabel}</span>
                </button>
              </li>
            )}
          </ul>
          </ArrivalDropBucket>
        </section>
      </DndContext>

      {/* Deliberately not a live region. dropNote is only ever set from the
          drop handler, and the drag library's own announcement returns the
          same refusal sentence from onDragEnd, so marking this one up as
          well had a screen reader read "Initial priorities are full at
          three" twice for one drop. This paragraph is what a sighted person
          reads; the assertive region is what a screen reader hears. */}
      {dropNote && (
        <p className="mt-3 text-xs text-muted-foreground">
          {dropNote}
        </p>
      )}

      {openSheet && (
        <TaskSheet
          detail={openSheet.detail}
          busy={busy}
          returnFocus={openSheet.returnFocus}
          onClose={() => setOpenSheet(undefined)}
          onOwnerChange={onOwnerChange}
          onRemove={onRemove}
          onComplete={onComplete}
          onAdd={async (task) => Boolean(await addTask(task))}
          onSaveTask={onSaveTask}
          tasksById={tasksById}
        />
      )}
    </section>
  );
}
