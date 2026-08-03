import type {
  DayPlanOwner,
  RecommendationCandidate,
  RecommendationSourceRef,
} from "./types";

export type CandidateTaskInput = {
  id: string;
  title: string;
  description?: string;
  priority: "low" | "medium" | "high";
  dueAt?: string | null;
  position: number;
  column: "today" | "in_flight" | "due_backlog";
  status: "open" | "done" | "archived";
  updatedAt: string;
  refreshedAt: string;
  freshness?: RecommendationSourceRef["freshness"];
  owner?: DayPlanOwner;
  outcome?: string;
  outcomeKey?: string;
  definitionOfDone?: string;
  project?: string;
  humanDecisionEventIds?: string[];
  briefPicked?: boolean;
};

export type BuildDayPlanCandidatesInput = {
  localDate: string;
  timezone: string;
  tasks: CandidateTaskInput[];
};

export type ArrivalCandidateSelectionTask = {
  id?: string;
  _id?: string;
  columnId: string;
  dueAt?: string | null;
  position: number;
  tags: readonly string[];
};

export type SelectArrivalCandidateTasksInput = {
  localDate: string;
  timezone: string;
  todayColumnId?: string;
  inFlightColumnId?: string;
  localMode: boolean;
  preferredTaskIds?: readonly string[];
  maximum?: number;
};

const PRIORITY_WEIGHT = { high: 0, medium: 1, low: 2 } as const;
const TITLE_MAX = 240;
const OUTCOME_MAX = 1200;
const PROJECT_MAX = 120;
const EVENT_ID_MAX = 200;
const EVENT_IDS_MAX = 20;

function arrivalTaskId(task: ArrivalCandidateSelectionTask): string {
  return task.id ?? task._id ?? "";
}

function hasNormalizedTag(tags: readonly string[], tag: string): boolean {
  return tags.some((candidate) => candidate.trim().toLowerCase() === tag);
}

/**
 * Selects the task records that may enter Morning Arrival before their evidence
 * is validated by buildDayPlanCandidates. Accepted Today/In Flight work keeps
 * the first tier; dated backlog work can fill the remaining slots.
 */
export function selectArrivalCandidateTasks<T extends ArrivalCandidateSelectionTask>(
  tasks: readonly T[],
  input: SelectArrivalCandidateTasksInput,
): T[] {
  const maximum = Math.max(0, input.maximum ?? 10);
  if (maximum === 0) return [];

  const eligible = tasks.filter(
    (task) =>
      !hasNormalizedTag(task.tags, "jarvis-held") &&
      !hasNormalizedTag(task.tags, "email-current") &&
      (!input.localMode || !hasNormalizedTag(task.tags, "recurring")),
  );
  const activeColumnIds = new Set(
    [input.todayColumnId, input.inFlightColumnId].filter(
      (columnId): columnId is string => Boolean(columnId),
    ),
  );
  const byId = new Map(eligible.map((task) => [arrivalTaskId(task), task]));
  const preferred = [...new Set(input.preferredTaskIds ?? [])]
    .flatMap((taskId) => {
      const task = byId.get(taskId);
      return task ? [task] : [];
    });
  const commitments = eligible
    .filter((task) => activeColumnIds.has(task.columnId))
    .sort((left, right) => {
      const leftFlight = left.columnId === input.inFlightColumnId ? 0 : 1;
      const rightFlight = right.columnId === input.inFlightColumnId ? 0 : 1;
      return leftFlight - rightFlight || left.position - right.position;
    });
  const dueBacklog = eligible
    .flatMap((task) => {
      if (activeColumnIds.has(task.columnId) || !task.dueAt) return [];
      const dueLocalDate = localDateFor(task.dueAt, input.timezone);
      return dueLocalDate && dueLocalDate <= input.localDate
        ? [{ task, dueLocalDate }]
        : [];
    })
    .sort((left, right) =>
      left.dueLocalDate.localeCompare(right.dueLocalDate) ||
      left.task.position - right.task.position,
    )
    .map(({ task }) => task);

  const seen = new Set(preferred.map(arrivalTaskId));
  return [
    ...preferred,
    ...commitments.filter((task) => {
      const id = arrivalTaskId(task);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }),
    ...dueBacklog.filter((task) => {
      const id = arrivalTaskId(task);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }),
  ].slice(0, maximum);
}

/** Keeps the evidence builder's rank stable while enforcing coarse UI tiers. */
export function orderArrivalCandidatesByTier(
  candidates: readonly RecommendationCandidate[],
  tierByTaskId: ReadonlyMap<string, number>,
): RecommendationCandidate[] {
  return candidates
    .map((candidate, rankIndex) => ({ candidate, rankIndex }))
    .sort((left, right) =>
      (tierByTaskId.get(left.candidate.taskId) ?? Number.MAX_SAFE_INTEGER) -
        (tierByTaskId.get(right.candidate.taskId) ?? Number.MAX_SAFE_INTEGER) ||
      left.rankIndex - right.rankIndex,
    )
    .map(({ candidate }) => candidate);
}

function validDate(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}
export function localDateFor(value: string, timezone: string): string | undefined {
  // A bare local date carries no time to convert; parsing it as UTC midnight
  // would shift it a day earlier in negative-offset timezones.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return validDate(`${value}T12:00:00.000Z`) ? value : undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return undefined;
  }
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function cleanBounded(value: string | undefined, maximum: number): string | undefined {
  const cleaned = clean(value);
  if (!cleaned || cleaned.length <= maximum) return cleaned;
  return `${cleaned.slice(0, maximum - 1).trimEnd()}…`;
}

function boundedEventIds(values: string[] | undefined): string[] {
  return [...new Set(
    (values ?? [])
      .map((value) => clean(value))
      .filter((value): value is string => Boolean(value && value.length <= EVENT_ID_MAX)),
  )].slice(0, EVENT_IDS_MAX);
}

function candidateForTask(
  task: CandidateTaskInput,
  localDate: string,
  timezone: string,
): RecommendationCandidate | undefined {
  const title = cleanBounded(task.title, TITLE_MAX);
  if (
    !title ||
    !clean(task.id) ||
    task.id.length > 200 ||
    task.status !== "open" ||
    !Number.isFinite(task.position) ||
    !validDate(task.updatedAt) ||
    !validDate(task.refreshedAt) ||
    (task.freshness && task.freshness !== "current")
  ) {
    return undefined;
  }

  const dueDate = task.dueAt ? localDateFor(task.dueAt, timezone) : undefined;
  const explicitOutcomeKey = clean(task.outcomeKey);
  const outcomeKey = explicitOutcomeKey && explicitOutcomeKey.length <= TITLE_MAX
    ? explicitOutcomeKey
    : `task:${task.id}`;
  const isOverdue = Boolean(dueDate && dueDate < localDate);
  const isDueToday = dueDate === localDate;
  if (
    task.column === "due_backlog" &&
    !task.briefPicked &&
    !isOverdue &&
    !isDueToday
  ) return undefined;
  const supports: RecommendationSourceRef["supports"] = ["commitment", "priority"];
  const rankReasons = [
    task.briefPicked && task.column === "due_backlog"
      ? "brief_pick_transport"
      : task.column === "in_flight"
      ? "accepted_in_flight"
      : task.column === "today"
        ? "accepted_today"
        : "due_backlog",
    `priority_${task.priority}`,
  ];
  let whyToday = task.briefPicked && task.column === "due_backlog"
    ? "This open task was selected for today's plan."
    : task.column === "in_flight"
    ? "This is accepted work already in flight."
    : task.column === "today"
      ? "This is accepted work already committed for today."
      : "This is due today and still open.";

  if (isOverdue || isDueToday) {
    supports.push("deadline");
    rankReasons.unshift(isOverdue ? "verified_overdue" : "verified_due_today");
    whyToday = task.column === "due_backlog"
      ? isOverdue
        ? "This is overdue and still open."
        : "This is due today and still open."
      : isOverdue
        ? "This accepted commitment has a verified overdue date."
        : "This accepted commitment has a verified due date today.";
  }

  return {
    candidateId: `task:${task.id}`,
    taskId: task.id,
    outcomeKey,
    title,
    outcome: cleanBounded(
      clean(task.outcome) ?? clean(task.description) ?? title,
      OUTCOME_MAX,
    )!,
    definitionOfDone: cleanBounded(task.definitionOfDone, OUTCOME_MAX),
    project: cleanBounded(task.project, PROJECT_MAX),
    owner: task.owner ?? "me",
    commitment: "ink",
    whyToday,
    priority: task.priority,
    dueAt: task.dueAt && validDate(task.dueAt) ? task.dueAt : undefined,
    sourceRefs: [
      {
        sourceType: "task",
        recordId: task.id,
        sourceUpdatedAt: task.updatedAt,
        refreshedAt: task.refreshedAt,
        freshness: "current",
        supports,
      },
    ],
    newestSourceRefreshAt: task.refreshedAt,
    conflicts: [],
    humanDecisionEventIds: boundedEventIds(task.humanDecisionEventIds),
    rankReasons,
  };
}

/**
 * Builds a small, deterministic arrival set from open task records only.
 * It intentionally does not infer urgency, ownership, duration, or people
 * waiting from prose. New source types can be added only with their own
 * freshness and evidence rules. The default keeps the classic three-item
 * proposal; a larger maximum gives the Morning Brief overlay a deterministic
 * pool to rank within (the server still keeps at most three).
 */
export function buildDayPlanCandidates(
  input: BuildDayPlanCandidatesInput,
  maximum = 3,
): RecommendationCandidate[] {
  const candidates = input.tasks
    .map((task) => ({
      task,
      candidate: candidateForTask(task, input.localDate, input.timezone),
    }))
    .filter(
      (entry): entry is { task: CandidateTaskInput; candidate: RecommendationCandidate } =>
        Boolean(entry.candidate),
    )
    .sort((left, right) => {
      const leftDue = left.candidate.rankReasons[0]?.startsWith("verified_") ? 0 : 1;
      const rightDue = right.candidate.rankReasons[0]?.startsWith("verified_") ? 0 : 1;
      const leftColumn = left.task.column === "in_flight" ? 0 : 1;
      const rightColumn = right.task.column === "in_flight" ? 0 : 1;
      return (
        leftDue - rightDue ||
        PRIORITY_WEIGHT[left.task.priority] - PRIORITY_WEIGHT[right.task.priority] ||
        leftColumn - rightColumn ||
        left.task.position - right.task.position ||
        left.task.id.localeCompare(right.task.id)
      );
    });

  const seenTasks = new Set<string>();
  const seenOutcomes = new Set<string>();
  const result: RecommendationCandidate[] = [];
  for (const { candidate } of candidates) {
    if (seenTasks.has(candidate.taskId) || seenOutcomes.has(candidate.outcomeKey)) continue;
    seenTasks.add(candidate.taskId);
    seenOutcomes.add(candidate.outcomeKey);
    result.push(candidate);
    if (result.length === Math.max(1, maximum)) break;
  }
  return result;
}
