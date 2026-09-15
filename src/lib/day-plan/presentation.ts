/**
 * Pure presentation rules for the day-plan read model.
 *
 * Keep view labels, focus selection, polling decisions, and display fallbacks
 * here when they can be expressed without I/O. The browser and route layers can
 * then share the same decision and the test suite can verify it without mounting
 * the full Today surface.
 */
import type { MorningBriefGenerationState } from './brief';
import { getRuntimeMode, type RuntimeMode } from '../runtime/mode';
import type {
  DayPlan,
  DayPlanExecutionConfig,
  DayPlanExecutionReadiness,
  DayPlanExecutionRun,
  DayPlanExecutionRunStatus,
  DayPlanItem,
  DayPlanState,
  DayPlanOwner as DayOwner,
  SettlementDisposition,
} from './types';

export type SettlementDecision = SettlementDisposition;

function withNormalizedPositions<T extends DayPlanItem>(items: readonly T[]): T[] {
  return items.map((item, position) => ({ ...item, position }));
}

const OWNER_LABELS: Record<DayOwner, string> = {
  me: 'Me',
  claude: 'Claude',
  together: 'Together',
};

const OWNER_DESCRIPTIONS: Record<DayOwner, string> = {
  me: 'This needs your judgment or direct action.',
  claude: 'Starts a full Claude session in auto-edits mode when you start your day.',
  together: 'Starts the same task in plan mode when you start your day.',
};

function assertNever(value: never): never {
  throw new Error(`Unhandled execution status: ${String(value)}`);
}

const NON_PROJECT_TAGS = new Set([
  // 'Atlas' is the tasks table default, so it means no project was chosen.
  'atlas',
  'blocked',
  'captured-today',
  'email',
  'high',
  'jarvis-held',
  'low',
  'medium',
  'today',
  'urgent',
]);

// The Cove shelf holds only steady work: the rolling email card and recurring
// rhythm occurrences (tasks spawned from recurring_templates, linked through
// recurringTemplateId). One-off jarvis-held tasks stay off the shelf; they
// remain visible on the All Work board.
export type ShelfTask = {
  tags: string[];
  recurringTemplateId?: string;
  position: number;
};

function isEmailCurrentTask(task: ShelfTask): boolean {
  return task.tags.some((tag) => tag.trim().toLowerCase() === 'email-current');
}

export function belongsOnShelf(task: ShelfTask): boolean {
  return isEmailCurrentTask(task) || Boolean(task.recurringTemplateId);
}

export function selectShelfTasks<T extends ShelfTask>(openTasks: readonly T[]): T[] {
  return openTasks
    .filter(belongsOnShelf)
    .sort(
      (left, right) =>
        Number(Boolean(right.recurringTemplateId)) - Number(Boolean(left.recurringTemplateId)) ||
        left.position - right.position,
    );
}

export function morningArrivalGreeting(date: Date, timezone: string): string {
  const hourPart = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hourCycle: 'h23',
    timeZone: timezone,
  }).formatToParts(date).find((part) => part.type === 'hour')?.value;
  const hour = Number(hourPart);
  if (hour < 12) return 'Good morning.';
  if (hour < 17) return 'Good afternoon.';
  return 'Good evening.';
}

// The date the arrival screen prints above the brief. The brief itself is under
// standing orders never to state the date, so this is the only place it appears
// and it has to be right. localDate is already the calendar date in timezone, so
// it is formatted as UTC: converting it to an instant first could shift the day.
export function arrivalDateLabel(localDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  // Chrome-side formatting is not worth a thrown render. A malformed local date
  // means the header quietly says nothing rather than blanking the whole step.
  if (!match) return '';
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))));
}

export function formatArrivalDueDate(dueAt: string): string {
  const calendarDate = /^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.000)?Z)?$/.exec(dueAt)?.[1];
  const date = new Date(calendarDate ? `${calendarDate}T00:00:00Z` : dueAt);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(calendarDate ? { timeZone: 'UTC' } : {}),
  });
}

export function shortArrivalSummary(value: string | undefined, title?: string): string | undefined {
  const cleaned = value?.replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.toLocaleLowerCase() === title?.trim().toLocaleLowerCase()) {
    return undefined;
  }

  const maximum = 96;
  const firstSentence = cleaned.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? cleaned;
  if (firstSentence.length <= maximum) return firstSentence;

  const bounded = firstSentence.slice(0, maximum - 1);
  const lastSpace = bounded.lastIndexOf(' ');
  return `${bounded.slice(0, lastSpace > maximum * 0.6 ? lastSpace : bounded.length).trimEnd()}…`;
}

export function helpfulProjectLabel(value: string | undefined): string | undefined {
  const cleaned = value?.replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length > 32 || NON_PROJECT_TAGS.has(cleaned.toLocaleLowerCase())) {
    return undefined;
  }
  return cleaned;
}

export function executionRunStatusLabel(status: DayPlanExecutionRunStatus): string {
  switch (status) {
    case 'queued':
    case 'starting':
      return 'Waiting to start';
    case 'running':
      return 'Claude · working';
    case 'plan_ready':
    case 'ready_to_join':
    case 'awaiting_review':
      return 'Needs you · Review plan';
    case 'failed':
      return "Didn't finish · Retry";
    case 'interrupted':
    case 'cancelled':
      return 'Stopped · Restart';
    case 'cancelling':
      return 'Stopping…';
    default:
      return assertNever(status);
  }
}

export function executionReadinessMessage(
  readiness: DayPlanExecutionReadiness | undefined,
  owner: DayOwner,
): string {
  if (owner === 'me') return 'Choose Claude or Together before selecting an execution mode.';
  if (
    !readiness ||
    readiness.codes.includes('mode_required') ||
    readiness.codes.includes('owner_not_agent')
  ) {
    return owner === 'together'
      ? 'Choose Plan with Claude before kickoff.'
      : 'Choose Plan with Claude or Hands-off before kickoff.';
  }
  if (readiness.ready) return 'Ready to queue.';
  if (readiness.codes.includes('brief_changed')) {
    return 'The brief changed. Choose a mode again to refresh it.';
  }
  if (readiness.codes.includes('together_requires_plan_review')) {
    return 'Together can only use Plan with Claude.';
  }
  if (readiness.codes.includes('execution_disabled')) {
    return 'Hands-off work is not enabled on this Cove setup.';
  }
  if (readiness.codes.includes('definition_of_done_required')) {
    return 'Add a definition of done before hands-off work can start.';
  }
  if (
    readiness.codes.includes('workspace_required') ||
    readiness.codes.includes('workspace_not_allowlisted') ||
    readiness.codes.includes('workspace_missing') ||
    readiness.codes.includes('workspace_not_git')
  ) {
    return 'This task is not linked to an approved project for hands-off work.';
  }
  if (readiness.codes.includes('workspace_dirty')) {
    return 'The approved project has uncommitted changes, so hands-off work is paused.';
  }
  if (readiness.codes.includes('project_not_opted_in')) {
    return 'This project has not opted into hands-off work.';
  }
  if (
    readiness.codes.includes('budget_required') ||
    readiness.codes.includes('budget_exceeds_limit')
  ) {
    return 'Hands-off spend limit setup is incomplete.';
  }
  return 'This brief needs more context before kickoff.';
}

export function ownerLabel(owner: DayOwner, runtime: RuntimeMode = getRuntimeMode()): string {
  if (runtime === 'local' && owner === 'claude') return 'Cove agent';
  return OWNER_LABELS[owner];
}

export function ownerDescription(owner: DayOwner, runtime: RuntimeMode = getRuntimeMode()): string {
  if (runtime === 'local' && owner !== 'me') {
    return owner === 'claude'
      ? 'Open a session from Today when you are ready for your Cove agent to work on this task.'
      : 'Open a planning session from Today when you are ready to work with your Cove agent.';
  }
  return OWNER_DESCRIPTIONS[owner];
}

/** Closed-day history keeps every decision; Today's work honors the final disposition. */
export function currentDayPlanItems(plan?: Pick<DayPlan, 'state' | 'items'>): DayPlanItem[] {
  return (plan?.items ?? []).filter(item => plan?.state !== 'settled' || item.decision === 'completed' ||
    !['defer', 'drop'].includes(item.settlementDecision?.disposition ?? ''));
}

/** The active Today items in committed order, limited to the configured focus slots. */
export function focusBandItems<T extends DayPlanItem>(
  items: readonly T[],
  focusCount: number,
): T[] {
  const finiteFocusCount = Number.isFinite(focusCount) ? focusCount : 3;
  return [...items]
    .filter(
      (item) =>
        item.decision === 'preselected' ||
        item.decision === 'accepted',
    )
    .sort((left, right) => left.position - right.position)
    .slice(0, Math.max(1, Math.min(3, finiteFocusCount)));
}

export function canStartDayPlanSettlement(plan: DayPlan): boolean {
  if (plan.state === 'active') return true;
  if (plan.state === 'settling' && plan.settlementState === 'in_progress') return true;
  return plan.state === 'proposed' &&
    (plan.arrivalState === 'bypassed' ||
      plan.arrivalState === 'skipped' ||
      plan.arrivalState === 'snoozed');
}

export function reorderDayPlanItems<T extends DayPlanItem>(
  items: readonly T[],
  activeId: string,
  overId: string,
): T[] {
  const activeIndex = items.findIndex((item) => item.id === activeId);
  const overIndex = items.findIndex((item) => item.id === overId);
  if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) return [...items];

  const next = [...items];
  const [active] = next.splice(activeIndex, 1);
  next.splice(overIndex, 0, active);
  return withNormalizedPositions(next);
}

export function focusCountAfterArrivalDrag<T extends Pick<DayPlanItem, 'id'>>(
  items: readonly T[],
  activeId: string,
  overId: string,
  focusCount: 1 | 2 | 3,
): 1 | 2 | 3 {
  const activeIndex = items.findIndex((item) => item.id === activeId);
  const overIndex = items.findIndex((item) => item.id === overId);
  if (activeIndex < 0 || overIndex < 0) return focusCount;

  if (activeIndex >= focusCount && overIndex < focusCount) {
    return Math.min(3, focusCount + 1) as 1 | 2 | 3;
  }
  if (activeIndex < focusCount && overIndex >= focusCount) {
    return Math.max(1, focusCount - 1) as 1 | 2 | 3;
  }
  return focusCount;
}

export function selectRecommendedHumanFocus<T extends DayPlanItem>(
  items: readonly T[],
  preferredItemId?: string,
): T | undefined {
  const preferred = preferredItemId
    ? items.find((item) => item.id === preferredItemId)
    : undefined;

  if (preferred && preferred.owner !== 'claude') return preferred;
  return items.find((item) => item.owner !== 'claude') ?? preferred ?? items[0];
}

export function firstContinuingItem<T extends DayPlanItem>(
  items: readonly T[],
  decisions: Readonly<Record<string, SettlementDecision | undefined>>,
): T | undefined {
  return items.find((item) => decisions[item.id] === 'progress') ??
    items.find((item) => decisions[item.id] === 'carry');
}

export function allSettlementDecisionsMade<T extends DayPlanItem>(
  items: readonly T[],
  decisions: Readonly<Record<string, SettlementDecision | undefined>>,
): boolean {
  return items.every((item) => Boolean(decisions[item.id]));
}

export function shouldAutoPostProgress(input: {
  workedToday: boolean;
  hasDecision: boolean;
  attempts: number;
}): boolean {
  return input.workedToday && !input.hasDecision && input.attempts < 2;
}

export function combineSurfaceErrors(...errors: Array<string | undefined>): string | undefined {
  const messages = [...new Set(errors.map((error) => error?.trim()).filter(Boolean))];
  return messages.length > 0 ? messages.join(' ') : undefined;
}

export type CurrentExecutionRow = {
  latestRun?: DayPlanExecutionRun;
  currentRun?: DayPlanExecutionRun;
};

// Shared, pure "current execution row" selector. Applies the latest-attempt rule
// (newest createdAt for the item) and the brief/authorization/mode hash match, so a
// run whose brief or authorization drifted from the saved config is never treated as
// current. Reused by the board's hero and downstream execution indicators.
export function selectCurrentExecutionRow(
  runs: readonly DayPlanExecutionRun[],
  itemId: string,
  config: DayPlanExecutionConfig | undefined,
): CurrentExecutionRow {
  const latestRun = [...runs]
    .filter((run) => run.itemId === itemId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  const currentRun = latestRun && config &&
    latestRun.briefHash === config.briefHash &&
    latestRun.authorizationHash === config.authorizationHash &&
    latestRun.mode === config.mode
    ? latestRun
    : undefined;
  return { latestRun, currentRun };
}

const RETRYABLE_RUN_STATUSES = new Set<DayPlanExecutionRunStatus>([
  'failed',
  'interrupted',
  'cancelled',
]);

// Terminal statuses the store explicitly supports retrying with a fresh attempt under
// the same current authorization. A run in one of these states must not block kickoff.
export function isRetryableRunStatus(status: DayPlanExecutionRunStatus): boolean {
  return RETRYABLE_RUN_STATUSES.has(status);
}

export type BoardExecutionPresentation = {
  statusLabel?: string;
  action: 'none' | 'open' | 'start_plan' | 'retry' | 'restart';
  showKickoff: boolean;
  reviewable: boolean;
};

export function selectBoardExecutionPresentation(input: {
  owner: DayOwner;
  run?: DayPlanExecutionRun;
  taskDone?: boolean;
}): BoardExecutionPresentation {
  if (input.taskDone) {
    return { statusLabel: 'Done', action: 'none', showKickoff: false, reviewable: false };
  }
  const run = input.run;
  if (!run) {
    return input.owner === 'claude' || input.owner === 'together'
      ? { action: 'start_plan', showKickoff: true, reviewable: false }
      : { action: 'none', showKickoff: false, reviewable: false };
  }
  switch (run.status) {
    case 'queued':
    case 'starting':
      return {
        statusLabel: 'Waiting to start',
        action: 'none',
        showKickoff: false,
        reviewable: false,
      };
    case 'running':
      return {
        statusLabel: 'Claude · working',
        action: 'none',
        showKickoff: false,
        reviewable: false,
      };
    case 'plan_ready':
    case 'ready_to_join':
    case 'awaiting_review':
      return {
        statusLabel: 'Needs you · Review plan',
        action: run.claudeSessionId ? 'open' : 'restart',
        showKickoff: !run.claudeSessionId,
        reviewable: true,
      };
    case 'failed':
      return {
        statusLabel: "Didn't finish · Retry",
        action: 'retry',
        showKickoff: true,
        reviewable: false,
      };
    case 'interrupted':
    case 'cancelled':
      return {
        statusLabel: 'Stopped · Restart',
        action: 'restart',
        showKickoff: true,
        reviewable: false,
      };
    case 'cancelling':
      return {
        statusLabel: 'Stopping…',
        action: 'none',
        showKickoff: false,
        reviewable: false,
      };
    default:
      return assertNever(run.status);
  }
}

export function shouldShowNeedsSetupToStart(input: {
  planState: DayPlanState;
  owner: DayOwner;
  hasRun: boolean;
  taskDone?: boolean;
  startDayApplying?: boolean;
}): boolean {
  return !input.startDayApplying &&
    input.planState === 'active' &&
    (input.owner === 'claude' || input.owner === 'together') &&
    !input.hasRun &&
    !input.taskDone;
}

export function startDayReceiptCopy(
  startingCount: number,
  alreadyInMotionCount: number,
  failedTitles: readonly string[] = [],
): string {
  const starting = `Claude is starting on ${startingCount} ${startingCount === 1 ? 'item' : 'items'}.`;
  const base = alreadyInMotionCount > 0
    ? `${starting} ${alreadyInMotionCount} already in motion.`
    : starting;
  return failedTitles.length > 0
    ? `${base} Could not start: ${failedTitles.join(', ')}.`
    : base;
}

export function executionRestartLabel(status: DayPlanExecutionRunStatus): 'Retry' | 'Restart' {
  return status === 'failed' ? 'Retry' : 'Restart';
}

export function executionWorkspaceLabel(id: string): string {
  const segment = id.split(/[\\/]/).filter(Boolean).at(-1) ?? id;
  const words = segment.replace(/[-_]+/g, ' ').trim().toLocaleLowerCase();
  return words ? `${words[0].toLocaleUpperCase()}${words.slice(1)}` : id;
}

// Deep-link that asks the Claude desktop app to import and resume a CLI session.
export function claudeResumeUrl(sessionId: string): string {
  return `claude://resume?session=${encodeURIComponent(sessionId)}`;
}

export type RitualContentSwapDecision = 'none' | 'immediate' | 'crossfade';

// Pure decision for swapping ritual content inside the one mounted DayRitualLayer.
// Same view: nothing to do. Reduced motion: swap in place with no exit/enter motion.
// Otherwise: fade the outgoing content quickly, then let the incoming content arrive.
export function resolveRitualContentSwap(input: {
  displayedKey: string;
  nextKey: string;
  reducedMotion: boolean;
}): RitualContentSwapDecision {
  if (input.displayedKey === input.nextKey) return 'none';
  return input.reducedMotion ? 'immediate' : 'crossfade';
}

// One plain line explaining why Closing your day is showing a date that is not today.
// Today's own close gets no extra line.
export function staleSettlementNotice(
  planLocalDate: string,
  todayLocalDate: string,
): string | undefined {
  if (planLocalDate === todayLocalDate) return undefined;
  const label = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${planLocalDate}T12:00:00.000Z`));
  return `${label} was never closed. Close it before today's plan begins.`;
}

// Fallback when there is not enough history to estimate from. Roughly the
// observed typical run; only used until three real runs exist.
export const DEFAULT_BRIEF_ESTIMATE_SECONDS = 150;

// How long to tell him the brief will take, from how long recent briefs
// actually took. Deliberately the MEDIAN, not the mean: real runs cluster
// tightly (75-183s across a fortnight) with occasional 7-11 minute outliers,
// and averaging lets one bad night misreport every normal morning after it.
export function estimateBriefSeconds(durationsSeconds: readonly number[]): number {
  const usable = durationsSeconds
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (usable.length < 3) return DEFAULT_BRIEF_ESTIMATE_SECONDS;
  const middle = Math.floor(usable.length / 2);
  const median =
    usable.length % 2 === 0
      ? (usable[middle - 1] + usable[middle]) / 2
      : usable[middle];
  return Math.round(median);
}

// Progress for the arrival's generating state. Two honesty rules: the bar never
// reaches full while the brief is still being written (a bar that sits at 100%
// reads as broken or as a lie), and once it runs past the estimate it stops
// pretending to know, handing the UI an overrun flag to render instead.
export function briefProgress(
  elapsedSeconds: number,
  estimateSeconds: number,
): { fraction: number; overrun: boolean } {
  const { elapsed, estimate } = sanitizeBriefTiming(elapsedSeconds, estimateSeconds);
  if (elapsed >= estimate) return { fraction: 0.95, overrun: true };
  return { fraction: Math.min(0.95, elapsed / estimate), overrun: false };
}

// Both progress readouts take numbers that come from timestamps parsed at
// runtime, so a missing or malformed one must degrade to the default estimate
// rather than render "About NaN minutes left."
function sanitizeBriefTiming(
  elapsedSeconds: number,
  estimateSeconds: number,
): { elapsed: number; estimate: number } {
  return {
    elapsed: Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0,
    estimate:
      Number.isFinite(estimateSeconds) && estimateSeconds > 0
        ? estimateSeconds
        : DEFAULT_BRIEF_ESTIMATE_SECONDS,
  };
}

// The "go get a coffee" line. Rounded up to the half minute so it reads as an
// estimate rather than a countdown, and it never claims seconds precision it
// does not have.
export function briefRemainingLabel(
  elapsedSeconds: number,
  estimateSeconds: number,
): string {
  const { overrun } = briefProgress(elapsedSeconds, estimateSeconds);
  if (overrun) return 'Taking longer than usual. Still working.';
  const { elapsed, estimate } = sanitizeBriefTiming(elapsedSeconds, estimateSeconds);
  const remaining = Math.max(0, estimate - elapsed);
  if (remaining <= 20) return 'Almost done.';
  const minutes = Math.round(remaining / 30) / 2;
  if (minutes <= 1) return 'About a minute left.';
  return `About ${minutes} minutes left.`;
}

export const MORNING_BRIEF_ATTACH_POLL_LIMIT = 8;

export function advanceMorningBriefAttachPoll(input: {
  consecutiveSucceededPolls: number;
  briefAttached: boolean;
  generationState?: MorningBriefGenerationState;
}): { consecutiveSucceededPolls: number; attachTimedOut: boolean } {
  if (input.briefAttached || input.generationState !== 'succeeded') {
    return { consecutiveSucceededPolls: 0, attachTimedOut: false };
  }
  const current = Number.isInteger(input.consecutiveSucceededPolls)
    ? Math.max(0, input.consecutiveSucceededPolls)
    : 0;
  const consecutiveSucceededPolls = Math.min(
    current + 1,
    MORNING_BRIEF_ATTACH_POLL_LIMIT,
  );
  return {
    consecutiveSucceededPolls,
    attachTimedOut:
      consecutiveSucceededPolls >= MORNING_BRIEF_ATTACH_POLL_LIMIT,
  };
}

export function isMorningBriefWriting(input: {
  briefAttached: boolean;
  arrivalInteracted: boolean;
  attachTimedOut: boolean;
  generationState?: MorningBriefGenerationState;
}): boolean {
  if (input.briefAttached) return false;
  if (input.generationState === 'queued' || input.generationState === 'running') return true;
  return (
    input.generationState === 'succeeded' &&
    !input.arrivalInteracted &&
    !input.attachTimedOut
  );
}

export function morningBriefArrivalPresentation(input: {
  headline?: string;
  paragraphs: readonly string[];
  hasBriefContent: boolean;
  briefWriting: boolean;
  briefAttached: boolean;
  generationState?: MorningBriefGenerationState;
}): {
  stalled: boolean;
  failed: boolean;
  leadHeadline?: string;
  body: string[];
} {
  const hasWrittenBrief = input.briefAttached && input.hasBriefContent;
  if (input.briefAttached && !hasWrittenBrief) {
    return { stalled: true, failed: false, leadHeadline: 'Loading your saved brief.', body: [] };
  }
  const deferred = !hasWrittenBrief && input.generationState === 'deferred';
  const stalled = !hasWrittenBrief && !deferred && !input.briefWriting;
  const failed = !hasWrittenBrief && input.generationState === 'failed';
  const writing = input.briefWriting && !hasWrittenBrief;
  const leadHeadline = hasWrittenBrief
    ? input.headline
    : deferred
      ? 'Your brief is waiting for writing capacity.'
      : failed
        ? "Cove couldn't finish your brief."
        : writing
          ? 'Your brief is on the way.'
          : "Today's brief isn't written yet.";
  // A complete saved brief is the only body this screen can display.
  const body = hasWrittenBrief ? [...input.paragraphs] : [];
  return { stalled, failed, leadHeadline, body };
}

export function morningBriefPendingLabel(
  generationState?: MorningBriefGenerationState,
): string {
  return generationState === 'succeeded'
    ? 'Finishing up…'
    : 'Your brief is queued…';
}

// Pure gate for polling the day-plan read model to pick up a brief that finishes
// generating after the arrival opened. Poll only while the arrival view is open,
// the document is visible, the user has not interacted (the no-hot-swap rule: a
// touched arrival never accepts a late brief), and no brief is attached yet. A
// succeeded generation keeps polling during that window so the guarded ensure
// path can attach it once fresh candidates are ready.
export function shouldPollBriefGeneration(input: {
  view: string;
  documentVisible: boolean;
  briefAttached: boolean;
  arrivalInteracted: boolean;
  attachTimedOut: boolean;
  generationState?: MorningBriefGenerationState;
}): boolean {
  if (input.view !== 'arrival') return false;
  if (!input.documentVisible) return false;
  if (input.arrivalInteracted) return false;
  return !input.briefAttached && input.generationState === 'deferred' || isMorningBriefWriting(input);
}

// Pure gate for the ONE-SHOT attach/heal ensure fired at initialization and on
// regaining document visibility. It covers both a brief that finished while the
// app was closed and an empty plan created before board candidates existed.
export function shouldAttemptLateBriefAttach(input: {
  planState?: string;
  arrivalState?: string;
  hasConsumedBrief: boolean;
  arrivalInteractedAt?: string;
  interacted: boolean;
  documentVisible: boolean;
  candidatesReady: boolean;
  candidateCount: number;
  generationState?: MorningBriefGenerationState;
  itemCount?: number;
  alreadyAttempted: boolean;
}): boolean {
  if (input.alreadyAttempted) return false;
  if (!input.documentVisible) return false;
  if (input.planState !== 'draft' && input.planState !== 'proposed') return false;
  if (
    input.arrivalState !== 'not_due' &&
    input.arrivalState !== 'due' &&
    input.arrivalState !== 'opened'
  ) return false;
  if (input.hasConsumedBrief && input.itemCount !== 0) return false;
  if (input.arrivalInteractedAt) return false;
  if (input.interacted) return false;
  // A succeeded brief can attach without board candidates. Item healing still
  // waits for fresh candidates, preserving the evidence boundary for tasks.
  if (!input.hasConsumedBrief && input.generationState === 'succeeded') return true;
  return input.candidatesReady && input.candidateCount > 0;
}
