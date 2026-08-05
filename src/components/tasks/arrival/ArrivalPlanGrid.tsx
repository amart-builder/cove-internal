'use client';

import { useEffect, useMemo, useState } from 'react';
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
import { focusBandItems } from '@/lib/day-plan/presentation';
import type { MorningArrivalBoardTask, MorningArrivalItem, MorningArrivalProps } from '../MorningArrival';
import OwnerChip, { type OwnerChipEscapeHandler } from './OwnerChip';

const TODAY_ZONE_ID = 'arrival-today-zone';
const CARD_SHELL_CLASS = 'relative flex h-[124px] flex-col rounded-xl border p-[14px] shadow-sm';

type Detail = {
  title: string;
  description?: string;
  project?: string;
  due?: string;
};

function firstPreview(...values: Array<string | undefined>) {
  return values.find((value) => value?.trim())?.trim();
}

function TodayCard({
  view,
  focusNumber,
  busy,
  onOpen,
  onOwnerChange,
  onComplete,
  onRemove,
  onOwnerChipOpen,
  onOwnerChipClose,
}: {
  view: MorningArrivalItem;
  focusNumber?: number;
  busy: boolean;
  onOpen: () => void;
  onOwnerChange: MorningArrivalProps['onOwnerChange'];
  onComplete: MorningArrivalProps['onComplete'];
  onRemove: MorningArrivalProps['onRemove'];
  onOwnerChipOpen: (handler: OwnerChipEscapeHandler) => void;
  onOwnerChipClose: (itemId: string) => void;
}) {
  const sortableId = `today:${view.item.id}`;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sortableId, disabled: busy });
  const isFocus = focusNumber !== undefined;
  const preview = firstPreview(view.summary, view.whyToday, view.description);
  const controlTone = isFocus
    ? 'border-background/20 text-background/55 hover:text-background focus-visible:text-background'
    : 'border-border text-muted-foreground hover:text-foreground focus-visible:text-foreground';

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={isDragging ? 'relative z-10 opacity-75' : ''}
    >
      <article
        className={`${CARD_SHELL_CLASS} ${
          isFocus
            ? 'border-foreground/10 bg-foreground text-background'
            : 'border-foreground/10 bg-card text-foreground'
        }`}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('button, a, [data-card-control]')) return;
          onOpen();
        }}
      >
        <div className="absolute right-2.5 top-2.5 flex items-center gap-1">
          <button
            type="button"
            className={`press-scale grid size-7 place-items-center rounded-full border text-xs outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/40 disabled:opacity-40 ${controlTone}`}
            aria-label={`Complete ${view.title}`}
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              void onComplete(view.item.id, view.title);
            }}
          >
            ✓
          </button>
          <button
            type="button"
            className={`press-scale ${isDragging ? 'press-scale-suppress' : ''} grid size-7 touch-none cursor-grab place-items-center rounded-full border text-sm outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-accent-blue/40 disabled:opacity-40 ${controlTone}`}
            aria-label={`Drag ${view.title}`}
            disabled={busy}
            onClick={(event) => event.stopPropagation()}
            {...attributes}
            {...listeners}
          >
            <span aria-hidden="true">⠿</span>
          </button>
        </div>
        <button
          type="button"
          className={`line-clamp-2 w-full pr-16 text-left text-[15px] font-medium leading-5 outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/40 ${
            isFocus ? 'text-background' : 'text-foreground'
          }`}
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
        >
          {view.title}
        </button>
        {preview && (
          <p className={`mt-1 line-clamp-1 text-[13px] leading-[18px] ${
            isFocus ? 'text-background/65' : 'text-muted-foreground'
          }`}>
            {preview}
          </p>
        )}
        <div className="mt-auto flex min-w-0 items-center gap-1.5 pt-1">
          {focusNumber && (
            <span className="shrink-0 rounded-full bg-background/95 px-2 py-1 text-[10px] font-semibold leading-none text-foreground">
              Focus {focusNumber}
            </span>
          )}
          <OwnerChip
            itemId={view.item.id}
            owner={view.item.owner}
            disabled={busy}
            inverted={isFocus}
            onOwnerChange={(owner) => onOwnerChange(view.item.id, owner)}
            onOpen={onOwnerChipOpen}
            onClose={onOwnerChipClose}
          />
          <button
            type="button"
            className={`press-scale ml-auto h-7 shrink-0 rounded-full px-2 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/40 disabled:opacity-40 ${
              isFocus
                ? 'text-background/55 hover:text-background focus-visible:text-background'
                : 'text-muted-foreground hover:text-foreground focus-visible:text-foreground'
            }`}
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              void onRemove(view.item.id, view.title, view.item.sourceRefs.some(
                (source) => source.sourceType === 'task' && source.recordId === view.item.taskId,
              ));
            }}
          >
            Not today
          </button>
        </div>
      </article>
    </li>
  );
}

function NotTodayCard({
  task,
  busy,
  onOpen,
  onAdd,
}: {
  task: MorningArrivalBoardTask;
  busy: boolean;
  onOpen: () => void;
  onAdd: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `not-today:${task.id}`,
    disabled: busy,
  });
  const preview = task.description?.trim();
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={isDragging ? 'relative z-10 opacity-70' : ''}
    >
      <article
        className={`${CARD_SHELL_CLASS} border-foreground/10 bg-card text-foreground`}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('button, a, [data-card-control]')) return;
          onOpen();
        }}
      >
        <button
          type="button"
          className={`press-scale ${isDragging ? 'press-scale-suppress' : ''} absolute right-2.5 top-2.5 grid size-7 touch-none cursor-grab place-items-center rounded-full border border-border text-sm text-muted-foreground outline-none active:cursor-grabbing hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent-blue/40 focus-visible:text-foreground disabled:opacity-40`}
          aria-label={`Drag ${task.title}`}
          disabled={busy}
          onClick={(event) => event.stopPropagation()}
          {...attributes}
          {...listeners}
        >
          <span aria-hidden="true">⠿</span>
        </button>
        <button
          type="button"
          className="line-clamp-2 w-full pr-8 text-left text-[15px] font-medium leading-5 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/40"
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
        >
          {task.title}
        </button>
        {preview && (
          <p className="mt-1 line-clamp-1 text-[13px] leading-[18px] text-muted-foreground">
            {preview}
          </p>
        )}
        <button
          type="button"
          className="press-scale mt-auto h-7 self-start rounded-full px-2 text-[11px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent-blue/40 focus-visible:text-foreground disabled:opacity-40"
          disabled={busy}
          onClick={(event) => {
            event.stopPropagation();
            onAdd();
          }}
        >
          Add to today
        </button>
      </article>
    </li>
  );
}

function DetailDialog({ detail, onClose }: { detail: Detail; onClose: () => void }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/35 p-4"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={detail.title}
        className="w-full max-w-lg rounded-2xl border bg-background p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold text-foreground">{detail.title}</h2>
          <button type="button" className="press-scale size-9 rounded-full border" onClick={onClose}>
            <span aria-hidden="true">×</span><span className="sr-only">Close details</span>
          </button>
        </div>
        {detail.description && (
          <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
            {detail.description}
          </p>
        )}
        <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="font-medium">Project</dt><dd className="mt-1 text-muted-foreground">{detail.project ?? 'None'}</dd></div>
          <div><dt className="font-medium">Due</dt><dd className="mt-1 text-muted-foreground">{detail.due ?? 'No due date'}</dd></div>
        </dl>
      </section>
    </div>
  );
}

export default function ArrivalPlanGrid({
  todayItems,
  notTodayTasks,
  busy,
  onInteract,
  onOwnerChange,
  onDragReorder,
  onRemove,
  onComplete,
  onAddTask,
  onOpenAllWork,
  onOwnerChipOpen,
  onOwnerChipClose,
}: {
  todayItems: MorningArrivalItem[];
  notTodayTasks: MorningArrivalBoardTask[];
  busy: boolean;
  onInteract?: () => void;
  onOwnerChange: MorningArrivalProps['onOwnerChange'];
  onDragReorder: MorningArrivalProps['onDragReorder'];
  onRemove: MorningArrivalProps['onRemove'];
  onComplete: MorningArrivalProps['onComplete'];
  onAddTask: MorningArrivalProps['onAddTask'];
  onOpenAllWork?: MorningArrivalProps['onOpenAllWork'];
  onOwnerChipOpen: (handler: OwnerChipEscapeHandler) => void;
  onOwnerChipClose: (itemId: string) => void;
}) {
  const [detail, setDetail] = useState<Detail>();
  const [capacityNote, setCapacityNote] = useState(false);
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
  const visibleNotTodayTasks = notTodayTasks.slice(0, 30);
  const hiddenNotTodayCount = notTodayTasks.length - visibleNotTodayTasks.length;
  const focusIds = new Set(focusBandItems(orderedToday.map((view) => view.item)).map((item) => item.id));

  function addTask(task: MorningArrivalBoardTask) {
    onInteract?.();
    if (orderedToday.length >= 10) {
      setCapacityNote(true);
      return;
    }
    setCapacityNote(false);
    void onAddTask(task.id, task.title);
  }

  function handleDragEnd(event: DragEndEvent) {
    const activeId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : undefined;
    if (!overId) return;
    onInteract?.();
    if (activeId.startsWith('not-today:')) {
      if (overId !== TODAY_ZONE_ID && !overId.startsWith('today:')) return;
      const task = notTodayTasks.find((candidate) => candidate.id === activeId.slice(10));
      if (task) addTask(task);
      return;
    }
    if (!activeId.startsWith('today:') || !overId.startsWith('today:')) return;
    if (activeId === overId) return;
    void onDragReorder(activeId.slice(6), overId.slice(6));
  }

  return (
    <section className="w-full space-y-5 px-4 py-4 sm:px-5" aria-label="Plan your day">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={() => onInteract?.()}
        onDragEnd={handleDragEnd}
      >
        <section aria-labelledby="arrival-today-title">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 id="arrival-today-title" className="text-sm font-semibold text-foreground">Today</h2>
              <p className="mt-1 text-xs text-muted-foreground">Your first three tasks are the focus.</p>
            </div>
            <span className="text-xs text-muted-foreground">{orderedToday.length} of 10</span>
          </div>
          <div
            ref={setNodeRef}
            className={`mt-3 min-h-[150px] rounded-3xl border p-3 transition-colors ${isOver ? 'border-accent-blue bg-accent-blue/5' : 'border-transparent bg-muted/30'}`}
          >
            <SortableContext items={orderedToday.map((view) => `today:${view.item.id}`)} strategy={rectSortingStrategy}>
              <ol className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
                {orderedToday.map((view) => {
                  const focusIndex = focusBandItems(orderedToday.map((entry) => entry.item))
                    .findIndex((item) => item.id === view.item.id);
                  return (
                    <TodayCard
                      key={view.item.id}
                      view={view}
                      focusNumber={focusIds.has(view.item.id) ? focusIndex + 1 : undefined}
                      busy={busy}
                      onOpen={() => {
                        onInteract?.();
                        setDetail({
                          title: view.title,
                          description: view.description,
                          project: view.project,
                          due: view.deadline,
                        });
                      }}
                      onOwnerChange={onOwnerChange}
                      onComplete={onComplete}
                      onRemove={onRemove}
                      onOwnerChipOpen={onOwnerChipOpen}
                      onOwnerChipClose={onOwnerChipClose}
                    />
                  );
                })}
              </ol>
            </SortableContext>
          </div>
          {capacityNote && (
            <p role="status" className="mt-2 text-xs text-muted-foreground">
              Today is full at 10. Move one task down before adding another.
            </p>
          )}
        </section>

        <section aria-labelledby="arrival-not-today-title">
          <div className="flex items-center justify-between gap-3">
            <h2 id="arrival-not-today-title" className="text-sm font-semibold text-foreground">Not today</h2>
            {onOpenAllWork && (
              <button
                type="button"
                className="press-scale min-h-9 rounded-full border px-3 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => {
                  onInteract?.();
                  onOpenAllWork();
                }}
              >
                Open All Work
              </button>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Drag a task up or tap Add to today.</p>
          {notTodayTasks.length > 0 ? (
            <ul className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3 px-[13px]">
              {visibleNotTodayTasks.map((task) => (
                <NotTodayCard
                  key={task.id}
                  task={task}
                  busy={busy}
                  onOpen={() => {
                    onInteract?.();
                    setDetail({
                      title: task.title,
                      description: task.description,
                      project: task.project,
                      due: task.due,
                    });
                  }}
                  onAdd={() => addTask(task)}
                />
              ))}
            </ul>
          ) : (
            <p className="mt-3 rounded-2xl border bg-card p-4 text-sm text-muted-foreground">
              No other open tasks are ready to plan.
            </p>
          )}
          {hiddenNotTodayCount > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              {hiddenNotTodayCount} more in All Work
            </p>
          )}
        </section>
      </DndContext>
      {detail && <DetailDialog detail={detail} onClose={() => setDetail(undefined)} />}
    </section>
  );
}
