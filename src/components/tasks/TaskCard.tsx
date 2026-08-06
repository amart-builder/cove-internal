'use client';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface TaskData {
  _id: string;
  columnId: string;
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high';
  dueDate?: string;
  tags: string[];
  status?: 'open' | 'done' | 'archived';
  blocked: boolean;
  position: number;
  createdAt: number;
  updatedAt: number;
}

interface TaskCardProps {
  task: TaskData;
  onOpenDetail: (taskId: string) => void;
  onCompleteTask?: (taskId: string) => void | Promise<void>;
  isDone?: boolean;
  isOverlay?: boolean;
  isCompleting?: boolean;
}

const priorityColors: Record<string, string> = {
  high: 'text-accent-red',
  medium: 'text-accent-orange',
  low: 'text-accent-green',
};

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function visibleTags(tags: string[]): string[] {
  return tags.filter((tag) => tag.trim().toLowerCase() !== 'blocked');
}

export default function TaskCard({
  task,
  onOpenDetail,
  onCompleteTask,
  isDone = false,
  isOverlay,
  isCompleting = false,
}: TaskCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task._id });

  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition: transition ?? undefined,
    opacity: isDragging ? 0 : 1,
    touchAction: 'none',
  };
  const displayTags = visibleTags(task.tags);
  const contextLine = task.description || displayTags.slice(0, 2).join(' · ');
  const showCompleteButton = !isOverlay && !isDone && Boolean(onCompleteTask);

  function handleCompletePointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    e.stopPropagation();
  }

  function handleCompleteClick(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (!onCompleteTask || isCompleting) return;
    void onCompleteTask(task._id);
  }

  return (
    <div
      ref={isOverlay ? undefined : setNodeRef}
      style={isOverlay ? undefined : style}
      {...(isOverlay ? {} : attributes)}
      {...(isOverlay ? {} : listeners)}
      role={isOverlay ? undefined : 'group'}
      aria-label={isOverlay ? undefined : `Task: ${task.title}`}
      onClick={() => onOpenDetail(task._id)}
      className={`water-task-card relative p-3 ${
        isOverlay ? '' : 'cursor-grab active:cursor-grabbing'
      } ${
        showCompleteButton ? 'pr-8' : ''
      } ${
        isOverlay
          ? 'is-overlay'
          : isDragging
            ? 'is-dragging'
            : ''
      }`}
    >
      {showCompleteButton && (
        <button
          type="button"
          aria-label={`Mark "${task.title}" done`}
          title="Mark done"
          disabled={isCompleting}
          onPointerDown={handleCompletePointerDown}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={handleCompleteClick}
          className="water-complete-button absolute right-2.5 top-2.5 flex h-6 w-6 cursor-pointer items-center justify-center rounded-full border text-muted-foreground disabled:cursor-wait disabled:opacity-60"
        >
          <svg
            aria-hidden="true"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </button>
      )}

      <p className="water-card-title text-[15.5px] leading-snug text-foreground">{task.title}</p>

      {contextLine && (
        <p className="mt-1 line-clamp-1 text-[13.5px] leading-[1.55] text-muted-foreground">
          {contextLine}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {task.blocked && (
          <span className="water-pill border-accent-orange/30 bg-accent-orange/10 px-2 py-0.5 text-[12px] text-accent-orange">
            Blocked
          </span>
        )}
        <span
          className={`water-priority px-2 py-0.5 ${
            priorityColors[task.priority] ?? priorityColors.medium
          }`}
        >
          {task.priority}
        </span>

        {task.dueDate && (
          <span className="text-[12px] font-medium text-muted-foreground">
            {formatDate(task.dueDate)}
          </span>
        )}
      </div>
    </div>
  );
}
