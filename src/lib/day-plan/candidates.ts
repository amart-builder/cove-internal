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
  column: "today" | "in_flight";
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
};

export type BuildDayPlanCandidatesInput = {
  localDate: string;
  timezone: string;
  tasks: CandidateTaskInput[];
};

const PRIORITY_WEIGHT = { high: 0, medium: 1, low: 2 } as const;
const TITLE_MAX = 240;
const OUTCOME_MAX = 1200;
const PROJECT_MAX = 120;
const EVENT_ID_MAX = 200;
const EVENT_IDS_MAX = 20;

function validDate(value: string): boolean {
  return !Number.isNaN(new Date(value).getTime());
}
function localDateFor(value: string, timezone: string): string | undefined {
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
  const supports: RecommendationSourceRef["supports"] = ["commitment", "priority"];
  const rankReasons = [
    task.column === "in_flight" ? "accepted_in_flight" : "accepted_today",
    `priority_${task.priority}`,
  ];
  let whyToday = task.column === "in_flight"
    ? "This is accepted work already in flight."
    : "This is accepted work already committed for today.";

  if (isOverdue || isDueToday) {
    supports.push("deadline");
    rankReasons.unshift(isOverdue ? "verified_overdue" : "verified_due_today");
    whyToday = isOverdue
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
 * Builds a small, deterministic arrival set from accepted task records only.
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
