'use client';

import {
  SortableContext,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { useDroppable } from '@dnd-kit/core';
import type {
  LaunchTaskSessionInput,
  TaskSessionRun,
} from '@/lib/task-sessions/types';
import TaskCard from './TaskCard';

interface ColumnData {
  _id: string;
  name: string;
  position: number;
}

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

interface ColumnProps {
  column: ColumnData;
  tasks: TaskData[];
  onOpenDetail: (taskId: string) => void;
  onCompleteTask?: (taskId: string) => void | Promise<void>;
  completingTaskId?: string | null;
  sessionRuns?: ReadonlyMap<string, TaskSessionRun>;
  launchingTaskIds?: ReadonlySet<string>;
  onLaunchSession?: (input: LaunchTaskSessionInput) => void | Promise<unknown>;
}

const COLUMN_ICONS: Record<string, React.ReactNode> = {
  'Must happen today': (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent-red">
      <path d="M12 2v4" />
      <path d="M12 18v4" />
      <path d="m4.93 4.93 2.83 2.83" />
      <path d="m16.24 16.24 2.83 2.83" />
      <path d="M2 12h4" />
      <path d="M18 12h4" />
      <path d="m4.93 19.07 2.83-2.83" />
      <path d="m16.24 7.76 2.83-2.83" />
    </svg>
  ),
  'Not Started': (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground">
      <circle cx="12" cy="12" r="10" />
    </svg>
  ),
  'In Flight / Waiting': (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent-blue">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  ),
  'Blocked': (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent-orange">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
  'Done': (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-accent-green">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  ),
};

export default function Column({
  column,
  tasks,
  onOpenDetail,
  onCompleteTask,
  completingTaskId,
  sessionRuns,
  launchingTaskIds,
  onLaunchSession,
}: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `column-${column._id}`,
  });
  const icon = COLUMN_ICONS[column.name] ?? COLUMN_ICONS['Not Started'];
  const isDoneColumn = column.name === 'Done';

  return (
    <div
      ref={setNodeRef}
      className={`water-board-column flex w-72 shrink-0 flex-col ${
        isOver ? 'is-over' : ''
      }`}
    >
      {/* Header */}
      <div className="water-column-heading flex items-center gap-2 border-b px-4 py-3">
        {icon}
        <span className="truncate text-foreground">
          {column.name}
        </span>
        <span className="water-column-count ml-auto tabular-nums text-muted-foreground">
          {tasks.length}
        </span>
      </div>

      {/* Task list */}
      <div className="water-task-list min-h-[120px] flex-1 space-y-2 overflow-y-auto p-2.5">
        <SortableContext
          items={tasks.map((t) => t._id)}
          strategy={verticalListSortingStrategy}
        >
          {tasks.map((task) => (
            <TaskCard
              key={task._id}
              task={task}
              onOpenDetail={onOpenDetail}
              onCompleteTask={onCompleteTask}
              isDone={isDoneColumn}
              isCompleting={completingTaskId === task._id}
              sessionRun={sessionRuns?.get(task._id)}
              sessionBusy={launchingTaskIds?.has(task._id)}
              onLaunchSession={onLaunchSession}
            />
          ))}
        </SortableContext>

        {tasks.length === 0 && (
          <p className="water-empty-column text-center">
            No tasks
          </p>
        )}
      </div>
    </div>
  );
}
