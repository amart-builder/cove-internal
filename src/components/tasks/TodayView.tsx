'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useDataChanged } from '@/lib/data/refresh-bus';
import { retryBoardRequest } from '@/lib/data/board-refresh';
import {
  createTask as createRestTask,
  deleteTask as deleteRestTask,
  listTaskColumns,
  listTasks,
  updateTask as updateRestTask,
} from '@/lib/data/tasks';
import type { Task as RestTask, TaskColumn as RestTaskColumn } from '@/lib/data/types';
import {
  getQuietCurrent,
  recordDecision,
  reopenSuggestion,
  resolveSuggestion,
  type WorkSuggestion,
} from '@/lib/data/quiet-current';
import {
  canApplyArrivalRefresh,
  readArrivalSnapshot,
  upsertArrivalTask,
  writeArrivalSnapshot,
  type ArrivalColumn,
  type ArrivalTask,
  type ArrivalTaskStatus,
} from '@/lib/quiet-current/arrival-cache';
import { realTimeLabel } from '@/lib/quiet-current/presentation';
import { taskColumnKeyForName, type TaskColumnKey } from '@/lib/tasks/columns';
import { buildDayPlanCandidates } from '@/lib/day-plan/candidates';
import {
  combineSurfaceErrors,
  firstContinuingItem,
  helpfulProjectLabel,
  reorderDayPlanItems,
  selectBoardExecutionPresentation,
  selectCurrentExecutionRow,
  shouldShowNeedsSetupToStart,
  shortArrivalSummary,
} from '@/lib/day-plan/presentation';
import type { DayPlanExecutionRun, DayPlanItem } from '@/lib/day-plan/types';
import {
  planTaskReconciliation,
  reconciliationStateMatches,
  type ReconciliationTaskState,
} from '@/lib/day-plan/reconciliation';
import MorningArrival, { type MorningArrivalItem } from './MorningArrival';
import DaySettlement from './DaySettlement';
import DayRitualLayer, { DayRitualContentSwap } from './DayRitualLayer';
import { OpenInClaudeCode, RunStatusChip } from './ClaudeRunIndicators';
import ExecutionConfigPanel from './ExecutionConfigPanel';
import CurrentCanvas, { type CurrentPoint, type Tributary } from './CurrentCanvas';
import TaskDetail from './TaskDetail';
import useDayRitual from './useDayRitual';

type TaskStatus = ArrivalTaskStatus;
type ColumnData = ArrivalColumn;
type TaskData = ArrivalTask;

type CreateTaskInput = {
  id?: string;
  columnId: string;
  title: string;
  description?: string;
  priority?: 'low' | 'medium' | 'high';
  dueDate?: string;
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

type CandidateEvidence = {
  refreshedAt: string;
  freshness: 'current' | 'stale';
};

interface TodayExperienceProps {
  columns: ColumnData[];
  tasks: TaskData[];
  candidateEvidence?: CandidateEvidence;
  loading: boolean;
  error?: string;
  retry: () => Promise<void>;
  createTask: (input: CreateTaskInput) => Promise<string>;
  updateTask: (id: string, patch: UpdateTaskInput) => Promise<TaskData>;
  deleteTask: (id: string) => Promise<void>;
  onOpenAllWork?: () => void;
}

type TodayViewProps = {
  onOpenAllWork?: () => void;
};

type UndoAction = {
  message: string;
  run: () => Promise<void>;
};

function defaultPlanningModel(item: DayPlanItem): 'fable' {
  void item;
  return 'fable';
}

const JARVIS_HELD_TAG = 'jarvis-held';
const BLOCKED_TAG = 'blocked';
const FOCUS_KEY = 'forge.quiet-current.focus';
const NOTES_KEY = 'forge.quiet-current.notes';

// The hoisted DayRitualLayer stays mounted across ritual views; these stable ids let
// each view's heading label the dialog and receive focus after a content swap.
type OverlayRitualView = 'arrival' | 'settlement';
const RITUAL_TITLE_IDS: Record<OverlayRitualView, string> = {
  arrival: 'day-ritual-title-arrival',
  settlement: 'day-ritual-title-settlement',
};
const RITUAL_DESCRIPTION_IDS: Record<OverlayRitualView, string> = {
  arrival: 'day-ritual-description-arrival',
  settlement: 'day-ritual-description-settlement',
};

function hasTag(task: TaskData, tag: string): boolean {
  return task.tags.some((candidate) => candidate.trim().toLowerCase() === tag);
}

function isEmailDigest(task: TaskData): boolean {
  return hasTag(task, 'email') && task.title.trim().startsWith('Emails:');
}

function withTag(tags: string[], tag: string): string[] {
  return hasNormalizedTag(tags, tag) ? tags : [...tags, tag];
}

function withoutTag(tags: string[], tag: string): string[] {
  return tags.filter((candidate) => candidate.trim().toLowerCase() !== tag);
}

function hasNormalizedTag(tags: string[], tag: string): boolean {
  return tags.some((candidate) => candidate.trim().toLowerCase() === tag);
}

function findColumn(columns: ColumnData[], key: TaskColumnKey): ColumnData | undefined {
  return columns.find((column) => taskColumnKeyForName(column.name) === key);
}

function savedCurrentDescription(savedAt?: string): string {
  if (!savedAt) return 'your last saved current';
  const saved = new Date(savedAt);
  const label = saved.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `the current saved ${label}`;
}

function localDateInTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function proposalCommitError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (
    message ===
    "Cove couldn't accept that proposal or fully restore the task. Open All Work to check the task before trying again."
  ) {
    return message;
  }
  return "Cove couldn't add that proposal to your current. Open All Work to check the task, then try again.";
}

function readLocalValue(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalValue(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Focus and working notes remain usable in memory when storage is unavailable.
  }
}

function removeLocalValue(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // The in-memory focus state is still authoritative for this session.
  }
}

function toEpoch(value: string | null | undefined): number {
  const parsed = value ? new Date(value).getTime() : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

function normalizeRestColumn(column: RestTaskColumn): ColumnData {
  return { _id: column.id, name: column.name, position: column.position, createdAt: 0 };
}

function normalizeRestTask(task: RestTask): TaskData {
  const tags = task.tags ?? [];
  return {
    _id: task.id,
    columnId: task.column_id ?? '',
    title: task.title,
    description: task.description ?? '',
    priority: task.priority,
    dueDate: task.due_at?.slice(0, 10),
    dueAt: task.due_at ?? undefined,
    tags,
    status: task.status,
    blocked: hasNormalizedTag(tags, BLOCKED_TAG),
    position: task.position,
    createdAt: toEpoch(task.created_at),
    updatedAt: toEpoch(task.updated_at ?? task.created_at),
  };
}

function getGreeting(hour: number): string {
  if (hour < 12) return "Good morning. Let’s build something meaningful.";
  if (hour < 17) return 'Good afternoon. Keep the current clear.';
  return 'Good evening. Let the day settle.';
}

function getDayProgress(date: Date): number {
  const minutes = date.getHours() * 60 + date.getMinutes();
  const start = 6 * 60;
  const end = 22 * 60;
  return Math.max(0, Math.min(1, (minutes - start) / (end - start)));
}

function cubicPoint(progress: number): { x: number; y: number } {
  const inverse = 1 - progress;
  const start = { x: 18, y: 112 };
  const controlOne = { x: 116, y: 116 };
  const controlTwo = { x: 244, y: 76 };
  const end = { x: 306, y: 18 };
  return {
    x:
      inverse ** 3 * start.x +
      3 * inverse ** 2 * progress * controlOne.x +
      3 * inverse * progress ** 2 * controlTwo.x +
      progress ** 3 * end.x,
    y:
      inverse ** 3 * start.y +
      3 * inverse ** 2 * progress * controlOne.y +
      3 * inverse * progress ** 2 * controlTwo.y +
      progress ** 3 * end.y,
  };
}

function applyPatch(task: TaskData, patch: UpdateTaskInput): TaskData {
  return {
    ...task,
    columnId: patch.columnId === undefined ? task.columnId : (patch.columnId ?? ''),
    title: patch.title ?? task.title,
    description: patch.description ?? task.description,
    priority: patch.priority ?? task.priority,
    dueDate: patch.dueDate === undefined ? task.dueDate : (patch.dueDate ?? undefined),
    tags: patch.tags ?? task.tags,
    blocked:
      patch.tags === undefined ? task.blocked : hasNormalizedTag(patch.tags, BLOCKED_TAG),
    position: patch.position ?? task.position,
    status: patch.status ?? task.status,
    updatedAt: Date.now(),
  };
}

// Due dates are calendar dates, so they are stored at UTC midnight (see the
// note on toSupabaseDueAt in KanbanBoard). Local midnight would move the stored
// day for anyone at or ahead of UTC.
function toRestPatch(patch: UpdateTaskInput): Partial<RestTask> {
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

export default function TodayView({ onOpenAllWork }: TodayViewProps) {
  return <RestTodayView onOpenAllWork={onOpenAllWork} />;
}

function RestTodayView({ onOpenAllWork }: TodayViewProps) {
  const [columns, setColumns] = useState<ColumnData[]>([]);
  const [tasks, setTasks] = useState<TaskData[]>([]);
  const [candidateEvidence, setCandidateEvidence] = useState<CandidateEvidence>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const columnsRef = useRef<ColumnData[]>([]);
  const tasksRef = useRef<TaskData[]>([]);
  const confirmedTasksRef = useRef<TaskData[]>([]);
  const taskMutationRevisionsRef = useRef(new Map<string, number>());
  const confirmedTaskRevisionsRef = useRef(new Map<string, number>());
  const hasCredibleDataRef = useRef(false);
  const mutationRevisionRef = useRef(0);
  const inFlightMutationsRef = useRef(0);
  const refreshAfterMutationsRef = useRef(false);
  const lastSnapshotSavedAtRef = useRef<string | undefined>(undefined);
  const reloadRef = useRef<() => Promise<void>>(async () => undefined);

  const writeSnapshot = useCallback((nextColumns: ColumnData[], nextTasks: TaskData[]) => {
    const savedAt = new Date();
    try {
      if (writeArrivalSnapshot(window.localStorage, nextColumns, nextTasks, savedAt)) {
        lastSnapshotSavedAtRef.current = savedAt.toISOString();
      }
    } catch {
      // Storage can be unavailable in private or locked-down browser contexts.
    }
  }, []);

  const persistSnapshot = useCallback((nextColumns: ColumnData[], nextTasks: TaskData[]) => {
    columnsRef.current = nextColumns;
    tasksRef.current = nextTasks;
    confirmedTasksRef.current = nextTasks;
    writeSnapshot(nextColumns, nextTasks);
  }, [writeSnapshot]);

  const updateVisibleTasks = useCallback(
    (updater: (current: TaskData[]) => TaskData[]) => {
      const next = updater(tasksRef.current);
      tasksRef.current = next;
      setTasks(next);
    },
    [],
  );

  const persistConfirmedSnapshot = useCallback(() => {
    if (hasCredibleDataRef.current) {
      writeSnapshot(columnsRef.current, confirmedTasksRef.current);
    }
  }, [writeSnapshot]);

  const reload = useCallback(async () => {
    const requestRevision = mutationRevisionRef.current;
    const hadCredibleData = hasCredibleDataRef.current;
    if (!hadCredibleData) setLoading(true);
    try {
      const [columnsResult, tasksResult] = await Promise.allSettled([
        retryBoardRequest(listTaskColumns),
        retryBoardRequest(listTasks),
      ]);
      const normalizedColumns = columnsResult.status === 'fulfilled'
        ? columnsResult.value.map(normalizeRestColumn)
        : columnsRef.current;
      const normalizedTasks = tasksResult.status === 'fulfilled'
        ? tasksResult.value.map(normalizeRestTask)
        : tasksRef.current;
      const hasRequiredColumns = Boolean(
        findColumn(normalizedColumns, 'today') &&
          findColumn(normalizedColumns, 'done'),
      );

      if (columnsResult.status === 'fulfilled' && !hasRequiredColumns) {
        if (!hadCredibleData) {
          columnsRef.current = normalizedColumns;
          tasksRef.current = normalizedTasks;
          setColumns(normalizedColumns);
          setTasks(normalizedTasks);
        }
        setError(
          hadCredibleData
            ? `Cove couldn't refresh because the Today or Done list is missing. You're still seeing ${savedCurrentDescription(lastSnapshotSavedAtRef.current)}. Open All Work to restore the list.`
            : 'Cove needs both a Today list and a Done list. Open All Work to restore them, then try again.',
        );
        return;
      }

      if (columnsResult.status === 'fulfilled') {
        columnsRef.current = normalizedColumns;
        setColumns(normalizedColumns);
      }
      const canApplyTasks = tasksResult.status === 'fulfilled' &&
        canApplyArrivalRefresh({
          requestRevision,
          currentRevision: mutationRevisionRef.current,
          inFlightMutations: inFlightMutationsRef.current,
        });
      if (canApplyTasks) {
        hasCredibleDataRef.current = hasRequiredColumns;
        setTasks(normalizedTasks);
        if (hasRequiredColumns) {
          persistSnapshot(normalizedColumns, normalizedTasks);
        } else {
          tasksRef.current = normalizedTasks;
          confirmedTasksRef.current = normalizedTasks;
        }
        setCandidateEvidence({
          refreshedAt: new Date().toISOString(),
          freshness: 'current',
        });
      } else if (tasksResult.status === 'fulfilled') {
        refreshAfterMutationsRef.current = true;
        if (inFlightMutationsRef.current === 0) {
          refreshAfterMutationsRef.current = false;
          window.setTimeout(() => void reloadRef.current(), 0);
        }
      }

      if (columnsResult.status === 'rejected' || tasksResult.status === 'rejected') {
        setError("Some data didn't refresh — retrying…");
      } else {
        setError(undefined);
      }
    } finally {
      setLoading(false);
    }
  }, [persistSnapshot]);
  reloadRef.current = reload;
  useDataChanged(['tasks', 'task_columns'], () => void reload());

  const beginMutation = useCallback(() => {
    mutationRevisionRef.current += 1;
    inFlightMutationsRef.current += 1;
  }, []);

  const settleMutation = useCallback(async (forceRefresh: boolean) => {
    inFlightMutationsRef.current = Math.max(0, inFlightMutationsRef.current - 1);
    if (forceRefresh) refreshAfterMutationsRef.current = true;
    if (inFlightMutationsRef.current === 0 && refreshAfterMutationsRef.current) {
      refreshAfterMutationsRef.current = false;
      await reloadRef.current();
    }
  }, []);

  useLayoutEffect(() => {
    let cached: ReturnType<typeof readArrivalSnapshot>;
    try {
      cached = readArrivalSnapshot(window.localStorage);
    } catch {
      return;
    }
    if (!cached) return;
    const hasRequiredColumns = Boolean(
      findColumn(cached.columns, 'today') && findColumn(cached.columns, 'done'),
    );
    if (!hasRequiredColumns) return;
    hasCredibleDataRef.current = true;
    lastSnapshotSavedAtRef.current = cached.savedAt;
    columnsRef.current = cached.columns;
    tasksRef.current = cached.tasks;
    confirmedTasksRef.current = cached.tasks;
    setColumns(cached.columns);
    setTasks(cached.tasks);
    setCandidateEvidence({ refreshedAt: cached.savedAt, freshness: 'stale' });
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!error) return;
    const timer = window.setInterval(() => void reloadRef.current(), 30_000);
    return () => window.clearInterval(timer);
  }, [error]);

  return (
    <TodayExperience
      columns={columns}
      tasks={tasks}
      candidateEvidence={candidateEvidence}
      loading={loading}
      error={error}
      retry={reload}
      createTask={async (input) => {
        beginMutation();
        let forceRefresh = false;
        try {
          const nextPosition =
            tasksRef.current
              .filter((task) => task.columnId === input.columnId)
              .reduce((maximum, task) => Math.max(maximum, task.position), -1) + 1;
          const created = await createRestTask({
            id: input.id,
            column_id: input.columnId,
            title: input.title,
            description: input.description,
            priority: input.priority,
            due_at: input.dueDate
              ? new Date(`${input.dueDate}T00:00:00Z`).toISOString()
              : undefined,
            tags: input.tags,
            position: nextPosition,
            source_type: 'quiet_current',
          });
          const normalized = normalizeRestTask(created);
          confirmedTasksRef.current = upsertArrivalTask(
            confirmedTasksRef.current,
            normalized,
          );
          updateVisibleTasks((current) => upsertArrivalTask(current, normalized));
          persistConfirmedSnapshot();
          return normalized._id;
        } catch (nextError) {
          forceRefresh = true;
          throw nextError;
        } finally {
          await settleMutation(forceRefresh);
        }
      }}
      updateTask={async (id, patch) => {
        beginMutation();
        let forceRefresh = false;
        const taskRevision = (taskMutationRevisionsRef.current.get(id) ?? 0) + 1;
        taskMutationRevisionsRef.current.set(id, taskRevision);
        updateVisibleTasks(
          (current) =>
            current.map((task) => (task._id === id ? applyPatch(task, patch) : task)),
        );
        try {
          const updated = await updateRestTask(id, toRestPatch(patch));
          const normalized = normalizeRestTask(updated);
          const confirmedRevision = confirmedTaskRevisionsRef.current.get(id) ?? 0;
          if (taskRevision > confirmedRevision) {
            confirmedTaskRevisionsRef.current.set(id, taskRevision);
            confirmedTasksRef.current = upsertArrivalTask(
              confirmedTasksRef.current,
              normalized,
            );
            persistConfirmedSnapshot();
          }
          if (taskMutationRevisionsRef.current.get(id) === taskRevision) {
            updateVisibleTasks((current) =>
              current.map((task) => (task._id === id ? normalized : task)),
            );
          } else {
            forceRefresh = true;
          }
          return normalized;
        } catch (nextError) {
          if (taskMutationRevisionsRef.current.get(id) === taskRevision) {
            const confirmedTask = confirmedTasksRef.current.find((task) => task._id === id);
            if (confirmedTask) {
              updateVisibleTasks((current) => upsertArrivalTask(current, confirmedTask));
            } else {
              updateVisibleTasks((current) => current.filter((task) => task._id !== id));
            }
            persistConfirmedSnapshot();
          }
          forceRefresh = true;
          throw nextError;
        } finally {
          await settleMutation(forceRefresh);
        }
      }}
      deleteTask={async (id) => {
        beginMutation();
        let forceRefresh = false;
        const taskRevision = (taskMutationRevisionsRef.current.get(id) ?? 0) + 1;
        taskMutationRevisionsRef.current.set(id, taskRevision);
        updateVisibleTasks((current) => current.filter((task) => task._id !== id));
        try {
          await deleteRestTask(id);
          const confirmedRevision = confirmedTaskRevisionsRef.current.get(id) ?? 0;
          if (taskRevision > confirmedRevision) {
            confirmedTaskRevisionsRef.current.set(id, taskRevision);
            confirmedTasksRef.current = confirmedTasksRef.current.filter(
              (task) => task._id !== id,
            );
            persistConfirmedSnapshot();
          }
          if (taskMutationRevisionsRef.current.get(id) === taskRevision) {
            updateVisibleTasks((current) => current.filter((task) => task._id !== id));
          } else {
            forceRefresh = true;
          }
        } catch (nextError) {
          if (taskMutationRevisionsRef.current.get(id) === taskRevision) {
            const confirmedTask = confirmedTasksRef.current.find((task) => task._id === id);
            if (confirmedTask) {
              updateVisibleTasks((current) => upsertArrivalTask(current, confirmedTask));
            } else {
              updateVisibleTasks((current) => current.filter((task) => task._id !== id));
            }
            persistConfirmedSnapshot();
          }
          forceRefresh = true;
          throw nextError;
        } finally {
          await settleMutation(forceRefresh);
        }
      }}
      onOpenAllWork={onOpenAllWork}
    />
  );
}

function TodayExperience({
  columns,
  tasks,
  candidateEvidence,
  loading,
  error,
  retry,
  createTask,
  updateTask,
  deleteTask,
  onOpenAllWork,
}: TodayExperienceProps) {
  const [suggestions, setSuggestions] = useState<WorkSuggestion[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(true);
  const [surfaceError, setSurfaceError] = useState<string>();
  const [settlementNote, setSettlementNote] = useState('');
  const [now, setNow] = useState(() => new Date());
  // Must start false, matching the server, and never read document.hidden or the
  // reduced-motion query during the first render. CurrentCanvas renders the two
  // ambient glints conditionally on this, so a client-only true here gives the
  // server and the browser different SVG children, and React throws out the
  // hydration of the entire page. The effect below applies the real value on
  // mount, so nothing is lost by deferring it one frame.
  const [ambientPaused, setAmbientPaused] = useState(false);
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(() => {
    return readLocalValue(FOCUS_KEY);
  });
  const [capture, setCapture] = useState('');
  const [capturing, setCapturing] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [focusExpanded, setFocusExpanded] = useState(false);
  const [wakeOpen, setWakeOpen] = useState(false);
  const [showAllDownstream, setShowAllDownstream] = useState(false);
  const [expandedSuggestionId, setExpandedSuggestionId] = useState<string | null>(null);
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  const [completingTaskId, setCompletingTaskId] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoAction | null>(null);
  const [undoPaused, setUndoPaused] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [dismissMenuId, setDismissMenuId] = useState<string | null>(null);
  const [editingSuggestionId, setEditingSuggestionId] = useState<string | null>(null);
  const [suggestionDraft, setSuggestionDraft] = useState({ title: '', description: '' });
  const [expandedArrivalItemId, setExpandedArrivalItemId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(readLocalValue(NOTES_KEY) ?? '{}') as Record<string, string>;
    } catch {
      return {};
    }
  });
  const focusHeadingRef = useRef<HTMLHeadingElement>(null);
  const livingCurrentRef = useRef<HTMLDivElement>(null);
  const searchDialogRef = useRef<HTMLDivElement>(null);
  const searchReturnFocusRef = useRef<HTMLElement | null>(null);
  const undoRunningRef = useRef(false);
  const reconciliationRunningRef = useRef(false);
  const taskMutationRunningRef = useRef(false);
  const recommendedFocusKeyRef = useRef<string | undefined>(undefined);
  // MorningArrival publishes its staged escape handler here so the hoisted layer can call it.
  const arrivalEscapeRef = useRef<(() => void) | null>(null);

  const todayColumn = findColumn(columns, 'today');
  const notStartedColumn = findColumn(columns, 'not-started');
  const inFlightColumn = findColumn(columns, 'in-progress');
  const doneColumn = findColumn(columns, 'done');

  const openTasks = useMemo(
    () =>
      tasks.filter(
        (task) =>
          task.status !== 'archived' &&
          task.status !== 'done' &&
          task.columnId !== doneColumn?._id,
      ),
    [doneColumn?._id, tasks],
  );

  const jarvisTasks = useMemo(
    () =>
      openTasks
        .filter((task) => hasTag(task, JARVIS_HELD_TAG) || isEmailDigest(task))
        .sort((left, right) => left.position - right.position),
    [openTasks],
  );

  const commitments = useMemo(() => {
    const activeColumnIds = new Set(
      [todayColumn?._id, inFlightColumn?._id].filter(Boolean) as string[],
    );
    return openTasks
      .filter(
        (task) =>
          activeColumnIds.has(task.columnId) &&
          !hasTag(task, JARVIS_HELD_TAG) &&
          !isEmailDigest(task),
      )
      .sort((left, right) => {
        const leftFlight = left.columnId === inFlightColumn?._id ? 0 : 1;
        const rightFlight = right.columnId === inFlightColumn?._id ? 0 : 1;
        return leftFlight - rightFlight || left.position - right.position;
      });
  }, [inFlightColumn?._id, openTasks, todayColumn?._id]);

  const dayPlanCandidates = useMemo(() => {
    const refreshedAt = candidateEvidence?.refreshedAt ?? new Date(0).toISOString();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const localDate = localDateInTimezone(new Date(), timezone);
    // A pool of up to ten deterministic candidates: the Morning Brief overlay
    // ranks within this pool server-side, and the plan still keeps three.
    return buildDayPlanCandidates({
      localDate,
      timezone,
      tasks: commitments.map((task) => ({
        id: task._id,
        title: task.title,
        description: task.description,
        outcome: task.description || task.title,
        priority: task.priority,
        dueAt: task.dueAt,
        position: task.position,
        column: task.columnId === inFlightColumn?._id ? 'in_flight' : 'today',
        status: task.status ?? 'open',
        updatedAt: task.updatedAt > 0 ? new Date(task.updatedAt).toISOString() : refreshedAt,
        refreshedAt,
        freshness: candidateEvidence?.freshness ?? 'stale',
        project: task.tags[0],
      })),
    }, 10);
  }, [candidateEvidence, commitments, inFlightColumn?._id]);

  const dayRitual = useDayRitual({
    enabled: !loading && Boolean(todayColumn && doneColumn),
    candidates: dayPlanCandidates,
    candidatesReady: candidateEvidence?.freshness === 'current',
  });
  const ritualView: OverlayRitualView | undefined =
    dayRitual.view === 'arrival' ||
    dayRitual.view === 'settlement'
      ? dayRitual.view
      : undefined;

  const doneToday = useMemo(() => {
    const today = new Date();
    return tasks
      .filter((task) => {
        if (task.columnId !== doneColumn?._id && task.status !== 'done') return false;
        const updated = new Date(task.updatedAt);
        return (
          updated.getFullYear() === today.getFullYear() &&
          updated.getMonth() === today.getMonth() &&
          updated.getDate() === today.getDate()
        );
      })
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }, [doneColumn?._id, tasks]);

  const focusedTask = focusedTaskId
    ? openTasks.find((task) => task._id === focusedTaskId) ?? null
    : null;
  const focusedIsWithJarvis = Boolean(
    focusedTask && hasTag(focusedTask, JARVIS_HELD_TAG),
  );
  const focusedIsBrief = Boolean(focusedTask && isEmailDigest(focusedTask));
  const focusedIsOutsideToday = Boolean(
    focusedTask && !commitments.some((task) => task._id === focusedTask._id),
  );
  const detailTask = detailTaskId
    ? tasks.find((task) => task._id === detailTaskId) ?? null
    : null;
  const activeSuggestions = suggestions
    .filter((suggestion) => suggestion.state === 'proposed' || suggestion.state === 'refined')
    .sort((left, right) => {
      const leftResurfaced = left.resurfacedFromDeferredAt ? 1 : 0;
      const rightResurfaced = right.resurfacedFromDeferredAt ? 1 : 0;
      return (
        rightResurfaced - leftResurfaced ||
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
      );
    })
    .slice(0, 3);

  const loadSuggestions = useCallback(async () => {
    try {
      const snapshot = await getQuietCurrent();
      setSuggestions(snapshot.suggestions);
      setSurfaceError(undefined);
    } catch {
      setSurfaceError("Cove couldn't refresh Jarvis suggestions. This doesn't touch your committed tasks.");
    } finally {
      setSuggestionsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSuggestions();
  }, [loadSuggestions]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 30000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateAmbientMotion = () => {
      setAmbientPaused(document.hidden || reducedMotion.matches);
    };
    document.addEventListener('visibilitychange', updateAmbientMotion);
    reducedMotion.addEventListener('change', updateAmbientMotion);
    updateAmbientMotion();
    return () => {
      document.removeEventListener('visibilitychange', updateAmbientMotion);
      reducedMotion.removeEventListener('change', updateAmbientMotion);
    };
  }, []);

  useEffect(() => {
    if (
      loading ||
      dayRitual.view === 'checking' ||
      dayRitual.ritualOpen ||
      focusedTask ||
      commitments.length === 0
    ) return;
    const first = commitments[0];
    setFocusedTaskId(first._id);
    writeLocalValue(FOCUS_KEY, first._id);
  }, [commitments, dayRitual.ritualOpen, dayRitual.view, focusedTask, loading]);

  useEffect(() => {
    if (!undo || undoPaused) return;
    const timeout = window.setTimeout(() => setUndo(null), 10000);
    return () => window.clearTimeout(timeout);
  }, [undo, undoPaused]);

  useEffect(() => {
    if (!dismissMenuId) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      const element = event.target as Element | null;
      const menu = element?.closest('[data-dismiss-menu]');
      if (menu?.getAttribute('data-dismiss-menu') !== dismissMenuId) {
        setDismissMenuId(null);
      }
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [dismissMenuId]);

  const openSearch = useCallback(() => {
    searchReturnFocusRef.current = document.activeElement as HTMLElement | null;
    setSearchOpen(true);
  }, []);

  const closeSearch = useCallback((restoreFocus = true) => {
    setSearchOpen(false);
    setSearchQuery('');
    if (restoreFocus) {
      window.requestAnimationFrame(() => searchReturnFocusRef.current?.focus());
    }
  }, []);

  const focusTask = useCallback(
    (taskId: string, source: string) => {
      const previous = focusedTaskId;
      setFocusExpanded(false);
      setFocusedTaskId(taskId);
      writeLocalValue(FOCUS_KEY, taskId);
      void recordDecision({
        eventType: 'focus_change',
        entityId: taskId,
        before: { focusedTaskId: previous },
        after: { focusedTaskId: taskId },
        source,
      }).catch(() => undefined);
      window.requestAnimationFrame(() => {
        focusHeadingRef.current?.focus({ preventScroll: true });
        focusHeadingRef.current?.closest('.current-now-shell')?.scrollIntoView({
          behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
          block: 'center',
        });
      });
    },
    [focusedTaskId],
  );

  useEffect(() => {
    const plan = dayRitual.plan;
    const taskId = plan?.recommendedFirstTaskId;
    if (!plan || plan.state !== 'active' || !taskId || !plan.confirmedAt) return;
    if (!openTasks.some((task) => task._id === taskId)) return;
    const key = `${plan.id}:${plan.confirmedAt}:${taskId}`;
    if (recommendedFocusKeyRef.current === key) return;
    recommendedFocusKeyRef.current = key;
    if (focusedTaskId !== taskId) focusTask(taskId, 'recommended_start');
  }, [dayRitual.plan, focusTask, focusedTaskId, openTasks]);

  const closeTransientSurfaces = useCallback(() => {
    setCaptureOpen(false);
    setDetailTaskId(null);
    setExpandedSuggestionId(null);
    setEditingSuggestionId(null);
    if (searchOpen) closeSearch(false);
  }, [closeSearch, searchOpen]);

  const openMorningArrival = useCallback(async () => {
    closeTransientSurfaces();
    setSurfaceError(undefined);
    try {
      await dayRitual.openArrival();
    } catch (nextError) {
      setSurfaceError(
        nextError instanceof Error ? nextError.message : "Cove couldn't open Morning Arrival.",
      );
    }
  }, [closeTransientSurfaces, dayRitual]);

  const openDaySettlement = useCallback(async () => {
    closeTransientSurfaces();
    setSurfaceError(undefined);
    try {
      await dayRitual.openSettlement();
    } catch (nextError) {
      setSurfaceError(
        nextError instanceof Error ? nextError.message : "Cove couldn't open Day Settlement.",
      );
    }
  }, [closeTransientSurfaces, dayRitual]);

  const startPlannedDay = useCallback(async () => {
    setSurfaceError(undefined);
    try {
      const taskId = await dayRitual.startDay();
      if (taskId) focusTask(taskId, 'start_my_day');
    } catch (nextError) {
      setSurfaceError(
        nextError instanceof Error ? nextError.message : "Cove couldn't start the planned day.",
      );
    }
  }, [dayRitual, focusTask]);

  const reconcileDayPlanActions = useCallback(async (
    reconciliations = dayRitual.pendingReconciliations,
  ) => {
    if (reconciliationRunningRef.current || reconciliations.length === 0) return;
    if (candidateEvidence?.freshness !== 'current') {
      throw new Error('Cove needs a fresh task refresh before reconciling the closed day.');
    }
    reconciliationRunningRef.current = true;
    try {
      const taskStateById = new Map<string, ReconciliationTaskState>(
        tasks.map((task) => [
          task._id,
          { columnId: task.columnId, status: task.status },
        ]),
      );
      for (const reconciliation of reconciliations) {
        const currentState = taskStateById.get(reconciliation.taskId);
        const step = planTaskReconciliation(reconciliation.action, currentState, {
          notStartedId: notStartedColumn?._id,
          todayId: todayColumn?._id,
        });
        if (step.patch) {
          const updated = await updateTask(reconciliation.taskId, step.patch);
          taskStateById.set(reconciliation.taskId, {
            columnId: updated.columnId,
            status: updated.status,
          });
        } else if (step.nextState) {
          taskStateById.set(reconciliation.taskId, step.nextState);
        }
        if (!reconciliationStateMatches(
          taskStateById.get(reconciliation.taskId),
          step.nextState,
        )) {
          throw new Error('Cove could not verify the task reconciliation result.');
        }
        await dayRitual.acknowledgeReconciliation(reconciliation.id);
      }
    } finally {
      reconciliationRunningRef.current = false;
    }
  }, [candidateEvidence?.freshness, dayRitual, notStartedColumn, tasks, todayColumn, updateTask]);

  const reconcileAssistantTaskMutations = useCallback(async () => {
    const mutations = dayRitual.pendingTaskMutations;
    if (taskMutationRunningRef.current || mutations.length === 0 || !todayColumn || !doneColumn) return;
    if (candidateEvidence?.freshness !== 'current') return;
    taskMutationRunningRef.current = true;
    try {
      for (const mutation of mutations) {
        const existing = tasks.find((task) => task._id === mutation.taskId);
        if (mutation.action === 'create') {
          if (!existing) {
            const createdId = await createTask({
              id: mutation.taskId,
              columnId: todayColumn._id,
              title: mutation.title ?? 'Untitled priority',
              description: mutation.description,
              priority: mutation.priority,
              tags: mutation.project ? [mutation.project] : [],
            });
            if (createdId !== mutation.taskId) throw new Error('Cove could not preserve the new task identity.');
          }
        } else if (mutation.action === 'update') {
          if (!existing) throw new Error('The task Claude tried to update no longer exists.');
          await updateTask(mutation.taskId, {
            title: mutation.title,
            description: mutation.description,
          });
        } else if (existing && (existing.status !== 'done' || existing.columnId !== doneColumn._id)) {
          await updateTask(mutation.taskId, {
            columnId: doneColumn._id,
            status: 'done',
            position: tasks.filter((task) => task.columnId === doneColumn._id).length,
          });
        }
        await dayRitual.acknowledgeTaskMutation(mutation.id);
      }
    } finally {
      taskMutationRunningRef.current = false;
    }
  }, [candidateEvidence?.freshness, createTask, dayRitual, doneColumn, tasks, todayColumn, updateTask]);

  useEffect(() => {
    if (loading || dayRitual.pendingTaskMutations.length === 0) return;
    void reconcileAssistantTaskMutations().catch((nextError) => {
      setSurfaceError(nextError instanceof Error
        ? `Cove updated the plan but still needs to sync a task: ${nextError.message}`
        : 'Cove updated the plan but still needs to sync a task.');
    });
  }, [dayRitual.pendingTaskMutations, loading, reconcileAssistantTaskMutations]);

  const closeSettledDay = useCallback(async () => {
    const currentPlan = dayRitual.plan;
    if (!currentPlan) return;
    if (candidateEvidence?.freshness !== 'current') {
      setSurfaceError('Refresh Cove before closing the day so task state is current.');
      return;
    }
    if (
      !notStartedColumn &&
      currentPlan.items.some((item) => item.settlementDecision?.disposition === 'defer')
    ) {
      setSurfaceError('Cove needs a Not Started or To Do list before it can defer work. Choose Progress, Carry, or Drop instead.');
      return;
    }
    const completedHumanTaskIds = currentPlan.items
      .filter((item) => item.decision === 'completed')
      .map((item) => item.taskId);
    setSurfaceError(undefined);
    try {
      const result = await dayRitual.commitSettlement(completedHumanTaskIds, settlementNote);
      setSettlementNote('');
      const reconciliations = result.pendingReconciliations ?? [];
      await reconcileDayPlanActions(reconciliations);
      const excludedTaskIds = new Set(
        reconciliations
          .filter(
            (reconciliation) =>
              reconciliation.action === 'defer' || reconciliation.action === 'drop',
          )
          .map((reconciliation) => reconciliation.taskId),
      );
      await dayRitual.openCurrentDayAfterSettlement(
        currentPlan.localDate,
        excludedTaskIds,
      );
    } catch (nextError) {
      setSurfaceError(
        nextError instanceof Error
          ? nextError.message
          : "Cove couldn't finish reconciling the closed day.",
      );
    }
  }, [candidateEvidence?.freshness, dayRitual, notStartedColumn, reconcileDayPlanActions, settlementNote]);

  useEffect(() => {
    if (
      loading ||
      candidateEvidence?.freshness !== 'current' ||
      dayRitual.pendingReconciliations.length === 0 ||
      reconciliationRunningRef.current
    ) return;
    const pending = dayRitual.pendingReconciliations;
    const latestSnapshot = dayRitual.latestSnapshot;
    const openCurrentDayAfterSettlement = dayRitual.openCurrentDayAfterSettlement;
    void (async () => {
      try {
        await reconcileDayPlanActions(pending);
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        if (latestSnapshot) {
          const excludedTaskIds = new Set(
            pending
              .filter(
                (reconciliation) =>
                  reconciliation.action === 'defer' || reconciliation.action === 'drop',
              )
              .map((reconciliation) => reconciliation.taskId),
          );
          await openCurrentDayAfterSettlement(
            latestSnapshot.localDate,
            excludedTaskIds,
          );
        }
      } catch (nextError) {
        setSurfaceError(
          nextError instanceof Error
            ? `The day is closed, but Cove still needs to reconcile a task: ${nextError.message}`
            : 'The day is closed, but Cove still needs to reconcile a task.',
        );
      }
    })();
  }, [
    candidateEvidence?.freshness,
    dayRitual.latestSnapshot,
    dayRitual.openCurrentDayAfterSettlement,
    dayRitual.pendingReconciliations,
    loading,
    reconcileDayPlanActions,
  ]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (dayRitual.view === 'checking' || dayRitual.ritualOpen) return;
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openSearch();
        return;
      }
      if (searchOpen) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeSearch();
          return;
        }
        if (event.key === 'Tab') {
          const focusable = Array.from(
            searchDialogRef.current?.querySelectorAll<HTMLElement>(
              'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
            ) ?? [],
          );
          if (focusable.length > 0) {
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }
        return;
      }
      if (event.key === 'Escape' && dismissMenuId) {
        setDismissMenuId(null);
        return;
      }
      if (isTyping || searchOpen || commitments.length === 0) return;
      if (!['j', 'k', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      const currentIndex = commitments.findIndex((task) => task._id === focusedTaskId);
      const direction = event.key === 'j' || event.key === 'ArrowDown' ? 1 : -1;
      const baseIndex = currentIndex < 0 ? (direction > 0 ? -1 : 0) : currentIndex;
      const nextIndex = (baseIndex + direction + commitments.length) % commitments.length;
      focusTask(commitments[nextIndex]._id, 'keyboard');
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeSearch, commitments, dayRitual.ritualOpen, dayRitual.view, dismissMenuId, focusTask, focusedTaskId, openSearch, searchOpen]);

  async function handleCapture(event: React.FormEvent) {
    event.preventDefault();
    const title = capture.trim();
    if (!title || !todayColumn || capturing) return;
    setCapturing(true);
    setSurfaceError(undefined);
    try {
      const taskId = await createTask({
        columnId: todayColumn._id,
        title,
        tags: ['captured-today'],
        priority: 'medium',
      });
      await recordDecision({
        eventType: 'plan_add',
        entityId: taskId,
        after: { title, commitment: 'ink' },
        source: 'what_changed',
      });
      setCapture('');
      setCaptureOpen(false);
      focusTask(taskId, 'capture');
    } catch {
      setSurfaceError("Cove couldn't finish that addition. Refresh the current to confirm the task, then try again.");
    } finally {
      setCapturing(false);
    }
  }

  function showUndo(action: UndoAction) {
    setUndoPaused(false);
    setUndo(action);
  }

  async function runUndo() {
    if (!undo || undoRunningRef.current) return;
    undoRunningRef.current = true;
    const action = undo;
    setUndo(null);
    try {
      await action.run();
    } catch {
      setSurfaceError("Cove couldn't undo that change. Open All Work to check the task, then try again.");
    } finally {
      undoRunningRef.current = false;
    }
  }

  async function commitSuggestion(
    suggestion: WorkSuggestion,
    source: 'explicit_accept' | 'began_work',
  ) {
    if (!todayColumn) return;
    setSurfaceError(undefined);
    let resolvedTaskId: string | undefined;
    const targetTask = suggestion.targetTaskId
      ? tasks.find((task) => task._id === suggestion.targetTaskId)
      : undefined;
    if (
      (suggestion.kind === 'returned_work' || suggestion.kind === 'observed_progress') &&
      !targetTask
    ) {
      setSurfaceError('The task this suggestion refers to no longer exists.');
      return;
    }
    const targetBefore = targetTask
      ? {
          columnId: targetTask.columnId,
          // Returned work is still Jarvis-held until the human accepts it. Keep
          // that ownership marker explicit so compensation and Undo restore the
          // handoff even if a stale client snapshot omitted the tag.
          tags:
            suggestion.kind === 'returned_work'
              ? withTag([...targetTask.tags], JARVIS_HELD_TAG)
              : [...targetTask.tags],
          status: targetTask.status,
          position: targetTask.position,
        }
      : undefined;

    async function rollBackTaskMutation() {
      if (targetTask && targetBefore) {
        await updateTask(targetTask._id, targetBefore);
      } else if (resolvedTaskId) {
        await deleteTask(resolvedTaskId);
      }
    }

    try {
      if (targetTask && suggestion.kind === 'returned_work') {
        resolvedTaskId = targetTask._id;
        await updateTask(targetTask._id, {
          tags: withoutTag(targetTask.tags, JARVIS_HELD_TAG),
        });
        focusTask(targetTask._id, 'returned_work');
      } else if (targetTask && suggestion.kind === 'observed_progress') {
        resolvedTaskId = targetTask._id;
        if (source === 'explicit_accept') {
          await updateTask(targetTask._id, { status: 'done' });
        }
        focusTask(targetTask._id, 'observed_progress');
      } else {
        resolvedTaskId = await createTask({
          columnId: todayColumn._id,
          title: suggestion.title,
          description: suggestion.description,
          priority: suggestion.priority,
          dueDate: suggestion.dueDate,
          tags: [],
        });
        focusTask(resolvedTaskId, source);
      }

      try {
        await resolveSuggestion(suggestion.id, {
          state: 'accepted',
          resolvedTaskId,
          source,
        });
      } catch (resolutionError) {
        try {
          await rollBackTaskMutation();
        } catch {
          throw new Error(
            "Cove couldn't accept that proposal or fully restore the task. Open All Work to check the task before trying again.",
          );
        } finally {
          setFocusedTaskId(commitments[0]?._id ?? null);
          await loadSuggestions();
        }
        throw resolutionError;
      }

      await loadSuggestions();
      showUndo({
        message:
          suggestion.kind === 'returned_work'
            ? 'Review moved to your current'
            : suggestion.kind === 'observed_progress'
              ? source === 'explicit_accept'
                ? 'Marked task done'
                : 'Opened task'
              : 'Added to your current',
        run: async () => {
          await reopenSuggestion(
            suggestion.id,
            suggestion.state === 'refined' ? 'refined' : 'proposed',
          );
          try {
            await rollBackTaskMutation();
          } catch (rollbackError) {
            await loadSuggestions();
            throw rollbackError;
          }
          await loadSuggestions();
          setUndo(null);
        },
      });
    } catch (nextError) {
      setSurfaceError(proposalCommitError(nextError));
    }
  }

  async function refineSuggestion(suggestion: WorkSuggestion) {
    try {
      await resolveSuggestion(suggestion.id, {
        state: 'refined',
        title: suggestionDraft.title,
        description: suggestionDraft.description,
        source: 'human_refinement',
      });
      setEditingSuggestionId(null);
      await loadSuggestions();
    } catch {
      setSurfaceError("Cove couldn't finish saving that wording. Refresh the current to confirm it, then try again.");
    }
  }

  async function deferSuggestion(suggestion: WorkSuggestion) {
    try {
      await resolveSuggestion(suggestion.id, { state: 'deferred', source: 'human' });
      await loadSuggestions();
      showUndo({
        message: 'Set aside for later',
        run: async () => {
          await reopenSuggestion(
            suggestion.id,
            suggestion.state === 'refined' ? 'refined' : 'proposed',
          );
          await loadSuggestions();
          setUndo(null);
        },
      });
    } catch {
      setSurfaceError("Cove couldn't finish setting that aside. Refresh the current to confirm it, then try again.");
    }
  }

  async function dismissSuggestion(suggestion: WorkSuggestion, dismissReason: string) {
    try {
      await resolveSuggestion(suggestion.id, {
        state: 'dismissed',
        dismissReason,
        source: 'human',
      });
      await loadSuggestions();
      showUndo({
        message: 'Suggestion dismissed',
        run: async () => {
          await reopenSuggestion(
            suggestion.id,
            suggestion.state === 'refined' ? 'refined' : 'proposed',
          );
          await loadSuggestions();
          setUndo(null);
        },
      });
    } catch {
      setSurfaceError("Cove couldn't finish dismissing that suggestion. Refresh the current to confirm it, then try again.");
    }
  }

  async function completeTask(task: TaskData) {
    if (!doneColumn || completingTaskId) return;
    setCompletingTaskId(task._id);
    setSurfaceError(undefined);
    await new Promise((resolve) => window.setTimeout(resolve, 230));
    try {
      await updateTask(task._id, {
        columnId: doneColumn._id,
        status: 'done',
        position: tasks.filter((candidate) => candidate.columnId === doneColumn._id).length,
      });
      await recordDecision({
        eventType: 'task_complete',
        entityId: task._id,
        before: { columnId: task.columnId, status: task.status },
        after: { columnId: doneColumn._id, status: 'done' },
        source: 'human',
      });
      const nextTask = commitments.find((candidate) => candidate._id !== task._id);
      setFocusedTaskId(nextTask?._id ?? null);
      if (nextTask) writeLocalValue(FOCUS_KEY, nextTask._id);
      else removeLocalValue(FOCUS_KEY);
      showUndo({
        message: 'Completed',
        run: async () => {
          await updateTask(task._id, {
            columnId: task.columnId,
            status: task.status ?? 'open',
            position: task.position,
          });
          await recordDecision({
            eventType: 'task_undo',
            entityId: task._id,
            reason: 'completion_undo',
            source: 'human',
          });
          focusTask(task._id, 'undo');
          setUndo(null);
        },
      });
    } catch {
      setSurfaceError("Cove couldn't finish completing that task. Refresh the current to confirm its state, then try again.");
    } finally {
      setCompletingTaskId(null);
    }
  }

  async function handToJarvis(task: TaskData) {
    const nextTags = withTag(task.tags, JARVIS_HELD_TAG);
    try {
      await updateTask(task._id, { tags: nextTags });
      await recordDecision({
        eventType: 'task_handoff',
        entityId: task._id,
        before: { holder: 'human' },
        after: { holder: 'jarvis' },
        source: 'human',
      });
      const nextTask = commitments.find((candidate) => candidate._id !== task._id);
      setFocusedTaskId(nextTask?._id ?? null);
      showUndo({
        message: 'Held for Jarvis',
        run: async () => {
          await updateTask(task._id, { tags: task.tags });
          focusTask(task._id, 'pluck_back');
          setUndo(null);
        },
      });
    } catch {
      setSurfaceError("Cove couldn't finish moving that task to the Jarvis shelf. Refresh the current to confirm its state, then try again.");
    }
  }

  async function bringBack(task: TaskData) {
    try {
      await updateTask(task._id, { tags: withoutTag(task.tags, JARVIS_HELD_TAG) });
      await recordDecision({
        eventType: 'task_pluck_back',
        entityId: task._id,
        before: { holder: 'jarvis' },
        after: { holder: 'human' },
        source: 'human',
      });
      focusTask(task._id, 'pluck_back');
    } catch {
      setSurfaceError("Cove couldn't finish bringing that task back. Refresh the current to confirm its state, then try again.");
    }
  }

  function updateWorkingNote(taskId: string, value: string) {
    const nextNotes = { ...notes, [taskId]: value };
    setNotes(nextNotes);
    writeLocalValue(NOTES_KEY, JSON.stringify(nextNotes));
  }

  async function saveDetail(patch: UpdateTaskInput) {
    if (!detailTask) return;
    let nextPatch = patch;
    if (patch.columnId && patch.columnId !== detailTask.columnId && patch.position === undefined) {
      nextPatch = {
        ...patch,
        position: tasks.filter((task) => task.columnId === patch.columnId).length,
        status: patch.columnId === doneColumn?._id ? 'done' : 'open',
      };
    }
    try {
      await updateTask(detailTask._id, nextPatch);
    } catch (error) {
      setSurfaceError("Cove couldn't save those task details. Try again.");
      throw error;
    }
  }

  async function deleteDetail() {
    if (!detailTask) return;
    try {
      await deleteTask(detailTask._id);
    } catch (error) {
      setSurfaceError("Cove couldn't confirm that deletion. Refresh All Work to check the task, then try again.");
      throw error;
    }
  }

  const timeLabel = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(now);
  const planPositionByTaskId = new Map(
    (dayRitual.plan?.items ?? [])
      .filter((item) => item.decision === 'accepted')
      .map((item) => [item.taskId, item.position]),
  );
  const downstream = commitments
    .filter((task) => task._id !== focusedTask?._id)
    .sort((left, right) => {
      const leftPlanPosition = planPositionByTaskId.get(left._id);
      const rightPlanPosition = planPositionByTaskId.get(right._id);
      if (leftPlanPosition !== undefined && rightPlanPosition !== undefined) {
        return leftPlanPosition - rightPlanPosition;
      }
      if (leftPlanPosition !== undefined) return -1;
      if (rightPlanPosition !== undefined) return 1;
      return left.position - right.position;
    });
  const visibleDownstream = showAllDownstream ? downstream : downstream.slice(0, 5);
  const hiddenDownstreamCount = Math.max(0, downstream.length - visibleDownstream.length);
  const focusPoint: CurrentPoint = { x: 500, y: 330 };
  const downstreamStartY = focusPoint.y + (focusExpanded ? 520 : 230);
  const downstreamGap = 150;
  const downstreamLayout = visibleDownstream.map((task, index) => ({
    task,
    x: [548, 438, 536, 456, 556, 448][index % 6],
    y: downstreamStartY + index * downstreamGap,
    side: index % 2 === 0 ? 'right' as const : 'left' as const,
  }));
  const tailY = downstreamStartY + visibleDownstream.length * downstreamGap;
  let tributaryCursor = tailY + (hiddenDownstreamCount > 0 ? 170 : 100);
  const suggestionLayout = activeSuggestions.map((suggestion, index) => {
    const expanded =
      expandedSuggestionId === suggestion.id || editingSuggestionId === suggestion.id;
    const layout = {
      suggestion,
      expanded,
      y: tributaryCursor,
      side: index % 2 === 0 ? 'left' as const : 'right' as const,
    };
    tributaryCursor += expanded ? 430 : 180;
    return layout;
  });
  const stageHeight = Math.max(
    900,
    suggestionLayout.length > 0 ? tributaryCursor + 100 : tailY + 260,
  );
  const pathPoints: CurrentPoint[] = [
    { x: 540, y: 0 },
    { x: 468, y: 128 },
    { x: 522, y: 224 },
    focusPoint,
    ...downstreamLayout.map(({ x, y }) => ({ x, y })),
    { x: 500, y: stageHeight },
  ];
  const tributaries: Tributary[] = suggestionLayout.map(({ suggestion, side, y }) => ({
    id: suggestion.id,
    side,
    y,
  }));
  const progress = getDayProgress(now);
  const dayPoint = cubicPoint(progress);
  const greeting = getGreeting(now.getHours());
  const waterTone = now.getHours() < 11 ? 'morning' : now.getHours() < 17 ? 'day' : 'evening';
  const morningArrivalUnavailableReason = !dayRitual.plan
    ? "Morning Arrival is available when today's plan is ready."
    : dayRitual.plan.localDate !== localDateInTimezone(now, dayRitual.plan.timezone)
      ? 'Morning Arrival is available only for today.'
      : dayRitual.plan.state === 'settled'
        ? 'Morning Arrival is unavailable because today is closed.'
        : dayRitual.busy
          ? 'Cove is updating today\'s plan.'
          : undefined;
  const searchResults = openTasks
    .filter((task) => {
      const query = searchQuery.trim().toLowerCase();
      return !query || `${task.title} ${task.description} ${task.tags.join(' ')}`.toLowerCase().includes(query);
    })
    .slice(0, 8);

  const orderedPlanItems = useMemo(
    () => [...(dayRitual.plan?.items ?? [])].sort((left, right) => left.position - right.position),
    [dayRitual.plan?.items],
  );
  const arrivalPlanItems = useMemo(
    () => orderedPlanItems.filter(
      (item) => item.decision === 'preselected' || item.decision === 'accepted',
    ),
    [orderedPlanItems],
  );
  const arrivalItems = useMemo<MorningArrivalItem[]>(
    () => arrivalPlanItems.map((item) => {
      const sourceTask = tasks.find((task) => task._id === item.taskId);
      const fullDescription = sourceTask?.description || item.outcome;
      return {
        item,
        title: item.title,
        summary: shortArrivalSummary(fullDescription, item.title),
        description: fullDescription,
        // The Morning Brief's rationale wins the card copy when this item was
        // brief-ranked; the deterministic evidence line remains the fallback.
        whyToday: item.brief?.whyToday ?? item.whyToday,
        definitionOfDone: item.definitionOfDone,
        project: helpfulProjectLabel(item.project),
        deadline: item.dueAt
          ? new Date(item.dueAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          : undefined,
      };
    }),
    [arrivalPlanItems, tasks],
  );
  const recommendation = arrivalPlanItems[0]
    ? `Start with ${arrivalPlanItems[0].title}. ${arrivalPlanItems[0].whyToday}`
    : 'Cove does not have enough current evidence to choose your first move yet.';
  const boardExecutionByTaskId = useMemo(() => {
    const map = new Map<string, {
      item: DayPlanItem;
      run?: DayPlanExecutionRun;
      presentation: ReturnType<typeof selectBoardExecutionPresentation>;
      needsSetup: boolean;
    }>();
    const activePlan = dayRitual.plan;
    const executionState = dayRitual.executionState;
    if (!activePlan) return map;
    for (const item of activePlan.items) {
      const config = executionState?.items.find((entry) => entry.itemId === item.id)?.config;
      const { latestRun, currentRun } = selectCurrentExecutionRow(
        executionState?.runs ?? [],
        item.id,
        config,
      );
      const run = currentRun ?? latestRun;
      const task = tasks.find((candidate) => candidate._id === item.taskId);
      const taskDone = task?.status === 'done' || task?.columnId === doneColumn?._id;
      map.set(item.taskId, {
        item,
        run,
        presentation: selectBoardExecutionPresentation({
          owner: item.owner,
          run,
          taskDone,
        }),
        needsSetup: shouldShowNeedsSetupToStart({
          planState: activePlan.state,
          owner: item.owner,
          hasRun: Boolean(run),
          taskDone,
          startDayApplying: dayRitual.startDayApplying,
        }),
      });
    }
    return map;
  }, [
    dayRitual.plan,
    dayRitual.executionState,
    dayRitual.startDayApplying,
    doneColumn?._id,
    tasks,
  ]);
  const focusedBoardExecution = focusedTask
    ? boardExecutionByTaskId.get(focusedTask._id)
    : undefined;
  const kickoffBoardExecution = (
    execution: NonNullable<typeof focusedBoardExecution>,
  ) => {
    const configured = dayRitual.executionState?.items.find(
      (entry) => entry.itemId === execution.item.id,
    )?.config;
    const isRepeat = execution.presentation.action === 'retry' ||
      execution.presentation.action === 'restart';
    const mode = isRepeat
      ? configured?.mode ?? execution.run?.mode ?? 'plan_review'
      : 'plan_review';
    void dayRitual.kickoffExecution(
      execution.item.id,
      mode,
      defaultPlanningModel(execution.item),
      mode === 'autonomous'
        ? configured?.workspaceId ?? execution.run?.workspaceId
        : undefined,
      mode === 'autonomous'
        ? configured?.budgetUsd ?? execution.run?.budgetUsd
        : undefined,
    );
  };
  const openExecutionSetup = (taskId: string) => {
    focusTask(taskId, 'execution_setup');
    window.requestAnimationFrame(() => setFocusExpanded(true));
  };
  const planEvidenceRefreshedAt = dayRitual.plan?.items
    .flatMap((item) => item.sourceRefs.map((source) => source.refreshedAt))
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite)
    .reduce<number | undefined>(
      (latest, value) => latest === undefined ? value : Math.max(latest, value),
      undefined,
    );
  const morningRecap = useMemo(() => {
    const snapshot = dayRitual.latestSnapshot;
    if (!snapshot) return undefined;
    const completed = snapshot.body.completedHumanTaskIds.length;
    const progressed = snapshot.body.unresolvedItems.filter(
      (item) => item.disposition === 'progress',
    ).length;
    const carried = snapshot.body.unresolvedItems.filter(
      (item) => item.disposition === 'carry',
    ).length;
    const parts = [
      completed > 0 ? `${completed} essential ${completed === 1 ? 'outcome was' : 'outcomes were'} completed` : undefined,
      progressed > 0 ? `${progressed} ${progressed === 1 ? 'commitment moved' : 'commitments moved'} forward` : undefined,
      carried > 0 ? `${carried} ${carried === 1 ? 'commitment carries' : 'commitments carry'} forward` : undefined,
    ].filter(Boolean);
    return parts.length > 0 ? `${parts.join('. ')}.` : undefined;
  }, [dayRitual.latestSnapshot]);
  const completedForSettlement = orderedPlanItems
    .filter((item) => item.decision === 'completed')
    .map((item) => {
      const task = tasks.find((candidate) => candidate._id === item.taskId);
      return {
        id: item.taskId,
        title: item.title,
        detail: task && task.updatedAt > 0 &&
          (task.status === 'done' || task.columnId === doneColumn?._id)
          ? `Completed ${new Date(task.updatedAt).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              timeZone: dayRitual.plan?.timezone,
            })}`
          : 'Marked complete',
      };
    });
  const unresolvedForSettlement = orderedPlanItems
    .filter((item) => item.decision === 'accepted')
    .map((item) => ({ item, title: item.title, outcome: item.outcome }));
  const settlementDecisions = Object.fromEntries(
    orderedPlanItems.map((item) => [item.id, item.settlementDecision?.disposition]),
  );
  const proposedTomorrow = firstContinuingItem(orderedPlanItems, settlementDecisions);
  const visibleSurfaceError = combineSurfaceErrors(
    dayRitual.ritualOpen ? undefined : dayRitual.error,
    dayRitual.ritualOpen ? undefined : dayRitual.executionError,
    surfaceError,
  );

  if (loading || dayRitual.view === 'checking') {
    return (
      <div className="quiet-current-surface current-river-surface is-day h-full overflow-hidden" aria-busy="true">
        <div className="current-water-plane" aria-hidden="true">
          <span className="current-water-drift current-water-drift-one" />
          <span className="current-water-drift current-water-drift-two" />
        </div>
        <div className="current-river-shell">
          <header className="current-arrival" aria-label="Preparing Today">
            <div className="current-arrival-copy">
              <p className="current-today-label">Today</p>
              <time className="current-time" dateTime={now.toISOString()} suppressHydrationWarning>
                {timeLabel}
              </time>
              <p className="current-greeting">Gathering your current.</p>
            </div>
            <div className="current-day-arc" aria-hidden="true">
              <svg viewBox="0 0 324 132">
                <path d="M 18 112 C 116 116, 244 76, 306 18" />
                <circle cx="162" cy="88" r="6" />
                <g className="current-sun" transform="translate(306 18)">
                  <circle r="9" />
                </g>
              </svg>
            </div>
          </header>
          <section className="current-river-stage" style={{ height: 900 }} aria-label="Preparing your current">
            <CurrentCanvas
              height={900}
              points={[
                { x: 540, y: 0 },
                { x: 468, y: 128 },
                { x: 522, y: 224 },
                { x: 500, y: 330 },
                { x: 500, y: 900 },
              ]}
              tributaries={[]}
              focusPoint={{ x: 500, y: 330 }}
              completing={false}
              ambientPaused={ambientPaused}
            />
            <div className="current-empty-now" style={{ top: 330 }} role="status">
              <p>Preparing what matters now.</p>
            </div>
          </section>
        </div>
      </div>
    );
  }

  if (!todayColumn || !doneColumn) {
    return (
      <div className="quiet-current-surface flex h-full items-center justify-center p-6">
        <div className="quiet-error-card max-w-lg">
          <p className="text-sm font-semibold">Cove couldn&apos;t load Today.</p>
          <p className="mt-2 text-sm text-muted-foreground">
            {error || 'The Today or Done list is missing. Open All Work to restore it, then try again.'}
          </p>
          <button type="button" className="quiet-error-action" onClick={() => void retry()}>Try again</button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full overflow-hidden">
      <div
        ref={livingCurrentRef}
        className={`quiet-current-surface current-river-surface is-${waterTone} ${ambientPaused || dayRitual.ritualOpen ? 'is-ambient-paused' : ''} h-full overflow-y-auto`}
      >
      <div className="current-water-plane" aria-hidden="true">
        <span className="current-water-drift current-water-drift-one" />
        <span className="current-water-drift current-water-drift-two" />
      </div>

      <div className="current-river-shell">
        <header className="current-arrival" aria-label={`Today at ${timeLabel}`}>
          <div className="current-arrival-copy">
            <p className="current-today-label">Today</p>
            <time className="current-time" dateTime={now.toISOString()}>{timeLabel}</time>
            <p className="current-greeting">{greeting}</p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="current-capture-toggle"
                disabled={Boolean(morningArrivalUnavailableReason)}
                title={morningArrivalUnavailableReason}
                aria-describedby="morning-arrival-availability"
                onClick={() => void openMorningArrival()}
              >
                Morning Arrival
              </button>
              <span id="morning-arrival-availability" className="sr-only">
                {morningArrivalUnavailableReason ?? 'Open or revisit Morning Arrival.'}
              </span>
              <button
                type="button"
                className="current-capture-toggle"
                disabled={!dayRitual.plan || dayRitual.busy || dayRitual.plan.state === 'settled'}
                onClick={() => void openDaySettlement()}
              >
                Close My Day
              </button>
            </div>
            {captureOpen && (
              <form onSubmit={handleCapture} className="current-capture-form">
                <label htmlFor="quiet-capture" className="sr-only">Add missing work or context</label>
                <input
                  id="quiet-capture"
                  autoFocus
                  value={capture}
                  onChange={(event) => setCapture(event.target.value)}
                  placeholder="Add the work Jarvis could not know."
                />
                <button type="submit" disabled={!capture.trim() || capturing}>Add</button>
              </form>
            )}
            {visibleSurfaceError && (
              <p role="alert" className="current-surface-error">{visibleSurfaceError}</p>
            )}
            {(dayRitual.startReceipt || dayRitual.settlementReceipt) && (
              <p role="status" className="current-start-receipt">
                {dayRitual.startReceipt ?? dayRitual.settlementReceipt}
              </p>
            )}
            {dayRitual.plan?.state === 'active' &&
              dayRitual.executionState?.workerAvailable === false && (
              <p role="status" className="current-worker-warning">
                Claude&apos;s background runner looks offline — runs will wait until it&apos;s back.
              </p>
            )}
            {error && (
              <div role="alert" className="current-refresh-warning">
                <span>{error}</span>
                <button type="button" onClick={() => void retry()}>Try again</button>
              </div>
            )}
          </div>

          <div className="current-day-arc" aria-hidden="true">
            <svg viewBox="0 0 324 132">
              <path d="M 18 112 C 116 116, 244 76, 306 18" />
              <circle cx={dayPoint.x} cy={dayPoint.y} r="6" />
              <g className="current-sun" transform="translate(306 18)">
                <circle r="9" />
                {[0, 45, 90, 135].map((angle) => (
                  <path key={angle} d="M 0 -17 L 0 -24" transform={`rotate(${angle})`} />
                ))}
              </g>
            </svg>
          </div>
        </header>

        <section
          className="current-river-stage"
          style={{ height: stageHeight }}
          aria-label="Your current"
        >
          <CurrentCanvas
            height={stageHeight}
            points={pathPoints}
            tributaries={tributaries}
            focusPoint={focusPoint}
            completing={Boolean(completingTaskId)}
            ambientPaused={ambientPaused || dayRitual.ritualOpen}
          />

          {doneToday.length > 0 && (
            <div className="current-wake-cluster">
              <button type="button" onClick={() => setWakeOpen((current) => !current)} aria-expanded={wakeOpen}>
                <span className="current-wake-dots" aria-hidden="true">
                  {doneToday.slice(0, 3).map((task) => <i key={task._id} />)}
                </span>
                <span>{doneToday.length} done today</span>
              </button>
              {wakeOpen && (
                <div className="current-wake-list">
                  {doneToday.slice(0, 5).map((task) => <p key={task._id}>{task.title}</p>)}
                  {doneToday.length > 5 && <span>And {doneToday.length - 5} more in the wake</span>}
                </div>
              )}
            </div>
          )}

          {focusedTask ? (
            <article
              className={`current-now-shell ${focusExpanded ? 'is-expanded' : ''} ${completingTaskId === focusedTask._id ? 'is-completing' : ''}`}
              style={{ top: focusPoint.y }}
              aria-labelledby="quiet-now-title"
            >
              <div className="current-now-pill">
                <button
                  type="button"
                  className="current-now-main"
                  aria-expanded={focusExpanded}
                  onClick={() => setFocusExpanded((current) => !current)}
                >
                  <span className="current-now-kicker">
                    {focusedIsWithJarvis ? 'Held for Jarvis' : focusedIsBrief ? 'Email brief' : 'Now'}
                    {focusedTask.blocked ? ' · Waiting' : ''}
                    {focusedIsOutsideToday && !focusedIsWithJarvis && !focusedIsBrief ? ' · Outside today' : ''}
                    {focusedBoardExecution?.run && focusedBoardExecution.presentation.statusLabel && (
                      <RunStatusChip
                        status={focusedBoardExecution.run.status}
                        label={focusedBoardExecution.presentation.statusLabel}
                        className="ml-2 align-middle"
                      />
                    )}
                  </span>
                  <h2 ref={focusHeadingRef} id="quiet-now-title" tabIndex={-1}>{focusedTask.title}</h2>
                  <span className="current-now-reveal" aria-hidden="true">{focusExpanded ? '−' : '＋'}</span>
                </button>
                <button
                  type="button"
                  className="current-complete-orb"
                  disabled={Boolean(completingTaskId)}
                  aria-label={focusedIsWithJarvis ? `Bring back ${focusedTask.title}` : `Complete ${focusedTask.title}`}
                  onClick={() => focusedIsWithJarvis ? void bringBack(focusedTask) : void completeTask(focusedTask)}
                >
                  {focusedIsWithJarvis ? (
                    <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m15 6-6 6 6 6" /></svg>
                  ) : (
                    <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6" /></svg>
                  )}
                </button>
              </div>

              {focusedBoardExecution &&
                (focusedBoardExecution.item.owner === 'claude' ||
                  focusedBoardExecution.item.owner === 'together') && (
                <div className="current-hero-execution" aria-label={`Claude planning for ${focusedTask.title}`}>
                  {focusedBoardExecution.needsSetup ? (
                    <button
                      type="button"
                      className="press-scale min-h-9 rounded-full border border-border/70 bg-white/55 px-4 text-xs font-semibold text-muted-foreground"
                      onClick={() => setFocusExpanded(true)}
                    >
                      Needs setup to start
                    </button>
                  ) : focusedBoardExecution.presentation.action === 'open' &&
                    focusedBoardExecution.presentation.reviewable &&
                    focusedBoardExecution.run?.claudeSessionId ? (
                    <OpenInClaudeCode
                      sessionId={focusedBoardExecution.run.claudeSessionId}
                      mode={focusedBoardExecution.run.mode}
                      title={focusedTask.title}
                      label="Review plan"
                      resumeCommand={focusedBoardExecution.run.resumeCommand}
                    />
                  ) : focusedBoardExecution.presentation.reviewable &&
                    focusedBoardExecution.presentation.action === 'restart' ? (
                    <div className="flex max-w-sm flex-col items-center gap-2 text-center">
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        Claude&apos;s session reference is missing — restart planning to reopen it.
                      </p>
                      <button
                        type="button"
                        disabled={dayRitual.executionBusyItemIds.has(focusedBoardExecution.item.id)}
                        className="press-scale min-h-9 rounded-full border border-accent-blue/40 bg-white/55 px-4 text-xs font-semibold text-foreground disabled:opacity-40"
                        onClick={() => kickoffBoardExecution(focusedBoardExecution)}
                      >
                        {dayRitual.executionBusyItemIds.has(focusedBoardExecution.item.id)
                          ? 'Preparing…'
                          : 'Restart'}
                      </button>
                    </div>
                  ) : focusedBoardExecution.run &&
                    ['queued', 'starting', 'running', 'cancelling']
                      .includes(focusedBoardExecution.run.status) ? (
                    <button
                      type="button"
                      disabled
                      className={`min-h-9 rounded-full border px-4 text-xs font-semibold opacity-60 ${
                        focusedBoardExecution.run.status === 'running'
                          ? 'border-accent-blue/40 bg-white/55 text-foreground'
                          : 'border-border/70 bg-muted/60 text-muted-foreground'
                      }`}
                    >
                      {focusedBoardExecution.run.status === 'running'
                        ? 'Working…'
                        : focusedBoardExecution.run.status === 'cancelling'
                          ? 'Stopping…'
                          : 'Waiting to start'}
                    </button>
                  ) : focusedBoardExecution.presentation.showKickoff ? (
                    <button
                      type="button"
                      disabled={dayRitual.executionBusyItemIds.has(focusedBoardExecution.item.id)}
                      className="press-scale min-h-9 rounded-full border border-accent-blue/40 bg-white/55 px-4 text-xs font-semibold text-foreground disabled:opacity-40"
                      onClick={() => kickoffBoardExecution(focusedBoardExecution)}
                    >
                      {dayRitual.executionBusyItemIds.has(focusedBoardExecution.item.id)
                        ? 'Preparing…'
                        : focusedBoardExecution.presentation.action === 'retry'
                          ? 'Retry'
                          : focusedBoardExecution.presentation.action === 'restart'
                            ? 'Restart'
                            : 'Ask Claude to plan'}
                    </button>
                  ) : null}
                </div>
              )}

              {focusExpanded && (
                <div className="current-focus-details">
                  <h3 className="current-focus-full-title">{focusedTask.title}</h3>
                  {focusedTask.description && <p className="current-focus-description">{focusedTask.description}</p>}
                  <div className="current-focus-materials">
                    <div>
                      <label htmlFor={`working-note-${focusedTask._id}`}>Working note</label>
                      <textarea
                        id={`working-note-${focusedTask._id}`}
                        value={notes[focusedTask._id] ?? ''}
                        onChange={(event) => updateWorkingNote(focusedTask._id, event.target.value)}
                        readOnly={focusedIsWithJarvis}
                        placeholder={focusedIsWithJarvis ? 'Bring this work back before adding a note.' : 'Keep the thought you are carrying.'}
                        rows={3}
                      />
                    </div>
                    <dl>
                      <div><dt>Priority</dt><dd className="capitalize">{focusedTask.priority}</dd></div>
                      <div><dt>Due</dt><dd>{focusedTask.dueDate ? new Date(`${focusedTask.dueDate}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'Open'}</dd></div>
                      <div><dt>State</dt><dd>{focusedIsWithJarvis ? 'Held for Jarvis' : 'Committed'}</dd></div>
                    </dl>
                  </div>
                  <div className="current-focus-actions">
                    <button type="button" onClick={() => setDetailTaskId(focusedTask._id)}>Edit details</button>
                    {!focusedIsWithJarvis && <button type="button" onClick={() => void handToJarvis(focusedTask)}>Hold for Jarvis</button>}
                    <button type="button" onClick={openSearch}>Find other work <kbd>⌘K</kbd></button>
                  </div>
                  {focusedBoardExecution &&
                    (focusedBoardExecution.item.owner === 'claude' ||
                      focusedBoardExecution.item.owner === 'together') && (
                    <ExecutionConfigPanel
                      item={focusedBoardExecution.item}
                      ariaTitle={focusedTask.title}
                      complexityText={`${focusedBoardExecution.item.title} ${focusedBoardExecution.item.outcome} ${focusedBoardExecution.item.definitionOfDone ?? ''}`}
                      executionItem={dayRitual.executionState?.items.find(
                        (entry) => entry.itemId === focusedBoardExecution.item.id,
                      )}
                      runs={dayRitual.executionState?.runs ?? []}
                      workspaces={dayRitual.executionState?.workspaces ?? []}
                      busy={dayRitual.busy}
                      executionBusy={dayRitual.executionBusyItemIds.has(focusedBoardExecution.item.id)}
                      executionLoading={dayRitual.executionLoading}
                      error={dayRitual.executionError}
                      planActionHandledExternally
                      onKickoffExecution={dayRitual.kickoffExecution}
                      onCancelExecution={dayRitual.cancelExecution}
                    />
                  )}
                </div>
              )}
            </article>
          ) : (
            <div className="current-empty-now" style={{ top: focusPoint.y }}>
              <p>The current is clear.</p>
              <button type="button" onClick={openSearch}>Choose what comes next</button>
            </div>
          )}

          {downstreamLayout.map(({ task, x, y, side }, index) => {
            const time = realTimeLabel(task.dueAt);
            const execution = boardExecutionByTaskId.get(task._id);
            return (
              <article
                key={task._id}
                className={`current-river-node is-${side} ${time ? 'is-anchored' : ''}`}
                style={{ left: `${x / 10}%`, top: y }}
              >
                <button
                  type="button"
                  className="current-node-target"
                  onClick={() => focusTask(task._id, 'pointer')}
                  aria-label={`Downstream ${index + 1} of ${downstream.length}: ${task.title}${time ? ` at ${time}` : ''}`}
                >
                  <span className="current-node-dot" aria-hidden="true" />
                </button>
                <div className="current-node-copy">
                  {time && <time>{time}</time>}
                  <button type="button" className="current-node-title" onClick={() => focusTask(task._id, 'pointer')}>
                    <strong>{task.title}</strong>
                  </button>
                  {execution && (execution.needsSetup || (
                    execution.run && execution.presentation.statusLabel
                  )) && (
                    <div className="current-node-execution">
                      {execution.needsSetup ? (
                        <button
                          type="button"
                          className="current-execution-chip border border-border/70 bg-muted/60 text-muted-foreground"
                          onClick={() => openExecutionSetup(task._id)}
                        >
                          Needs setup to start
                        </button>
                      ) : execution.run && execution.presentation.reviewable && execution.run.claudeSessionId ? (
                        <OpenInClaudeCode
                          sessionId={execution.run.claudeSessionId}
                          mode={execution.run.mode}
                          title={task.title}
                          label={execution.presentation.statusLabel}
                          resumeCommand={execution.run.resumeCommand}
                          className="current-execution-chip"
                        />
                      ) : execution.run && execution.presentation.showKickoff ? (
                        <button
                          type="button"
                          className="current-execution-chip border border-border/70 bg-muted/60 text-muted-foreground"
                          onClick={() => openExecutionSetup(task._id)}
                        >
                          {execution.presentation.statusLabel}
                        </button>
                      ) : execution.run ? (
                        <RunStatusChip
                          status={execution.run.status}
                          label={execution.presentation.statusLabel}
                          className="current-execution-chip"
                        />
                      ) : null}
                    </div>
                  )}
                </div>
              </article>
            );
          })}

          {hiddenDownstreamCount > 0 && (
            <button
              type="button"
              className="current-river-tail"
              style={{ top: tailY - 30 }}
              onClick={() => setShowAllDownstream(true)}
            >
              <span aria-hidden="true">⌄</span>
              {hiddenDownstreamCount} more downstream
            </button>
          )}
          {showAllDownstream && downstream.length > 5 && (
            <button type="button" className="current-river-tail" style={{ top: tailY - 30 }} onClick={() => setShowAllDownstream(false)}>
              Show less
            </button>
          )}

          <aside className="current-jarvis-current" aria-labelledby="jarvis-lane-title">
            <div className="current-jarvis-heading">
              <span>Second current</span>
              <h2 id="jarvis-lane-title">Jarvis shelf</h2>
              <i aria-hidden="true" />
            </div>
            <div className="current-jarvis-nodes">
              {jarvisTasks.length > 0 ? jarvisTasks.slice(0, 3).map((task) => (
                <article key={task._id} className={focusedTaskId === task._id ? 'is-focused' : ''}>
                  <button type="button" onClick={() => {
                    if (boardExecutionByTaskId.get(task._id)?.needsSetup) {
                      openExecutionSetup(task._id);
                    } else if (isEmailDigest(task)) {
                      setDetailTaskId(task._id);
                    } else {
                      focusTask(task._id, 'jarvis_current');
                    }
                  }}>
                    <span>{isEmailDigest(task) ? 'Email brief ready' : 'Held for Jarvis'}</span>
                    <strong>{task.title}</strong>
                    {boardExecutionByTaskId.get(task._id)?.run && (
                      <RunStatusChip
                        status={boardExecutionByTaskId.get(task._id)!.run!.status}
                        label={boardExecutionByTaskId.get(task._id)!.presentation.statusLabel}
                        className="mt-1 self-start"
                      />
                    )}
                    {boardExecutionByTaskId.get(task._id)?.needsSetup && (
                      <span className="mt-1 w-fit rounded-full border border-border/70 bg-muted/60 px-2 py-1 text-[0.6875rem] font-medium normal-case tracking-normal">
                        Needs setup to start
                      </span>
                    )}
                  </button>
                </article>
              )) : <p className="current-jarvis-empty">The second current is quiet.</p>}
              {jarvisTasks.length > 3 && (
                <button type="button" className="current-jarvis-more" onClick={openSearch}>
                  +{jarvisTasks.length - 3} more on the shelf
                </button>
              )}
            </div>
          </aside>

          {!suggestionsLoading && suggestionLayout.map(({ suggestion, expanded, side, y }) => (
            <article
              key={suggestion.id}
              className={`current-tributary is-${side} ${expanded ? 'is-expanded' : ''}`}
              style={{ top: y }}
            >
              <button
                type="button"
                className="current-tributary-summary"
                aria-expanded={expanded}
                onClick={() => setExpandedSuggestionId((current) => current === suggestion.id ? null : suggestion.id)}
              >
                <span className="current-pencil-mark">Pencil</span>
                <strong>{suggestion.title}</strong>
                <span>
                  {suggestion.resurfacedFromDeferredAt ? 'You set this aside. ' : ''}
                  {suggestion.reason}
                </span>
              </button>

              {expanded && (
                <div className="current-tributary-details">
                  {editingSuggestionId === suggestion.id ? (
                    <div className="space-y-3">
                      <label className="quiet-material-label" htmlFor={`suggestion-title-${suggestion.id}`}>Refine the proposal</label>
                      <input id={`suggestion-title-${suggestion.id}`} value={suggestionDraft.title} onChange={(event) => setSuggestionDraft((current) => ({ ...current, title: event.target.value }))} className="quiet-pencil-input" />
                      <textarea aria-label="Suggestion description" value={suggestionDraft.description} onChange={(event) => setSuggestionDraft((current) => ({ ...current, description: event.target.value }))} rows={3} className="quiet-pencil-input resize-none" />
                      <div className="flex gap-2">
                        <button type="button" onClick={() => void refineSuggestion(suggestion)} className="quiet-pencil-action is-primary">Save wording</button>
                        <button type="button" onClick={() => setEditingSuggestionId(null)} className="quiet-pencil-action">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {suggestion.description && <p>{suggestion.description}</p>}
                      {suggestion.kind === 'returned_work' && suggestion.reviewMaterial && <details className="quiet-returned-work"><summary>Read Jarvis&apos;s work</summary><pre>{suggestion.reviewMaterial}</pre></details>}
                      <small>Source: {suggestion.source}</small>
                      <div className="current-tributary-actions">
                        <button type="button" onClick={() => void commitSuggestion(suggestion, 'explicit_accept')} className="quiet-pencil-action is-primary">{suggestion.kind === 'observed_progress' ? 'Mark done' : 'Accept'}</button>
                        <button type="button" onClick={() => void commitSuggestion(suggestion, 'began_work')} className="quiet-pencil-action">{suggestion.kind === 'observed_progress' ? 'Open task' : 'Begin'}</button>
                        <button type="button" onClick={() => { setEditingSuggestionId(suggestion.id); setSuggestionDraft({ title: suggestion.title, description: suggestion.description }); }} className="quiet-pencil-action">Edit</button>
                        {!suggestion.resurfacedFromDeferredAt && (
                          <button type="button" onClick={() => void deferSuggestion(suggestion)} className="quiet-pencil-action">Later</button>
                        )}
                        <div className="quiet-dismiss-menu relative" data-dismiss-menu={suggestion.id}>
                          <button type="button" aria-haspopup="menu" aria-expanded={dismissMenuId === suggestion.id} onClick={() => setDismissMenuId((current) => current === suggestion.id ? null : suggestion.id)} className="quiet-pencil-action">Dismiss</button>
                          {dismissMenuId === suggestion.id && <div className="quiet-dismiss-popover" role="menu">
                            {[[ 'not_mine', 'Not mine' ], [ 'already_done', 'Already done' ], [ 'not_real_work', 'Not real work' ], [ 'wrong_time', 'Wrong time' ]].map(([reason, label]) => (
                              <button key={reason} role="menuitem" type="button" onClick={() => { setDismissMenuId(null); void dismissSuggestion(suggestion, reason); }}>{label}</button>
                            ))}
                          </div>}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </article>
          ))}

          <p className="current-switch-hint" style={{ top: stageHeight - 72 }}>
            Switch focus by choosing what&apos;s next.
          </p>
        </section>
      </div>

      {undo && (
        <div
          className="quiet-undo"
          role="status"
          onMouseEnter={() => setUndoPaused(true)}
          onMouseLeave={() => setUndoPaused(false)}
          onFocusCapture={() => setUndoPaused(true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setUndoPaused(false);
            }
          }}
        >
          <span>{undo.message}</span>
          <button type="button" onClick={() => void runUndo()}>Undo</button>
          {!undoPaused && <span className="quiet-undo-timer" aria-hidden="true" />}
        </div>
      )}

      {searchOpen && (
        <div className="quiet-search-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeSearch()}>
          <div ref={searchDialogRef} className="quiet-search-dialog" role="dialog" aria-modal="true" aria-label="Find work">
            <div className="flex items-center gap-3 border-b px-4">
              <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-muted-foreground">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                autoFocus
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Focus any task without changing its state"
                className="h-14 min-w-0 flex-1 border-0 bg-transparent text-sm outline-none"
              />
              <kbd className="quiet-key">Esc</kbd>
            </div>
            <div className="max-h-[360px] overflow-y-auto p-2">
              {searchResults.map((task) => {
                const inCurrent = commitments.some((candidate) => candidate._id === task._id);
                const withJarvis = hasTag(task, JARVIS_HELD_TAG);
                const brief = isEmailDigest(task);
                return (
                  <button
                    key={task._id}
                    type="button"
                    onClick={() => {
                      focusTask(task._id, 'search');
                      closeSearch(false);
                    }}
                    className="quiet-search-result"
                  >
                    <span className="min-w-0 flex-1 truncate text-left">{task.title}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {withJarvis ? 'Held for Jarvis' : brief ? 'Email brief' : inCurrent ? 'In current' : 'Outside today'}
                    </span>
                  </button>
                );
              })}
              {searchResults.length === 0 && <p className="px-3 py-8 text-center text-sm text-muted-foreground">No matching work.</p>}
            </div>
          </div>
        </div>
      )}

      {detailTask && (
        <TaskDetail
          taskId={detailTask._id}
          task={detailTask}
          columns={columns}
          onClose={() => setDetailTaskId(null)}
          onDeleted={() => setDetailTaskId(null)}
          onSaveTask={saveDetail}
          onDeleteTask={deleteDetail}
        />
      )}
      </div>

      {ritualView && dayRitual.plan && (
        <DayRitualLayer
          labelledBy={RITUAL_TITLE_IDS[ritualView]}
          describedBy={RITUAL_DESCRIPTION_IDS[ritualView]}
          announcement={dayRitual.announcement}
          inertTargetRef={livingCurrentRef}
          width={ritualView === 'settlement' ? 'default' : 'wide'}
          onEscape={
            ritualView === 'arrival'
              ? () => arrivalEscapeRef.current?.()
              : ritualView === 'settlement'
                ? dayRitual.cancelSettlement
                : () => undefined
          }
        >
          <DayRitualContentSwap
            viewKey={ritualView}
            focusTargetId={RITUAL_TITLE_IDS[ritualView]}
          >
            {ritualView === 'arrival' ? (
              <MorningArrival
                plan={dayRitual.plan}
                items={arrivalItems}
                recommendation={recommendation}
                brief={dayRitual.morningBrief}
                briefGeneration={dayRitual.briefGeneration}
                onForceBrief={() => void dayRitual.forceBrief()}
                forcingBrief={dayRitual.forcingBrief}
                recap={morningRecap}
                freshnessLabel={planEvidenceRefreshedAt
                  ? `Evidence refreshed ${new Date(planEvidenceRefreshedAt).toLocaleTimeString([], {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}`
                  : 'Using the latest verified task evidence'}
                expandedItemId={expandedArrivalItemId}
                busy={dayRitual.busy}
                error={dayRitual.error}
                titleId={RITUAL_TITLE_IDS.arrival}
                descriptionId={RITUAL_DESCRIPTION_IDS.arrival}
                escapeRef={arrivalEscapeRef}
                onInteract={dayRitual.markArrivalInteraction}
                onExpand={(itemId) => {
                  dayRitual.markArrivalInteraction();
                  setExpandedArrivalItemId((current) => current === itemId ? null : itemId);
                }}
                onOwnerChange={(itemId, owner) => dayRitual.setOwner(itemId, owner)}
                onDragReorder={async (activeId, overId) => {
                  const next = reorderDayPlanItems(arrivalPlanItems, activeId, overId);
                  const position = next.findIndex((item) => item.id === activeId);
                  const title = next[position]?.title ?? 'Task';
                  if (position >= 0) await dayRitual.reorder(activeId, position, title);
                }}
                onDismiss={dayRitual.dismissItem}
                onSalesAction={dayRitual.markBriefSalesAction}
                onAddSuggestion={dayRitual.addItem}
                onSnooze={() => dayRitual.snooze().catch(() => undefined)}
                onSkip={() => dayRitual.skip().catch(() => undefined)}
                onBypass={() => dayRitual.bypass().catch(() => undefined)}
                onStartDay={startPlannedDay}
                onAddWhatChanged={() => {
                  void dayRitual.bypass().then(() => setCaptureOpen(true)).catch(() => undefined);
                }}
                onOpenAllWork={onOpenAllWork ? () => {
                  void dayRitual.bypass().then(onOpenAllWork).catch(() => undefined);
                } : undefined}
              />
            ) : ritualView === 'settlement' ? (
              <DaySettlement
                plan={dayRitual.plan}
                completed={completedForSettlement}
                unresolved={unresolvedForSettlement}
                decisions={settlementDecisions}
                proposedTomorrowTitle={proposedTomorrow?.title}
                savingItemIds={dayRitual.savingItemIds}
                closing={dayRitual.busy}
                error={dayRitual.error}
                note={settlementNote}
                canDefer={Boolean(notStartedColumn)}
                titleId={RITUAL_TITLE_IDS.settlement}
                descriptionId={RITUAL_DESCRIPTION_IDS.settlement}
                onDecision={(itemId, disposition, progress) => {
                  if (disposition === 'defer' && !notStartedColumn) {
                    setSurfaceError('Cove needs a Not Started or To Do list before it can defer work.');
                    return;
                  }
                  return dayRitual.decideSettlement(itemId, disposition, progress);
                }}
                onCancel={dayRitual.cancelSettlement}
                onNoteChange={setSettlementNote}
                onCloseDay={closeSettledDay}
              />
            ) : (
              null
            )}
          </DayRitualContentSwap>
        </DayRitualLayer>
      )}
    </div>
  );
}
