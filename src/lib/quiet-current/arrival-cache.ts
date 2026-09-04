export type ArrivalTaskStatus = 'open' | 'done' | 'archived';

export type ArrivalColumn = {
  _id: string;
  name: string;
  position: number;
  createdAt: number;
};

export type ArrivalTask = {
  _id: string;
  columnId: string;
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high';
  dueDate?: string;
  dueAt?: string;
  tags: string[];
  project?: string;
  origin?: string;
  status?: ArrivalTaskStatus;
  proposedRecurrenceCadence?: string;
  recurringTemplateId?: string;
  occurrenceLocalDate?: string;
  blocked: boolean;
  position: number;
  createdAt: number;
  updatedAt: number;
};

export type ArrivalSnapshot = {
  version: 1;
  savedAt: string;
  columns: ArrivalColumn[];
  tasks: ArrivalTask[];
};

type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'setItem'>;

export const ARRIVAL_CACHE_KEY = 'cove.quiet-current.arrival.v1';
export const ARRIVAL_CACHE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isArrivalColumn(value: unknown): value is ArrivalColumn {
  return (
    isRecord(value) &&
    typeof value._id === 'string' &&
    typeof value.name === 'string' &&
    isFiniteNumber(value.position) &&
    isFiniteNumber(value.createdAt)
  );
}

function isArrivalTask(value: unknown): value is ArrivalTask {
  if (!isRecord(value)) return false;
  const priority = value.priority;
  const status = value.status;
  return (
    typeof value._id === 'string' &&
    typeof value.columnId === 'string' &&
    typeof value.title === 'string' &&
    typeof value.description === 'string' &&
    (priority === 'low' || priority === 'medium' || priority === 'high') &&
    (value.dueDate === undefined || typeof value.dueDate === 'string') &&
    (value.dueAt === undefined || typeof value.dueAt === 'string') &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === 'string') &&
    (value.project === undefined || typeof value.project === 'string') &&
    (status === undefined || status === 'open' || status === 'done' || status === 'archived') &&
    (value.proposedRecurrenceCadence === undefined ||
      typeof value.proposedRecurrenceCadence === 'string') &&
    (value.recurringTemplateId === undefined ||
      typeof value.recurringTemplateId === 'string') &&
    (value.occurrenceLocalDate === undefined ||
      typeof value.occurrenceLocalDate === 'string') &&
    typeof value.blocked === 'boolean' &&
    isFiniteNumber(value.position) &&
    isFiniteNumber(value.createdAt) &&
    isFiniteNumber(value.updatedAt)
  );
}

export function parseArrivalSnapshot(
  raw: string | null,
  now = new Date(),
): ArrivalSnapshot | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const savedAt = isRecord(parsed) && typeof parsed.savedAt === 'string'
      ? new Date(parsed.savedAt).getTime()
      : Number.NaN;
    const age = now.getTime() - savedAt;
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      typeof parsed.savedAt !== 'string' ||
      Number.isNaN(savedAt) ||
      age > ARRIVAL_CACHE_MAX_AGE_MS ||
      age < -MAX_CLOCK_SKEW_MS ||
      !Array.isArray(parsed.columns) ||
      !parsed.columns.every(isArrivalColumn) ||
      !Array.isArray(parsed.tasks) ||
      !parsed.tasks.every(isArrivalTask)
    ) {
      return undefined;
    }
    return parsed as ArrivalSnapshot;
  } catch {
    return undefined;
  }
}

export function readArrivalSnapshot(
  storage: StorageReader,
  now = new Date(),
): ArrivalSnapshot | undefined {
  try {
    return parseArrivalSnapshot(storage.getItem(ARRIVAL_CACHE_KEY), now);
  } catch {
    return undefined;
  }
}

export function canApplyArrivalRefresh(input: {
  requestRevision: number;
  currentRevision: number;
  inFlightMutations: number;
}): boolean {
  return (
    input.requestRevision === input.currentRevision &&
    input.inFlightMutations === 0
  );
}

export function upsertArrivalTask<T extends { _id: string }>(
  current: T[],
  task: T,
): T[] {
  return [...current.filter((candidate) => candidate._id !== task._id), task];
}

export function writeArrivalSnapshot(
  storage: StorageWriter,
  columns: ArrivalColumn[],
  tasks: ArrivalTask[],
  now = new Date(),
): boolean {
  try {
    storage.setItem(
      ARRIVAL_CACHE_KEY,
      JSON.stringify({
        version: 1,
        savedAt: now.toISOString(),
        columns,
        tasks,
      } satisfies ArrivalSnapshot),
    );
    return true;
  } catch {
    return false;
  }
}
