'use client';

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useDraggable,
  useDroppable,
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
import type { MorningArrivalBoardTask, MorningArrivalItem, MorningArrivalProps } from '../MorningArrival';
import AllWorkPicker, { TODAY_TAG_CLASS } from './AllWorkPicker';
import TaskSheet, { type TaskSheetDetail } from './TaskSheet';

const TODAY_ZONE_ID = 'arrival-today-zone';
const BOARD_TASK_LIMIT = 7;

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
      className="pointer-events-none absolute right-2 top-2 z-20 grid size-8 -translate-y-1 place-items-center rounded-full border bg-card text-sm text-muted-foreground opacity-0 shadow-sm outline-none transition-[opacity,transform] duration-150 focus-visible:pointer-events-auto focus-visible:translate-y-0 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent-blue/40 disabled:opacity-0"
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

function FocusCard({
  view,
  focusNumber,
  busy,
  onOpen,
}: {
  view: MorningArrivalItem;
  focusNumber: number;
  busy: boolean;
  onOpen: (trigger: HTMLElement) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `today:${view.item.id}`, disabled: busy });
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
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={isDragging ? 'relative z-30 h-full opacity-80' : 'relative h-full'}
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
        <p
          className="mt-auto truncate pt-3.5 text-xs leading-[1.4] text-white/60"
          aria-hidden={preview ? undefined : true}
        >
          {preview ?? '\u00a0'}
        </p>
      </article>
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
}: {
  view: MorningArrivalItem;
  busy: boolean;
  onOpen: (trigger: HTMLElement) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: `today:${view.item.id}`, disabled: busy });
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
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={isDragging ? 'relative z-30 h-full opacity-80' : 'relative h-full'}
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
      </article>
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
  onAdd,
}: {
  task: MorningArrivalBoardTask;
  busy: boolean;
  onOpen: (trigger: HTMLElement) => void;
  onAdd: () => void;
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
      <button
        type="button"
        aria-label={`Add ${task.title} to today`}
        disabled={busy}
        className="press-scale absolute right-2.5 top-2.5 grid size-[26px] place-items-center rounded-full border bg-card text-[13px] text-muted-foreground opacity-0 outline-none transition-opacity duration-150 hover:border-muted-foreground/50 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent-blue/40 group-hover:opacity-100 disabled:opacity-0"
        onClick={onAdd}
      >
        <span aria-hidden="true">↑</span>
      </button>
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
  todayItems,
  notTodayTasks,
  busy,
  escapeRef,
  onInteract,
  onOwnerChange,
  onDragReorder,
  onRemove,
  onComplete,
  onAddTask,
}: {
  todayItems: MorningArrivalItem[];
  notTodayTasks: MorningArrivalBoardTask[];
  busy: boolean;
  escapeRef?: RefObject<(() => void) | null>;
  onInteract?: () => void;
  onOwnerChange: MorningArrivalProps['onOwnerChange'];
  onDragReorder: MorningArrivalProps['onDragReorder'];
  onRemove: MorningArrivalProps['onRemove'];
  onComplete: MorningArrivalProps['onComplete'];
  onAddTask: MorningArrivalProps['onAddTask'];
}) {
  const [openSheet, setOpenSheet] = useState<OpenTaskSheet>();
  const [pickerTrigger, setPickerTrigger] = useState<HTMLElement | null>(null);
  const [capacityNote, setCapacityNote] = useState(false);
  const pendingAddIdsRef = useRef(new Set<string>());
  const { setNodeRef, isOver } = useDroppable({ id: TODAY_ZONE_ID });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const orderedToday = useMemo(
    () => [...todayItems].sort((left, right) => left.item.position - right.item.position),
    [todayItems],
  );
  const focusViews = orderedToday.slice(0, 3);
  const alsoTodayViews = orderedToday.slice(3);
  const boardTasks = notTodayTasks.slice(0, BOARD_TASK_LIMIT);
  const hiddenTaskCount = Math.max(0, notTodayTasks.length - boardTasks.length);
  const allWorkTileLabel = hiddenTaskCount > 0
    ? `${hiddenTaskCount} more in All Work`
    : 'Browse All Work';

  useEffect(() => {
    const todayTaskIds = new Set(orderedToday.map((view) => view.item.taskId));
    for (const taskId of pendingAddIdsRef.current) {
      if (todayTaskIds.has(taskId)) pendingAddIdsRef.current.delete(taskId);
    }
  }, [orderedToday]);

  useEffect(() => {
    if (!escapeRef) return;
    escapeRef.current = openSheet
      ? () => setOpenSheet(undefined)
      : pickerTrigger
        ? () => setPickerTrigger(null)
        : null;
    return () => {
      escapeRef.current = null;
    };
  }, [escapeRef, openSheet, pickerTrigger]);

  async function addTask(task: MorningArrivalBoardTask) {
    onInteract?.();
    if (pendingAddIdsRef.current.has(task.id)) return true;
    if (orderedToday.length + pendingAddIdsRef.current.size >= 10) {
      setCapacityNote(true);
      return false;
    }
    setCapacityNote(false);
    pendingAddIdsRef.current.add(task.id);
    try {
      await onAddTask(task.id, task.title);
      return true;
    } catch (error) {
      pendingAddIdsRef.current.delete(task.id);
      throw error;
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : undefined;
    if (!overId) return;
    onInteract?.();
    if (activeId.startsWith('not-today:')) {
      if (overId !== TODAY_ZONE_ID && !overId.startsWith('today:')) return;
      const task = notTodayTasks.find((candidate) => candidate.id === activeId.slice(10));
      if (task) void addTask(task).catch(() => undefined);
      return;
    }
    if (!activeId.startsWith('today:') || !overId.startsWith('today:')) return;
    if (activeId === overId) return;
    void onDragReorder(activeId.slice(6), overId.slice(6));
  }

  return (
    <section className="w-full px-6 pb-2 pt-10 sm:px-10 lg:px-16 lg:pt-11" aria-label="Plan your day">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={() => onInteract?.()}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={orderedToday.map((view) => `today:${view.item.id}`)}
          strategy={rectSortingStrategy}
        >
          <section aria-label="Today focus">
            <div
              ref={setNodeRef}
              className={`min-h-[134px] rounded-[20px] outline outline-2 outline-offset-4 transition-colors duration-150 ${
                isOver ? 'outline-accent-blue/50' : 'outline-transparent'
              }`}
            >
              <ol className="grid grid-cols-1 gap-[18px] sm:grid-cols-3">
                {focusViews.map((view, index) => (
                  <FocusCard
                    key={view.item.id}
                    view={view}
                    focusNumber={index + 1}
                    busy={busy}
                    onOpen={(returnFocus) => {
                      onInteract?.();
                      setOpenSheet({
                        returnFocus,
                        detail: { kind: 'today', view, focusNumber: index + 1 },
                      });
                    }}
                  />
                ))}
              </ol>
            </div>
          </section>

          {alsoTodayViews.length > 0 && (
            <section className="mt-12" aria-labelledby="arrival-also-today-title">
              <h2
                id="arrival-also-today-title"
                className="mb-[18px] text-[10.5px] font-semibold uppercase tracking-[0.24em] text-muted-foreground"
              >
                Also today
              </h2>
              <ol className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
                {alsoTodayViews.map((view) => (
                  <AlsoTodayCard
                    key={view.item.id}
                    view={view}
                    busy={busy}
                    onOpen={(returnFocus) => {
                      onInteract?.();
                      setOpenSheet({ returnFocus, detail: { kind: 'today', view } });
                    }}
                  />
                ))}
              </ol>
            </section>
          )}
        </SortableContext>

        <section className="mt-12" aria-labelledby="arrival-not-today-title">
          <h2
            id="arrival-not-today-title"
            className="mb-[18px] text-[10.5px] font-semibold uppercase tracking-[0.24em] text-muted-foreground"
          >
            Not today
          </h2>
          <ul className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
            {boardTasks.map((task) => (
              <BenchCard
                key={task.id}
                task={task}
                busy={busy}
                onOpen={(returnFocus) => {
                  onInteract?.();
                  setOpenSheet({ returnFocus, detail: { kind: 'bench', task } });
                }}
                onAdd={() => void addTask(task).catch(() => undefined)}
              />
            ))}
            {boardTasks.length === 0 && (
              <li className="flex min-h-24 items-center text-[13px] leading-relaxed text-muted-foreground">
                No other open tasks are ready to plan.
              </li>
            )}
            <li className="h-full">
              <button
                type="button"
                className="press-scale flex h-full min-h-24 w-full flex-col items-center justify-center gap-1.5 rounded-[14px] border border-dashed bg-transparent px-[18px] py-4 text-[13px] font-medium text-muted-foreground outline-none transition-[transform,box-shadow,color,border-color] duration-150 hover:-translate-y-0.5 hover:border-muted-foreground/50 hover:text-foreground hover:shadow-md focus-visible:ring-2 focus-visible:ring-accent-blue/40 active:translate-y-0 active:shadow-sm motion-reduce:transform-none"
                aria-label={allWorkTileLabel}
                aria-haspopup="dialog"
                onClick={(event) => {
                  onInteract?.();
                  setPickerTrigger(event.currentTarget);
                }}
              >
                <span className="text-[17px] leading-none" aria-hidden="true">＋</span>
                <span>{allWorkTileLabel}</span>
              </button>
            </li>
          </ul>
        </section>
      </DndContext>

      {capacityNote && (
        <p role="status" className="mt-3 text-xs text-muted-foreground">
          Today is full at 10. Move one task down before adding another.
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
          onAdd={addTask}
        />
      )}
      {pickerTrigger && (
        <AllWorkPicker
          todayItems={orderedToday}
          boardTasks={notTodayTasks}
          busy={busy}
          returnFocus={pickerTrigger}
          onAdd={addTask}
          onClose={() => setPickerTrigger(null)}
        />
      )}
    </section>
  );
}
