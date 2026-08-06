'use client';

import { useId, useMemo, useState } from 'react';
import type { MorningArrivalBoardTask, MorningArrivalItem } from '../MorningArrival';
import { ModalScrim } from './TaskSheet';

export const TODAY_TAG_CLASS = 'mb-2 inline-block rounded-full bg-muted px-2 py-[3px] text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground';

export default function AllWorkPicker({
  todayItems,
  boardTasks,
  busy,
  returnFocus,
  onAdd,
  onClose,
}: {
  todayItems: MorningArrivalItem[];
  boardTasks: MorningArrivalBoardTask[];
  busy: boolean;
  returnFocus: HTMLElement | null;
  onAdd: (task: MorningArrivalBoardTask) => boolean | Promise<boolean>;
  onClose: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const [optimisticTodayIds, setOptimisticTodayIds] = useState<Set<string>>(() => new Set());
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [capacityMessage, setCapacityMessage] = useState('');
  const todayTaskIds = useMemo(
    () => new Set(todayItems.map((view) => view.item.taskId).filter(Boolean)),
    [todayItems],
  );
  const optimisticToday = boardTasks.filter(
    (task) => optimisticTodayIds.has(task.id) && !todayTaskIds.has(task.id),
  );
  const remainingBoard = boardTasks.filter(
    (task) => !todayTaskIds.has(task.id) && !optimisticTodayIds.has(task.id),
  );
  const openTaskCount = todayItems.length + boardTasks.length;

  async function addTask(task: MorningArrivalBoardTask) {
    if (pendingIds.has(task.id) || optimisticTodayIds.has(task.id)) return;
    setCapacityMessage('');
    setOptimisticTodayIds((current) => new Set(current).add(task.id));
    setPendingIds((current) => new Set(current).add(task.id));
    try {
      const added = await onAdd(task);
      if (!added) {
        setOptimisticTodayIds((current) => {
          const next = new Set(current);
          next.delete(task.id);
          return next;
        });
        setCapacityMessage('Today is full at 10. Move one task down before adding another.');
      }
    } catch {
      setOptimisticTodayIds((current) => {
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
    } finally {
      setPendingIds((current) => {
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
    }
  }

  return (
    <ModalScrim
      labelledBy={titleId}
      describedBy={descriptionId}
      returnFocus={returnFocus}
      onClose={onClose}
      panelClassName="panel-pop-in flex max-h-[min(760px,calc(100dvh-2rem))] w-[min(1040px,calc(100vw-2rem))] flex-col rounded-3xl border bg-card px-5 pb-6 pt-7 text-foreground shadow-2xl outline-none sm:px-8 sm:pb-8 sm:pt-9 lg:px-11 dark:border-white/10"
    >
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.24em] text-muted-foreground">
            All work
          </p>
          <h2 id={titleId} className="text-[21px] font-semibold tracking-[-0.018em] text-foreground">
            Everything on your plate
          </h2>
        </div>
        <p className="text-xs text-muted-foreground">
          {openTaskCount} open {openTaskCount === 1 ? 'task' : 'tasks'}
        </p>
      </header>

      <p id={descriptionId} className="sr-only">
        Today tasks are listed first. Choose any other task to add it to today.
      </p>
      <div className="grid min-h-0 grid-cols-1 gap-3 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-4">
        {todayItems.map((view) => (
          <TodayCell key={view.item.id} title={view.title} />
        ))}
        {optimisticToday.map((task) => (
          <TodayCell key={`optimistic:${task.id}`} title={task.title} pending={pendingIds.has(task.id)} />
        ))}
        {remainingBoard.map((task) => (
          <button
            key={task.id}
            type="button"
            aria-label={task.title}
            disabled={busy || pendingIds.has(task.id)}
            className="press-scale min-h-[88px] min-w-0 rounded-[13px] border bg-background px-4 py-3.5 text-left outline-none transition-[transform,box-shadow,background-color,border-color] duration-150 hover:-translate-y-0.5 hover:border-muted-foreground/40 hover:bg-card hover:shadow-lg focus-visible:ring-2 focus-visible:ring-accent-blue/40 active:translate-y-0 active:shadow-sm motion-reduce:transform-none disabled:cursor-default disabled:opacity-50 dark:bg-muted/35 dark:hover:bg-muted/70"
            onClick={() => void addTask(task)}
          >
            <span className="line-clamp-3 text-[13px] font-medium leading-[1.4] tracking-[-0.004em] text-foreground/80 dark:text-foreground/90">
              {task.title}
            </span>
          </button>
        ))}
      </div>

      <footer className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <p role="status" className="text-xs text-muted-foreground">
          {capacityMessage || 'Click a task to add it to today.'}
        </p>
        <button
          type="button"
          data-modal-initial-focus
          className="press-scale min-h-10 rounded-xl border bg-card px-4 text-[13.5px] font-medium text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-accent-blue/40"
          onClick={onClose}
        >
          Done
        </button>
      </footer>
    </ModalScrim>
  );
}

function TodayCell({ title, pending = false }: { title: string; pending?: boolean }) {
  return (
    <div className="min-h-[88px] min-w-0 rounded-[13px] border border-muted-foreground/35 bg-card px-4 py-3.5 dark:border-white/15">
      <span className={TODAY_TAG_CLASS}>
        {pending ? 'Adding' : 'Today'}
      </span>
      <p className="line-clamp-2 text-[13px] font-medium leading-[1.4] tracking-[-0.004em] text-foreground/80 dark:text-foreground/90">
        {title}
      </p>
    </div>
  );
}
