'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type {
  CollisionDetection,
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
  UniqueIdentifier,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { getRuntimeMode } from '@/lib/runtime/mode';
import {
  createTask as createSupabaseTask,
  createTaskColumn as createSupabaseTaskColumn,
  deleteTask as deleteSupabaseTask,
  listTaskColumns,
  listTasks,
  updateTask as updateSupabaseTask,
  restoreTask as restoreSupabaseTask,
} from '@/lib/data/tasks';
import { confirmTaskRecurrence } from '@/lib/data/recurrence';
import type {
  Task as SupabaseTask,
  TaskColumn as SupabaseTaskColumn,
} from '@/lib/data/types';
import { useDataChanged } from '@/lib/data/refresh-bus';
import {
  LEGACY_BLOCKED_TASK_COLUMN_NAMES,
  TASK_COLUMNS,
  taskColumnKeyForName,
  type TaskColumnKey,
} from '@/lib/tasks/columns';
import Column from './Column';
import TaskCard from './TaskCard';
import TaskDetail from './TaskDetail';
import RecentlyDeleted from './RecentlyDeleted';
import useTaskSessionRuns from './useTaskSessionRuns';

interface ColumnData {
  _id: string;
  name: string;
  position: number;
  _creationTime: number;
  createdAt: number;
}

interface TaskData {
  _id: string;
  columnId: string;
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high';
  dueDate?: string;
  tags: string[];
  status?: TaskStatus;
  proposedRecurrenceCadence?: string;
  recurringTemplateId?: string;
  occurrenceLocalDate?: string;
  blocked: boolean;
  position: number;
  _creationTime: number;
  createdAt: number;
  updatedAt: number;
}

type CreateTaskInput = {
  columnId?: string | null;
  title: string;
  description?: string;
  priority?: 'low' | 'medium' | 'high';
  dueDate?: string | null;
  tags?: string[];
};

type UpdateTaskInput = {
  columnId?: string | null;
  title?: string;
  description?: string;
  priority?: 'low' | 'medium' | 'high';
  dueDate?: string | null;
  tags?: string[];
  position?: number;
  status?: TaskStatus;
};

interface KanbanBoardContentProps {
  columnsData: ColumnData[];
  tasksData: TaskData[];
  loading: boolean;
  error?: string;
  onRetry: () => Promise<void>;
  onSeed?: () => Promise<void>;
  onCreateTask: (input: CreateTaskInput) => Promise<void>;
  onUpdateTask: (id: string, patch: UpdateTaskInput, nextTasks?: TaskData[]) => Promise<void>;
  onDeleteTask: (id: string) => Promise<void>;
  onRestoreTask?: (id: string) => Promise<void>;
  onConfirmRecurrence?: (id: string, cadence: string) => Promise<void>;
}

const BLOCKED_TAG = 'blocked';
type ColumnStatus = TaskColumnKey;
type TaskStatus = 'open' | 'done' | 'archived';
type StatusFilter = 'all' | ColumnStatus | 'blocked';
type PriorityFilter = 'all' | 'low' | 'medium' | 'high';
const COLUMN_DROP_PREFIX = 'column-';

const pointerFirstCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  return pointerCollisions.length > 0
    ? pointerCollisions
    : closestCorners(args);
};

export default function KanbanBoard() {
  // Local and Supabase both use the REST-backed board; only Convex differs.
  if (getRuntimeMode() !== 'convex') return <SupabaseKanbanBoard />;
  return (
    <div className="rounded-md border bg-card p-4 text-sm text-muted-foreground" role="status">
      Task changes are not supported in this runtime. Start Cove in local mode to use the board.
    </div>
  );
}

function toEpoch(value: string | null | undefined): number {
  return value ? new Date(value).getTime() : Date.now();
}

function toDateInput(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value.slice(0, 10);
}

function isBlockedTag(tag: string): boolean {
  return tag.trim().toLowerCase() === BLOCKED_TAG;
}

function isTaskBlocked(tags: string[]): boolean {
  return tags.some(isBlockedTag);
}

function visibleTags(tags: string[]): string[] {
  return tags.filter((tag) => !isBlockedTag(tag));
}

function tagsWithBlockedFlag(tags: string[], blocked: boolean): string[] {
  const tagsWithoutFlag = visibleTags(tags);
  return blocked ? [...tagsWithoutFlag, BLOCKED_TAG] : tagsWithoutFlag;
}

function normalizeSupabaseColumn(column: SupabaseTaskColumn): ColumnData {
  return {
    _id: column.id,
    name: column.name,
    position: column.position,
    _creationTime: 0,
    createdAt: 0,
  };
}

function normalizeSupabaseTask(task: SupabaseTask): TaskData {
  const row = task as SupabaseTask & {
    created_at?: string;
    updated_at?: string;
  };
  const tags = task.tags ?? [];
  return {
    _id: task.id,
    columnId: task.column_id ?? '',
    title: task.title,
    description: task.description,
    priority: task.priority,
    dueDate: toDateInput(task.due_at),
    tags,
    status: task.status,
    proposedRecurrenceCadence: task.proposed_recurrence_cadence ?? undefined,
    recurringTemplateId: task.recurring_template_id ?? undefined,
    occurrenceLocalDate: task.occurrence_local_date ?? undefined,
    blocked: isTaskBlocked(tags),
    position: task.position,
    _creationTime: toEpoch(row.created_at),
    createdAt: toEpoch(row.created_at),
    updatedAt: toEpoch(row.updated_at ?? row.created_at),
  };
}

function applyTaskPatch(task: TaskData, patch: UpdateTaskInput): TaskData {
  return {
    ...task,
    columnId: patch.columnId === undefined ? task.columnId : (patch.columnId ?? ''),
    title: patch.title ?? task.title,
    description: patch.description ?? task.description,
    priority: patch.priority ?? task.priority,
    dueDate: patch.dueDate === undefined ? task.dueDate : (patch.dueDate ?? undefined),
    tags: patch.tags ?? task.tags,
    status: patch.status ?? task.status,
    blocked: patch.tags === undefined ? task.blocked : isTaskBlocked(patch.tags),
    position: patch.position ?? task.position,
  };
}

function toSupabaseTaskPatch(patch: UpdateTaskInput): Partial<SupabaseTask> {
  return {
    column_id: patch.columnId,
    title: patch.title,
    description: patch.description,
    priority: patch.priority,
    due_at:
      patch.dueDate === undefined
        ? undefined
        : patch.dueDate
          ? new Date(`${patch.dueDate}T00:00:00Z`).toISOString()
          : null,
    tags: patch.tags,
    position: patch.position,
    status: patch.status,
  };
}

// A due date is a calendar date, not an instant, so it is stored at UTC
// midnight. Parsing it as *local* midnight shifts the stored day backwards for
// any operator at or ahead of UTC, and the read path slices the UTC date
// straight off the string, so the board would show them the day before the one
// they picked.
function toSupabaseDueAt(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value ? new Date(`${value}T00:00:00Z`).toISOString() : null;
}

function SupabaseKanbanBoard() {
  const localMode = getRuntimeMode() === 'local';
  const [columns, setColumns] = useState<ColumnData[]>([]);
  const [tasks, setTasks] = useState<TaskData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const reload = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [nextColumns, nextTasks] = await Promise.all([
        listTaskColumns(),
        listTasks(),
      ]);
      setColumns(nextColumns.map(normalizeSupabaseColumn));
      setTasks(nextTasks.map(normalizeSupabaseTask));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useDataChanged(['tasks', 'task_columns'], () => void reload());

  const ensureDefaultColumns = useCallback(async () => {
    const existingColumns = await listTaskColumns();
    const missingColumns = TASK_COLUMNS.filter(
      (canonical) =>
        !existingColumns.some((column) =>
          canonical.aliases.some((alias) => alias === column.name)
        )
    );
    if (missingColumns.length === 0) return;

    await Promise.all(
      missingColumns.map((column) =>
        createSupabaseTaskColumn({
          name: column.name,
          position: column.position,
          is_default: true,
        })
      )
    );
    await reload();
  }, [reload]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <KanbanBoardContent
      columnsData={columns}
      tasksData={tasks}
      loading={loading}
      error={error}
      onRetry={reload}
      onSeed={!loading && !error ? ensureDefaultColumns : undefined}
      onCreateTask={async (input) => {
        const targetColumnId = input.columnId ?? null;
        const nextPosition =
          tasks
            .filter((task) => (task.columnId || null) === targetColumnId)
            .reduce((maxPosition, task) => Math.max(maxPosition, task.position), -1) + 1;

        const createdTask = await createSupabaseTask({
          column_id: targetColumnId,
          title: input.title,
          description: input.description,
          priority: input.priority,
          due_at: toSupabaseDueAt(input.dueDate),
          tags: input.tags,
          position: nextPosition,
        });
        setTasks((currentTasks) => [
          ...currentTasks,
          normalizeSupabaseTask(createdTask),
        ]);
      }}
      onUpdateTask={async (id, patch, nextTasks) => {
        const previousTasks = tasks;

        if (nextTasks && patch.columnId !== undefined && patch.position !== undefined) {
          const optimisticTasks = nextTasks.map((task) =>
            task._id === id ? applyTaskPatch(task, patch) : task
          );
          const changedTasks = optimisticTasks.filter((nextTask) => {
            const currentTask = previousTasks.find((task) => task._id === nextTask._id);
            return (
              currentTask &&
              (currentTask.columnId !== nextTask.columnId || currentTask.position !== nextTask.position)
            );
          });

          setTasks(optimisticTasks);
          try {
            await Promise.all(
              changedTasks.map((task) => {
                const taskPatch: Partial<SupabaseTask> = {
                  column_id: task.columnId || null,
                  position: task.position,
                };
                if (task._id === id) {
                  Object.assign(taskPatch, toSupabaseTaskPatch(patch), {
                    column_id: task.columnId || null,
                    position: task.position,
                  });
                }
                return updateSupabaseTask(task._id, taskPatch);
              })
            );
          } catch (err) {
            setTasks(previousTasks);
            throw err;
          }
          return;
        }

        const optimisticTasks = previousTasks.map((task) =>
          task._id === id ? applyTaskPatch(task, patch) : task
        );
        setTasks(optimisticTasks);
        try {
          const updatedTask = await updateSupabaseTask(id, toSupabaseTaskPatch(patch));
          setTasks((currentTasks) =>
            currentTasks.map((task) =>
              task._id === id ? normalizeSupabaseTask(updatedTask) : task
            )
          );
        } catch (err) {
          setTasks(previousTasks);
          throw err;
        }
      }}
      onDeleteTask={async (id) => {
        const previousTasks = tasks;
        setTasks((currentTasks) => currentTasks.filter((task) => task._id !== id));
        try {
          await deleteSupabaseTask(id);
        } catch (err) {
          setTasks(previousTasks);
          throw err;
        }
      }}
      onRestoreTask={localMode
        ? async (id) => {
            const restored = await restoreSupabaseTask(id);
            setTasks((currentTasks) => [
              ...currentTasks.filter((task) => task._id !== id),
              normalizeSupabaseTask(restored),
            ]);
          }
        : undefined}
      onConfirmRecurrence={localMode
        ? async (id, cadence) => {
            await confirmTaskRecurrence(id, cadence);
            await reload();
          }
        : undefined}
    />
  );
}

function KanbanBoardContent({
  columnsData,
  tasksData,
  loading,
  error,
  onRetry,
  onSeed,
  onCreateTask,
  onUpdateTask,
  onDeleteTask,
  onRestoreTask,
  onConfirmRecurrence,
}: KanbanBoardContentProps) {

  const [localTasks, setLocalTasks] = useState<TaskData[] | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<UniqueIdentifier | null>(null);
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  const [seeded, setSeeded] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('all');
  const [completingTaskId, setCompletingTaskId] = useState<string | null>(null);
  const [showRecentlyDeleted, setShowRecentlyDeleted] = useState(false);
  const [operationError, setOperationError] = useState<{
    message: string;
    retry?: () => Promise<void>;
  }>();
  const [retryingOperation, setRetryingOperation] = useState(false);
  const [archiveUndo, setArchiveUndo] = useState<{
    id: string;
    title: string;
  } | null>(null);

  const [newTask, setNewTask] = useState({
    title: '',
    priority: 'medium' as 'low' | 'medium' | 'high',
    dueDate: '',
    description: '',
    tags: '',
  });

  async function retryOperation() {
    const retry = operationError?.retry;
    if (!retry || retryingOperation) return;
    setRetryingOperation(true);
    try {
      await retry();
      setOperationError(undefined);
    } catch {
      setOperationError((current) => current
        ? { ...current, message: "That still didn't save. Try again." }
        : current);
    } finally {
      setRetryingOperation(false);
    }
  }

  useEffect(() => {
    if (!seeded && onSeed) {
      onSeed().then(() => setSeeded(true)).catch((err) => {
        console.error('Failed to seed board:', err);
        setSeeded(true);
      });
    }
  }, [onSeed, seeded]);

  const rawColumns = columnsData;
  const columns = TASK_COLUMNS.map((canonical) => {
    const column = rawColumns.find((rawColumn) =>
      canonical.aliases.some((alias) => alias === rawColumn.name)
    );
    return column
      ? { ...column, name: canonical.name, position: canonical.position }
      : undefined;
  }).filter(Boolean) as ColumnData[];

  const columnIdToStatus = new Map<string, ColumnStatus>();
  for (const col of columns) {
    columnIdToStatus.set(col._id, taskColumnKeyForName(col.name) ?? 'not-started');
  }

  const inProgressColumn =
    columns.find((column) => columnIdToStatus.get(column._id) === 'in-progress');
  const legacyBlockedColumnIds = new Set(
    rawColumns
      .filter((column) => LEGACY_BLOCKED_TASK_COLUMN_NAMES.has(column.name))
      .map((column) => column._id)
  );
  const notStartedColumn =
    columns.find((column) => columnIdToStatus.get(column._id) === 'not-started') ?? columns[0];
  const doneColumn =
    columns.find((column) => columnIdToStatus.get(column._id) === 'done');

  function statusForColumn(columnId: string | null | undefined): TaskStatus | undefined {
    if (!columnId) return undefined;
    return columnIdToStatus.get(columnId) === 'done' ? 'done' : 'open';
  }

  function patchWithColumnStatus(patch: UpdateTaskInput): UpdateTaskInput {
    if (patch.columnId === undefined) return patch;
    const status = statusForColumn(patch.columnId);
    return status ? { ...patch, status } : patch;
  }

  const normalizeDisplayTask = (task: TaskData): TaskData => {
    if (!inProgressColumn || !legacyBlockedColumnIds.has(task.columnId)) {
      return task;
    }

    return {
      ...task,
      columnId: inProgressColumn._id,
      tags: tagsWithBlockedFlag(task.tags, true),
      blocked: true,
    };
  };
  const tasks = (localTasks ?? tasksData).map(normalizeDisplayTask);
  const taskSessions = useTaskSessionRuns(
    getRuntimeMode() === 'local' ? tasks.map((task) => task._id) : [],
  );

  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const dragStartTasksRef = useRef<TaskData[] | null>(null);

  useEffect(() => {
    if (tasksData && localTasks) {
      setLocalTasks(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasksData]);

  useEffect(() => {
    if (!archiveUndo) return;
    const timeout = window.setTimeout(() => setArchiveUndo(null), 10000);
    return () => window.clearTimeout(timeout);
  }, [archiveUndo]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const totalTasks = tasks.length;

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredTasks = tasks.filter((task) => {
    if (normalizedQuery) {
      const matchesSearch =
        task.title.toLowerCase().includes(normalizedQuery) ||
        task.description?.toLowerCase().includes(normalizedQuery) ||
        task.tags.some((tag) => tag.toLowerCase().includes(normalizedQuery));
      if (!matchesSearch) return false;
    }

    if (priorityFilter !== 'all' && task.priority !== priorityFilter) {
      return false;
    }

    if (statusFilter === 'blocked' && !task.blocked) {
      return false;
    }

    if (
      statusFilter !== 'all' &&
      statusFilter !== 'blocked' &&
      columnIdToStatus.get(task.columnId) !== statusFilter
    ) {
      return false;
    }

    return true;
  });

  function getTasksForColumn(columnId: string) {
    return filteredTasks
      .filter((task) => task.columnId === columnId)
      .sort((a, b) => a.position - b.position);
  }

  function findColumnOfTaskIn(baseTasks: TaskData[], taskId: UniqueIdentifier): string | undefined {
    return baseTasks.find((task) => task._id === taskId)?.columnId;
  }

  function findColumnDropTarget(overId: UniqueIdentifier, baseTasks: TaskData[]): string | undefined {
    const id = String(overId);
    if (id.startsWith(COLUMN_DROP_PREFIX)) {
      return id.slice(COLUMN_DROP_PREFIX.length);
    }
    return findColumnOfTaskIn(baseTasks, id);
  }

  function isColumnDropTarget(overId: string) {
    return overId.startsWith(COLUMN_DROP_PREFIX) || columns.some((column) => column._id === overId);
  }

  function rebuildPositionsInColumn(columnTasks: TaskData[]) {
    return columnTasks.map((task, position) => ({ ...task, position }));
  }

  function hasSameTaskPlacement(left: TaskData[], right: TaskData[]) {
    if (left.length !== right.length) return false;

    return left.every((task, index) => {
      const nextTask = right[index];
      return (
        nextTask &&
        task._id === nextTask._id &&
        task.columnId === nextTask.columnId &&
        task.position === nextTask.position
      );
    });
  }

  function applyMove(
    baseTasks: TaskData[],
    activeId: string,
    destinationColumnId: string,
    destinationIndex: number
  ) {
    const activeTask = baseTasks.find((task) => task._id === activeId);
    if (!activeTask) return baseTasks;

    const sourceColumnId = activeTask.columnId;
    const sourceTasks = baseTasks
      .filter((task) => task.columnId === sourceColumnId && task._id !== activeId)
      .sort((a, b) => a.position - b.position);
    const destinationTasks = baseTasks
      .filter((task) => task.columnId === destinationColumnId && task._id !== activeId)
      .sort((a, b) => a.position - b.position);

    const boundedIndex = Math.max(0, Math.min(destinationIndex, destinationTasks.length));
    destinationTasks.splice(boundedIndex, 0, {
      ...activeTask,
      columnId: destinationColumnId,
    });

    const sourceRebuilt = rebuildPositionsInColumn(sourceTasks);
    const destinationRebuilt = rebuildPositionsInColumn(destinationTasks);
    const replacements = new Map<string, TaskData>();
    for (const task of sourceRebuilt) replacements.set(task._id, task);
    for (const task of destinationRebuilt) replacements.set(task._id, task);

    return baseTasks.map((task) => replacements.get(task._id) ?? task);
  }

  function handleDragStart(event: DragStartEvent) {
    dragStartTasksRef.current = tasksRef.current;
    setActiveTaskId(event.active.id);
  }

  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over) return;

    const activeId = String(active.id);
    const overId = String(over.id);
    const currentTasks = tasksRef.current;

    const activeCol = findColumnOfTaskIn(currentTasks, activeId);
    const overCol = findColumnDropTarget(overId, currentTasks);

    if (!activeCol || !overCol) return;

    const originalCol = findColumnOfTaskIn(dragStartTasksRef.current ?? currentTasks, activeId);
    if (activeCol === overCol && originalCol !== overCol) return;

    const destinationTasks = currentTasks
      .filter((task) => task.columnId === overCol && task._id !== activeId)
      .sort((a, b) => a.position - b.position);
    let destinationIndex = destinationTasks.length;

    if (!isColumnDropTarget(overId)) {
      const overTaskIndex = destinationTasks.findIndex((task) => task._id === overId);
      if (overTaskIndex >= 0) destinationIndex = overTaskIndex;
    }

    const next = applyMove(currentTasks, activeId, overCol, destinationIndex);
    if (!hasSameTaskPlacement(currentTasks, next)) {
      setLocalTasks(next);
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveTaskId(null);

    const { active, over } = event;
    if (!over) {
      dragStartTasksRef.current = null;
      setLocalTasks(null);
      return;
    }

    const activeId = String(active.id);
    const overId = String(over.id);
    const originalTasks = dragStartTasksRef.current ?? tasksData;
    const currentTasks = tasksRef.current;
    dragStartTasksRef.current = null;

    const activeCol = findColumnOfTaskIn(originalTasks, activeId);
    const overCol =
      findColumnDropTarget(overId, currentTasks) ??
      findColumnDropTarget(overId, originalTasks);

    if (!activeCol || !overCol) {
      setLocalTasks(null);
      return;
    }

    const sourceTasks = originalTasks
      .filter((task) => task.columnId === activeCol)
      .sort((a, b) => a.position - b.position);
    const currentDestinationTasks = currentTasks
      .filter((task) => task.columnId === overCol)
      .sort((a, b) => a.position - b.position);
    const originalDestinationTasks = originalTasks
      .filter((task) => task.columnId === overCol && task._id !== activeId)
      .sort((a, b) => a.position - b.position);

    let destinationIndex = -1;

    if (activeCol !== overCol && !isColumnDropTarget(overId)) {
      const overTaskIndex = originalDestinationTasks.findIndex(
        (task) => task._id === overId
      );
      if (overTaskIndex >= 0) destinationIndex = overTaskIndex;
    }

    if (destinationIndex < 0) {
      destinationIndex = currentDestinationTasks.findIndex(
        (task) => task._id === activeId
      );
    }

    if (destinationIndex < 0) {
      destinationIndex = originalDestinationTasks.length;
      if (!isColumnDropTarget(overId)) {
        const overTaskIndex = originalDestinationTasks.findIndex(
          (task) => task._id === overId
        );
        if (overTaskIndex >= 0) destinationIndex = overTaskIndex;
      }
    }

    const activeIndexInSource = sourceTasks.findIndex((task) => task._id === activeId);

    if (activeCol === overCol && activeIndexInSource === destinationIndex) {
      setLocalTasks(null);
      return;
    }

    const movedTasks = applyMove(originalTasks, activeId, overCol, destinationIndex);
    setLocalTasks(movedTasks);

    const persistMove = () => onUpdateTask(activeId, {
        columnId: overCol,
        position: destinationIndex,
        status: statusForColumn(overCol),
      }, movedTasks);
    try {
      await persistMove();
      setOperationError(undefined);
    } catch (err) {
      console.error('Failed to persist drag:', err);
      setOperationError({
        message: "That task move didn't save. The board was restored.",
        retry: async () => {
          setLocalTasks(movedTasks);
          try {
            await persistMove();
          } finally {
            setLocalTasks(null);
          }
        },
      });
    } finally {
      setLocalTasks(null);
    }
  }

  async function handleAddTask(e: React.FormEvent) {
    e.preventDefault();
    if (!newTask.title.trim() || !notStartedColumn) return;

    try {
      const tags = newTask.tags
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

      await onCreateTask({
        title: newTask.title.trim(),
        columnId: notStartedColumn._id,
        priority: newTask.priority,
        description: newTask.description || undefined,
        dueDate: newTask.dueDate || undefined,
        tags: tags.length > 0 ? tags : undefined,
      });

      setNewTask({ title: '', priority: 'medium', dueDate: '', description: '', tags: '' });
      setShowAddForm(false);
      setOperationError(undefined);
    } catch (err) {
      console.error('Failed to add task:', err);
      setOperationError({
        message: "Cove couldn't add that task. Your draft is still here.",
      });
    }
  }

  function handleTaskDeleted(id: string) {
    const archived = tasks.find((task) => task._id === id);
    setDetailTaskId(null);
    if (archived && onRestoreTask) {
      setArchiveUndo({ id: archived._id, title: archived.title });
    }
  }

  async function handleCompleteTask(taskId: string) {
    if (!doneColumn || completingTaskId === taskId) return;

    const task = tasks.find((candidate) => candidate._id === taskId);
    if (!task || task.columnId === doneColumn._id) return;

    const destinationIndex = tasks.filter(
      (candidate) => candidate.columnId === doneColumn._id && candidate._id !== taskId
    ).length;
    const movedTasks = applyMove(tasks, taskId, doneColumn._id, destinationIndex).map(
      (candidate) =>
        candidate._id === taskId
          ? { ...candidate, status: 'done' as const }
          : candidate
    );
    const movedTask = movedTasks.find((candidate) => candidate._id === taskId);

    setCompletingTaskId(taskId);
    setLocalTasks(movedTasks);
    const persistCompletion = () => onUpdateTask(
        taskId,
        {
          columnId: doneColumn._id,
          position: movedTask?.position ?? destinationIndex,
          status: 'done',
        },
        movedTasks
      );
    try {
      await persistCompletion();
      setOperationError(undefined);
    } catch (err) {
      console.error('Failed to mark task done:', err);
      setLocalTasks(null);
      setOperationError({
        message: "Cove couldn't mark that task done. The board was restored.",
        retry: async () => {
          setCompletingTaskId(taskId);
          setLocalTasks(movedTasks);
          try {
            await persistCompletion();
          } finally {
            setCompletingTaskId(null);
            setLocalTasks(null);
          }
        },
      });
    } finally {
      setCompletingTaskId(null);
      setLocalTasks(null);
    }
  }

  async function handleSaveDetailTask(patch: UpdateTaskInput) {
    if (!detailTaskId || !detailTask) return;
    const nextPatch = patchWithColumnStatus(patch);

    if (
      nextPatch.columnId !== undefined &&
      nextPatch.columnId !== null &&
      nextPatch.columnId !== detailTask.columnId &&
      nextPatch.position === undefined
    ) {
      const endIndex = tasks.filter(
        (task) => task.columnId === nextPatch.columnId && task._id !== detailTaskId
      ).length;
      const movedTasks = applyMove(tasks, detailTaskId, nextPatch.columnId, endIndex).map(
        (task) =>
          task._id === detailTaskId
            ? { ...task, status: nextPatch.status ?? task.status }
            : task
      );
      const movedTask = movedTasks.find((task) => task._id === detailTaskId);

      await onUpdateTask(
        detailTaskId,
        {
          ...nextPatch,
          position: movedTask?.position ?? 0,
        },
        movedTasks
      );
      return;
    }

    await onUpdateTask(detailTaskId, nextPatch);
  }

  const activeTask = activeTaskId
    ? tasks.find((task) => task._id === activeTaskId) ?? null
    : null;
  const detailTask = detailTaskId
    ? tasks.find((task) => task._id === detailTaskId) ?? null
    : null;

  if (loading) {
    return (
      <div className="water-workspace flex h-full items-center justify-center p-6">
        <div className="water-empty-state px-6 py-5 text-sm">Loading board...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="water-workspace flex h-full items-center justify-center p-6">
        <div className="water-empty-state max-w-lg p-5 text-sm">
          <p className="font-medium text-foreground">Tasks could not load.</p>
          <p className="mt-1 text-muted-foreground">{error}</p>
          <button
            type="button"
            className="water-text-button mt-3 px-3 py-2"
            onClick={() => void onRetry()}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (showRecentlyDeleted && onRestoreTask) {
    return <RecentlyDeleted onClose={() => setShowRecentlyDeleted(false)} />;
  }

  return (
    <div className="water-workspace all-work-surface flex h-full flex-col">
      <header className="water-toolbar all-work-toolbar border-b px-5 pt-[62px]">
        <div className="all-work-toolbar-row flex items-center gap-3">
          <h1 className="water-workspace-title shrink-0">All Work</h1>

          <div className="relative ml-4 max-w-[320px] flex-1">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="text"
              aria-label="Search tasks"
              placeholder="Search tasks..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="water-control w-full py-2 pl-8 pr-3 text-[13.5px] placeholder:text-muted-foreground"
            />
          </div>

          <details className="all-work-filter relative ml-auto">
            <summary className="water-secondary-button flex cursor-pointer list-none items-center gap-2 px-4 py-2">
              Filter
              {(statusFilter !== 'all' || priorityFilter !== 'all') && (
                <span className="all-work-filter-dot" aria-label="Filters active" />
              )}
            </summary>
            <div className="water-popover absolute right-0 top-[calc(100%+8px)] z-20 w-[250px] space-y-3 p-4">
              <label className="block">
                Status
                <select
                  aria-label="Filter tasks"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                  className="water-control mt-1.5 w-full px-3 py-2 text-[13.5px]"
                >
                  <option value="all">All Tasks</option>
                  <option value="today">Must happen today</option>
                  <option value="not-started">Not Started</option>
                  <option value="in-progress">In Flight / Waiting</option>
                  <option value="blocked">Blocked</option>
                  <option value="done">Done</option>
                </select>
              </label>
              <label className="block">
                Priority
                <select
                  aria-label="Filter tasks by priority"
                  value={priorityFilter}
                  onChange={(e) => setPriorityFilter(e.target.value as PriorityFilter)}
                  className="water-control mt-1.5 w-full px-3 py-2 text-[13.5px]"
                >
                  <option value="all">All Priority</option>
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </label>
            </div>
          </details>

          <button
            onClick={() => setShowAddForm(!showAddForm)}
            aria-label={showAddForm ? 'Close add task form' : 'Open add task form'}
            className="water-primary-button px-4 py-2"
          >
            + Add Task
          </button>
        </div>

        <div className="all-work-toolbar-meta flex items-center gap-3">
          <span className="text-[12px] font-medium text-muted-foreground tabular-nums">
            Showing {filteredTasks.length} of {totalTasks} tasks
          </span>
          {onRestoreTask && (
            <button
              type="button"
              onClick={() => setShowRecentlyDeleted(true)}
              className="water-text-button px-2 py-1"
            >
              Recently deleted
            </button>
          )}
        </div>
      </header>

      {operationError && (
        <div role="alert" className="mx-5 mt-3 flex items-center gap-3 rounded-xl border border-accent-red/30 bg-accent-red/5 px-4 py-3 text-xs text-accent-red">
          <p className="min-w-0 flex-1">{operationError.message}</p>
          {operationError.retry && (
            <button
              type="button"
              disabled={retryingOperation}
              className="shrink-0 font-medium underline underline-offset-2 disabled:opacity-50"
              onClick={() => void retryOperation()}
            >
              {retryingOperation ? 'Retrying…' : 'Retry'}
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss operation error"
            className="shrink-0 text-base leading-none"
            onClick={() => setOperationError(undefined)}
          >
            ×
          </button>
        </div>
      )}

      {taskSessions.error && (
        <p role="alert" className="mx-5 mt-2 text-xs text-accent-red">
          {taskSessions.error}
        </p>
      )}

      {showAddForm && (
        <form onSubmit={handleAddTask} className="water-form-panel mx-5 mt-3 rounded-[20px] px-5 py-4">
          <div className="flex items-end gap-3 max-w-2xl">
            <div className="flex-1">
              <label className="mb-1.5 block">Title *</label>
              <input
                type="text"
                aria-label="New task title"
                value={newTask.title}
                onChange={(e) => setNewTask((prev) => ({ ...prev, title: e.target.value }))}
                placeholder="Task title"
                autoFocus
                className="w-full px-3 py-2"
              />
            </div>
            <div className="w-24">
              <label className="mb-1.5 block">Priority</label>
              <select
                aria-label="New task priority"
                value={newTask.priority}
                onChange={(e) =>
                  setNewTask((prev) => ({ ...prev, priority: e.target.value as 'low' | 'medium' | 'high' }))
                }
                className="w-full px-3 py-2"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <div className="w-36">
              <label className="mb-1.5 block">Due date</label>
              <input
                type="date"
                aria-label="New task due date"
                value={newTask.dueDate}
                onChange={(e) => setNewTask((prev) => ({ ...prev, dueDate: e.target.value }))}
                className="w-full px-3 py-2"
              />
            </div>
            <div className="flex gap-1.5 shrink-0">
              <button
                type="submit"
                disabled={!newTask.title.trim()}
                className="water-primary-button px-4 py-2 disabled:opacity-40"
              >
                Add Task
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowAddForm(false);
                  setNewTask({ title: '', priority: 'medium', dueDate: '', description: '', tags: '' });
                }}
                className="water-text-button px-3 py-2"
              >
                Cancel
              </button>
            </div>
          </div>
          <div className="flex items-end gap-3 max-w-2xl mt-2">
            <div className="flex-1">
              <label className="mb-1.5 block">Description</label>
              <input
                type="text"
                aria-label="New task description"
                value={newTask.description}
                onChange={(e) => setNewTask((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="Optional description"
                className="w-full px-3 py-2"
              />
            </div>
            <div className="flex-1">
              <label className="mb-1.5 block">Tags</label>
              <input
                type="text"
                aria-label="New task tags"
                value={newTask.tags}
                onChange={(e) => setNewTask((prev) => ({ ...prev, tags: e.target.value }))}
                placeholder="design, frontend (comma-separated)"
                className="w-full px-3 py-2"
              />
            </div>
          </div>
        </form>
      )}

      <div className="all-work-board flex-1 overflow-x-auto overflow-y-hidden">
        <DndContext
          sensors={sensors}
          collisionDetection={pointerFirstCollisionDetection}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          <div className="flex h-full min-w-max gap-[18px]">
            {columns.length === 0 ? (
              <div className="water-empty-state flex min-h-[180px] w-[360px] items-center justify-center px-6 text-center text-sm">
                No task lists yet.
              </div>
            ) : (
              columns.map((col) => (
                <Column
                  key={col._id}
                  column={col}
                  tasks={getTasksForColumn(col._id)}
                  onOpenDetail={setDetailTaskId}
                  onCompleteTask={handleCompleteTask}
                  completingTaskId={completingTaskId}
                />
              ))
            )}
          </div>

          <DragOverlay dropAnimation={null}>
            {activeTask ? (
              <TaskCard
                task={activeTask}
                onOpenDetail={() => {}}
                isOverlay
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      {detailTaskId && detailTask && (
        <TaskDetail
          taskId={detailTaskId}
          columns={columns}
          task={detailTask}
          onClose={() => setDetailTaskId(null)}
          onDeleted={handleTaskDeleted}
          onSaveTask={handleSaveDetailTask}
          onDeleteTask={() => onDeleteTask(detailTaskId)}
          onConfirmRecurrence={onConfirmRecurrence
            ? async (cadence) => {
                await onConfirmRecurrence(detailTaskId, cadence);
              }
            : undefined}
          sessionRun={getRuntimeMode() === 'local' ? taskSessions.latestByTaskId.get(detailTaskId) : undefined}
          sessionBusy={taskSessions.launchingTaskIds.has(detailTaskId)}
          sessionError={taskSessions.error}
          onLaunchSession={getRuntimeMode() === 'local' ? taskSessions.launch : undefined}
        />
      )}

      {archiveUndo && onRestoreTask && (
        <div className="quiet-undo" role="status" aria-live="polite">
          <span>“{archiveUndo.title}” moved to Recently deleted.</span>
          <button
            type="button"
            onClick={() => {
              const pending = archiveUndo;
              setArchiveUndo(null);
              void onRestoreTask(pending.id);
            }}
          >
            Undo
          </button>
          <span className="quiet-undo-timer" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}
