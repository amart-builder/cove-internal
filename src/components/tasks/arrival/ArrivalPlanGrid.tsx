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

type Detail = {
  title: string;
  description?: string;
  project?: string;
  due?: string;
};

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

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={isDragging ? 'relative z-10 opacity-75' : ''}
    >
      <article
        className={`flex min-h-52 flex-col rounded-2xl border border-foreground/10 bg-foreground p-4 text-background shadow-sm ${busy ? '' : 'cursor-grab active:cursor-grabbing'}`}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('button, a, [data-card-control]')) return;
          onOpen();
        }}
        {...attributes}
        {...listeners}
      >
        <div className="flex items-start justify-between gap-3">
          {focusNumber ? (
            <span className="rounded-full bg-background px-2.5 py-1 text-xs font-semibold text-foreground">
              Focus {focusNumber}
            </span>
          ) : (
            <span className="text-xs font-medium text-background/60">Today</span>
          )}
          <button
            type="button"
            className="press-scale grid size-8 place-items-center rounded-full border border-background/25 text-sm text-background hover:bg-background/10 disabled:opacity-40"
            aria-label={`Complete ${view.title}`}
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              void onComplete(view.item.id, view.title);
            }}
          >
            ✓
          </button>
        </div>
        <button
          type="button"
          className="mt-4 text-left text-base font-semibold leading-snug text-background outline-none focus-visible:ring-2 focus-visible:ring-background/50"
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
        >
          {view.title}
        </button>
        {view.summary && (
          <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-background/70">
            {view.summary}
          </p>
        )}
        <div className="mt-auto flex flex-wrap items-end justify-between gap-2 pt-5 [&_button]:border-background/25 [&_button]:text-background/75 [&_button:hover]:text-background">
          <OwnerChip
            itemId={view.item.id}
            owner={view.item.owner}
            disabled={busy}
            onOwnerChange={(owner) => onOwnerChange(view.item.id, owner)}
            onOpen={onOwnerChipOpen}
            onClose={onOwnerChipClose}
          />
          <button
            type="button"
            className="press-scale min-h-9 rounded-full border border-background/25 px-3 text-xs text-background/75 hover:text-background disabled:opacity-40"
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
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      className={isDragging ? 'relative z-10 opacity-70' : ''}
    >
      <article
        className={`flex min-h-40 flex-col rounded-2xl border bg-card p-4 text-foreground ${busy ? '' : 'cursor-grab active:cursor-grabbing'}`}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('button, a')) return;
          onOpen();
        }}
        {...attributes}
        {...listeners}
      >
        <button
          type="button"
          className="text-left text-sm font-semibold leading-snug outline-none focus-visible:ring-2 focus-visible:ring-accent-blue/40"
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
        >
          {task.title}
        </button>
        {task.description && (
          <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {task.description}
          </p>
        )}
        <button
          type="button"
          className="press-scale mt-auto min-h-9 self-start rounded-full border px-3 text-xs font-medium hover:bg-muted disabled:opacity-40"
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
    <section className="mx-auto w-full max-w-[76rem] space-y-8 px-6 py-8 sm:px-10" aria-label="Plan your day">
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
            className={`mt-3 min-h-40 rounded-3xl border p-3 transition-colors ${isOver ? 'border-accent-blue bg-accent-blue/5' : 'border-transparent bg-muted/30'}`}
          >
            <SortableContext items={orderedToday.map((view) => `today:${view.item.id}`)} strategy={rectSortingStrategy}>
              <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
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
            <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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
