'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
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
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import { getRuntimeMode } from '@/lib/runtime/mode';
import {
  createTask as createSupabaseTask,
  createTaskColumn as createSupabaseTaskColumn,
  deleteTask as deleteSupabaseTask,
  listTaskColumns,
  listTasks,
  updateTask as updateSupabaseTask,
} from '@/lib/data/tasks';
import type {
  Task as SupabaseTask,
  TaskColumn as SupabaseTaskColumn,
} from '@/lib/data/types';
import { useDataChanged } from '@/lib/data/refresh-bus';
import Column from './Column';
import TaskCard from './TaskCard';
import TaskDetail from './TaskDetail';

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
  blocked: boolean;
  position: number;
  _creationTime: number;
  createdAt: number;
  updatedAt: number;
}

type TaskWithoutBlocked = Omit<TaskData, 'blocked'> & {
  tags?: string[];
};

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
  onSeed?: () => Promise<void>;
  onCreateTask: (input: CreateTaskInput) => Promise<void>;
  onUpdateTask: (id: string, patch: UpdateTaskInput, nextTasks?: TaskData[]) => Promise<void>;
  onDeleteTask: (id: string) => Promise<void>;
}

const BLOCKED_TAG = 'blocked';

const CANONICAL_COLUMNS = [
  {
    key: 'not-started',
    name: 'Not Started',
    aliases: ['Not Started', 'To Do'],
    position: 0,
  },
  {
    key: 'today',
    name: 'Must happen today',
    aliases: ['Must happen today', 'Needs to happen today', 'Today'],
    position: 10,
  },
  {
    key: 'in-progress',
    name: 'In Flight / Waiting',
    aliases: ['In Flight / Waiting', 'In Progress'],
    position: 20,
  },
  {
    key: 'done',
    name: 'Done',
    aliases: ['Done', 'Completed'],
    position: 30,
  },
] as const;

type ColumnStatus = (typeof CANONICAL_COLUMNS)[number]['key'];
type TaskStatus = 'open' | 'done' | 'archived';
type StatusFilter = 'all' | ColumnStatus | 'blocked';
type PriorityFilter = 'all' | 'low' | 'medium' | 'high';
const COLUMN_DROP_PREFIX = 'column-';
const LEGACY_BLOCKED_COLUMN_NAMES = new Set(['Blocked', 'Waiting']);

const pointerFirstCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  return pointerCollisions.length > 0
    ? pointerCollisions
    : closestCorners(args);
};

export default function KanbanBoard() {
  // Local and Supabase both use the REST-backed board; only Convex differs.
  if (getRuntimeMode() !== 'convex') return <SupabaseKanbanBoard />;
  return <ConvexKanbanBoard />;
}

function ConvexKanbanBoard() {
  const columnsQuery = useQuery(api.columns.list);
  const tasksQuery = useQuery(api.tasks.list);

  const seedMutation = useMutation(api.init.seed);
  const createTaskMutation = useMutation(api.tasks.create);
  const updateTaskMutation = useMutation(api.tasks.update);
  const removeTaskMutation = useMutation(api.tasks.remove);
  const currentTasks = ((tasksQuery ?? []) as TaskWithoutBlocked[]).map((task) => ({
    ...task,
    tags: task.tags ?? [],
    blocked: isTaskBlocked(task.tags ?? []),
  }));
  const handleSeed = useCallback(async () => {
    await seedMutation();
  }, [seedMutation]);

  return (
    <KanbanBoardContent
      columnsData={(columnsQuery ?? []) as ColumnData[]}
      tasksData={currentTasks}
      loading={columnsQuery === undefined || tasksQuery === undefined}
      onSeed={handleSeed}
      onCreateTask={async (input) => {
        if (!input.columnId) throw new Error('Task column is required.');
        await createTaskMutation({
          title: input.title,
          columnId: input.columnId as Id<'columns'>,
          priority: input.priority,
          description: input.description || undefined,
          dueDate: input.dueDate || undefined,
          tags: input.tags && input.tags.length > 0 ? input.tags : undefined,
        });
      }}
      onUpdateTask={async (id, patch, nextTasks) => {
        const changedTasks = nextTasks
          ? nextTasks.filter((nextTask) => {
              const currentTask = currentTasks.find((task) => task._id === nextTask._id);
              return (
                currentTask &&
                (currentTask.columnId !== nextTask.columnId || currentTask.position !== nextTask.position)
              );
            })
          : [];

        if (changedTasks.length > 0) {
          await Promise.all(
            changedTasks.map((task) =>
              updateTaskMutation({
                id: task._id as Id<'tasks'>,
                columnId: task.columnId as Id<'columns'>,
                position: task.position,
                ...(task._id === id
                  ? {
                      title: patch.title,
                      description: patch.description,
                      priority: patch.priority,
                      dueDate: patch.dueDate,
                      tags: patch.tags,
                    }
                  : {}),
              })
            )
          );
          return;
        }

        await updateTaskMutation({
          id: id as Id<'tasks'>,
          columnId: patch.columnId ? (patch.columnId as Id<'columns'>) : undefined,
          position: patch.position,
          title: patch.title,
          description: patch.description,
          priority: patch.priority,
          dueDate: patch.dueDate,
          tags: patch.tags,
        });
      }}
      onDeleteTask={async (id) => {
        await removeTaskMutation({ id: id as Id<'tasks'> });
      }}
    />
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
          ? new Date(`${patch.dueDate}T00:00:00`).toISOString()
          : null,
    tags: patch.tags,
    position: patch.position,
    status: patch.status,
  };
}

function toSupabaseDueAt(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value ? new Date(`${value}T00:00:00`).toISOString() : null;
}

function SupabaseKanbanBoard() {
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
    const missingColumns = CANONICAL_COLUMNS.filter(
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
    />
  );
}

function KanbanBoardContent({
  columnsData,
  tasksData,
  loading,
  error,
  onSeed,
  onCreateTask,
  onUpdateTask,
  onDeleteTask,
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

  const [newTask, setNewTask] = useState({
    title: '',
    priority: 'medium' as 'low' | 'medium' | 'high',
    dueDate: '',
    description: '',
    tags: '',
  });

  useEffect(() => {
    if (!seeded && onSeed) {
      onSeed().then(() => setSeeded(true)).catch((err) => {
        console.error('Failed to seed board:', err);
        setSeeded(true);
      });
    }
  }, [onSeed, seeded]);

  const rawColumns = columnsData;
  const columns = CANONICAL_COLUMNS.map((canonical) => {
    const column = rawColumns.find((rawColumn) =>
      canonical.aliases.some((alias) => alias === rawColumn.name)
    );
    return column
      ? { ...column, name: canonical.name, position: canonical.position }
      : undefined;
  }).filter(Boolean) as ColumnData[];

  const columnIdToStatus = new Map<string, ColumnStatus>();
  for (const col of columns) {
    const canonical =
      CANONICAL_COLUMNS.find((item) => item.aliases.some((alias) => alias === col.name)) ?? CANONICAL_COLUMNS[0];
    columnIdToStatus.set(col._id, canonical.key);
  }

  const inProgressColumn =
    columns.find((column) => columnIdToStatus.get(column._id) === 'in-progress');
  const legacyBlockedColumnIds = new Set(
    rawColumns
      .filter((column) => LEGACY_BLOCKED_COLUMN_NAMES.has(column.name))
      .map((column) => column._id)
  );
  const notStartedColumn =
    columns.find((column) => ['Not Started', 'To Do'].includes(column.name)) ?? columns[0];
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

  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const dragStartTasksRef = useRef<TaskData[] | null>(null);

  useEffect(() => {
    if (tasksData && localTasks) {
      setLocalTasks(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasksData]);

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

    try {
      await onUpdateTask(activeId, {
        columnId: overCol,
        position: destinationIndex,
        status: statusForColumn(overCol),
      }, movedTasks);
    } catch (err) {
      console.error('Failed to persist drag:', err);
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
    } catch (err) {
      console.error('Failed to add task:', err);
    }
  }

  function handleTaskDeleted() {
    setDetailTaskId(null);
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
    try {
      await onUpdateTask(
        taskId,
        {
          columnId: doneColumn._id,
          position: movedTask?.position ?? destinationIndex,
          status: 'done',
        },
        movedTasks
      );
    } catch (err) {
      console.error('Failed to mark task done:', err);
      setLocalTasks(null);
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
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        Loading board...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full p-6">
        <div className="max-w-lg rounded-lg border bg-card p-4 text-sm">
          <p className="font-medium text-foreground">Tasks could not load.</p>
          <p className="mt-1 text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-5 py-2.5 border-b transition-colors duration-200">
        <h1 className="text-sm font-semibold text-foreground">Tasks</h1>

        <div className="ml-4 flex items-center gap-2 flex-1">
          <div className="relative max-w-[240px] flex-1">
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
              className="w-full pl-8 pr-3 py-1.5 text-xs rounded-md border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-accent-blue/40"
            />
          </div>

          <select
            aria-label="Filter tasks"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="px-2 py-1.5 text-xs rounded-md border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-accent-blue/40"
          >
            <option value="all">All Tasks</option>
            <option value="today">Must happen today</option>
            <option value="not-started">Not Started</option>
            <option value="in-progress">In Flight / Waiting</option>
            <option value="blocked">Blocked</option>
            <option value="done">Done</option>
          </select>

          <select
            aria-label="Filter tasks by priority"
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value as PriorityFilter)}
            className="px-2 py-1.5 text-xs rounded-md border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-accent-blue/40"
          >
            <option value="all">All Priority</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>

          <span className="text-[11px] text-muted-foreground tabular-nums">
            {filteredTasks.length}/{totalTasks}
          </span>
        </div>

        <button
          onClick={() => setShowAddForm(!showAddForm)}
          aria-label={showAddForm ? 'Close add task form' : 'Open add task form'}
          className="ml-2 px-3 py-1.5 text-xs font-medium bg-foreground text-background rounded-md hover:opacity-90 transition-opacity duration-150"
        >
          + Add Task
        </button>
      </div>

      {showAddForm && (
        <form onSubmit={handleAddTask} className="px-5 py-3 border-b bg-muted/30 transition-colors duration-200">
          <div className="flex items-end gap-3 max-w-2xl">
            <div className="flex-1">
              <label className="block text-[11px] text-muted-foreground mb-1">Title *</label>
              <input
                type="text"
                aria-label="New task title"
                value={newTask.title}
                onChange={(e) => setNewTask((prev) => ({ ...prev, title: e.target.value }))}
                placeholder="Task title"
                autoFocus
                className="w-full px-2.5 py-1.5 text-sm rounded-md border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-accent-blue/40"
              />
            </div>
            <div className="w-24">
              <label className="block text-[11px] text-muted-foreground mb-1">Priority</label>
              <select
                aria-label="New task priority"
                value={newTask.priority}
                onChange={(e) =>
                  setNewTask((prev) => ({ ...prev, priority: e.target.value as 'low' | 'medium' | 'high' }))
                }
                className="w-full px-2 py-1.5 text-sm rounded-md border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-accent-blue/40"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <div className="w-36">
              <label className="block text-[11px] text-muted-foreground mb-1">Due date</label>
              <input
                type="date"
                aria-label="New task due date"
                value={newTask.dueDate}
                onChange={(e) => setNewTask((prev) => ({ ...prev, dueDate: e.target.value }))}
                className="w-full px-2 py-1.5 text-sm rounded-md border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-accent-blue/40"
              />
            </div>
            <div className="flex gap-1.5 shrink-0">
              <button
                type="submit"
                disabled={!newTask.title.trim()}
                className="px-3 py-1.5 text-xs font-medium bg-accent-blue text-white rounded-md hover:opacity-90 transition-opacity duration-150 disabled:opacity-40"
              >
                Add Task
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowAddForm(false);
                  setNewTask({ title: '', priority: 'medium', dueDate: '', description: '', tags: '' });
                }}
                className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors duration-150"
              >
                Cancel
              </button>
            </div>
          </div>
          <div className="flex items-end gap-3 max-w-2xl mt-2">
            <div className="flex-1">
              <label className="block text-[11px] text-muted-foreground mb-1">Description</label>
              <input
                type="text"
                aria-label="New task description"
                value={newTask.description}
                onChange={(e) => setNewTask((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="Optional description"
                className="w-full px-2.5 py-1.5 text-sm rounded-md border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-accent-blue/40"
              />
            </div>
            <div className="flex-1">
              <label className="block text-[11px] text-muted-foreground mb-1">Tags</label>
              <input
                type="text"
                aria-label="New task tags"
                value={newTask.tags}
                onChange={(e) => setNewTask((prev) => ({ ...prev, tags: e.target.value }))}
                placeholder="design, frontend (comma-separated)"
                className="w-full px-2.5 py-1.5 text-sm rounded-md border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-accent-blue/40"
              />
            </div>
          </div>
        </form>
      )}

      <div className="flex-1 overflow-x-auto overflow-y-hidden">
        <DndContext
          sensors={sensors}
          collisionDetection={pointerFirstCollisionDetection}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          <div className="flex gap-3 p-5 h-full min-w-max">
            {columns.map((col) => (
              <Column
                key={col._id}
                column={col}
                tasks={getTasksForColumn(col._id)}
                onOpenDetail={setDetailTaskId}
                onCompleteTask={handleCompleteTask}
                completingTaskId={completingTaskId}
              />
            ))}
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
        />
      )}
    </div>
  );
}
