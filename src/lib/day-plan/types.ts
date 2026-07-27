export type DayPlanState =
  | "draft"
  | "proposed"
  | "active"
  | "settling"
  | "settled"
  | "abandoned";

export type ArrivalState =
  | "not_due"
  | "due"
  | "opened"
  | "snoozed"
  | "skipped"
  | "confirmed"
  | "bypassed"
  | "failed";

export type SettlementState =
  | "not_due"
  | "offered"
  | "in_progress"
  | "skipped"
  | "committed"
  | "settled";

export type DayPlanOwner = "me" | "claude" | "together";
export type DayPlanExecutionMode = "plan_review" | "autonomous";
export type DayPlanModelAlias = "sonnet" | "opus" | "fable";
export type DayPlanCommitment = "ink" | "pencil";
export type DayPlanItemDecision =
  | "pending"
  | "preselected"
  | "accepted"
  | "completed"
  | "later"
  | "dismissed";
export type SettlementDisposition = "progress" | "carry" | "defer" | "drop";

export type RecommendationSourceType =
  | "task"
  | "suggestion"
  | "snapshot"
  | "email"
  | "crm"
  | "decision";

export type RecommendationSupport =
  | "commitment"
  | "deadline"
  | "waiting_person"
  | "carryover"
  | "returned_work"
  | "priority";

export type RecommendationSourceRef = {
  sourceType: RecommendationSourceType;
  recordId: string;
  sourceUpdatedAt: string;
  refreshedAt: string;
  freshness: "current" | "stale" | "missing" | "contradicted";
  supports: RecommendationSupport[];
};

export type RecommendationCandidate = {
  candidateId: string;
  taskId: string;
  outcomeKey: string;
  title: string;
  outcome: string;
  definitionOfDone?: string;
  project?: string;
  owner: DayPlanOwner;
  commitment: "ink";
  whyToday: string;
  priority: "low" | "medium" | "high";
  dueAt?: string;
  sourceRefs: RecommendationSourceRef[];
  newestSourceRefreshAt: string;
  conflicts: string[];
  humanDecisionEventIds: string[];
  rankReasons: string[];
};

// Morning Brief presentation overlaid on an arrival item at ensure time. It is
// rationale only: the item's own whyToday, evidence, and dates stay the
// deterministic task-backed values.
export type DayPlanItemBriefAnnotation = {
  whyToday: string;
  whatClaudeCanStart?: string;
  suggestedOwner?: DayPlanOwner;
};

export type DayPlanItem = RecommendationCandidate & {
  id: string;
  position: number;
  decision: DayPlanItemDecision;
  brief?: DayPlanItemBriefAnnotation;
  settlementDecision?: {
    disposition: SettlementDisposition;
    deferUntil?: string;
    progressNote?: string;
    nextStep?: string;
    decidedAt: string;
  };
  // Server-projected settlement evidence. It is never persisted in items_json.
  workedToday?: boolean;
};

export type DayPlan = {
  id: string;
  localDate: string;
  timezone: string;
  state: DayPlanState;
  arrivalState: ArrivalState;
  settlementState: SettlementState;
  version: number;
  lastMutationId?: string;
  items: DayPlanItem[];
  // The Morning Brief artifact consumed when this plan was proposed, if any.
  // Set at ensure, or attached once by a guarded late-attach before the arrival
  // is touched; never hot-swapped after any interaction.
  briefId?: string;
  // The durable first-interaction marker. Once set (by an explicit interaction
  // mutation or automatically by any content mutation) the arrival is frozen
  // against a late brief attach. Null on a pristine, untouched arrival.
  arrivalInteractedAt?: string;
  recommendedFirstItemId?: string;
  recommendedFirstTaskId?: string;
  snoozedUntil?: string;
  nextDayNote?: string;
  confirmedAt?: string;
  settledAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type DaySnapshotItem = {
  dayPlanItemId: string;
  taskId: string;
  title: string;
  owner: DayPlanOwner;
  disposition: SettlementDisposition;
  deferUntil?: string;
  progressNote?: string;
  nextStep?: string;
};

export type DaySnapshotBody = {
  completedHumanTaskIds: string[];
  returnedAgentWork: [];
  unresolvedItems: DaySnapshotItem[];
  humanDecisionEventIds: string[];
  overnightQueue: [];
  nextDayRecommendationSeed?: {
    dayPlanItemId: string;
    taskId: string;
    title: string;
  };
};

export type DaySnapshot = {
  id: string;
  dayPlanId: string;
  localDate: string;
  timezone: string;
  version: 1;
  body: DaySnapshotBody;
  createdAt: string;
};

export type DayDumpStatus = "queued" | "running" | "succeeded" | "failed";

export type DayDump = {
  id: string;
  targetLocalDate: string;
  rawText: string;
  status: DayDumpStatus;
  resultJson?: string;
  errorCode?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
};

export type DayPlanReconciliation = {
  id: string;
  dayPlanId: string;
  snapshotId: string;
  taskId: string;
  action: "defer" | "drop" | "resurface";
  availableAt?: string;
  state: "pending" | "scheduled" | "applied";
  createdAt: string;
  appliedAt?: string;
};

export type DayPlanEvent = {
  id: string;
  dayPlanId: string;
  eventType: DayPlanEventType;
  expectedVersion?: number;
  resultVersion: number;
  before?: unknown;
  after?: unknown;
  createdAt: string;
};

export type DayPlanEventType =
  | "ensure"
  | "brief_attach"
  | "arrival_interact"
  | "assistant_patch"
  | "item_kickoff"
  | DayPlanMutationAction;

export type DayPlanMutationAction =
  | "arrival_open"
  | "arrival_snooze"
  | "arrival_skip"
  | "arrival_bypass"
  | "arrival_reopen"
  | "item_accept"
  | "item_edit"
  | "item_later"
  | "item_dismiss"
  | "item_add"
  | "item_owner"
  | "item_reorder"
  | "start_day"
  | "settlement_offer"
  | "settlement_skip"
  | "settlement_start"
  | "settlement_decide"
  | "settlement_commit";

export type EnsureDayPlanInput = {
  localDate: string;
  timezone: string;
  mutationId: string;
  candidates: RecommendationCandidate[];
  // Late-brief poll mode: only attempt the guarded late-attach on an EXISTING
  // plan. When nothing attaches, the call is a silent no-op — no ledger event,
  // no mutation-id consumption — so a repeating poll never grows the ledger.
  // Never creates a plan.
  attachOnly?: boolean;
};

export type DayPlanMutationInput = {
  planId: string;
  mutationId: string;
  expectedVersion: number;
  action: DayPlanMutationAction;
  itemId?: string;
  title?: string;
  outcome?: string;
  definitionOfDone?: string;
  why?: string;
  owner?: DayPlanOwner;
  position?: number;
  snoozedUntil?: string;
  disposition?: SettlementDisposition;
  deferUntil?: string;
  progressNote?: string;
  nextStep?: string;
  completedHumanTaskIds?: string[];
  nextDayNote?: string;
};

export type DayPlanMutationResult = {
  plan: DayPlan;
  snapshot?: DaySnapshot;
  pendingReconciliations?: DayPlanReconciliation[];
  executionRuns?: DayPlanExecutionRun[];
  unreadyItems?: DayPlanUnreadyItem[];
  kickoffSkips?: DayPlanKickoffSkip[];
  worker?: {
    queuedRuns: number;
    available: boolean;
  };
  replayed: boolean;
};

export type DayPlanReconciliationResult = {
  reconciliation: DayPlanReconciliation;
  replayed: boolean;
};

export type DayPlanReadModel = {
  currentPlan?: DayPlan;
  latestSnapshot?: DaySnapshot;
  pendingReconciliations: DayPlanReconciliation[];
  pendingTaskMutations: DayPlanTaskMutation[];
};

export type DayPlanTaskMutation = {
  id: string;
  dayPlanId: string;
  assistantTurnId: string;
  taskId: string;
  action: "create" | "update" | "complete";
  title?: string;
  description?: string;
  priority?: "low" | "medium" | "high";
  project?: string;
  state: "pending" | "applied";
  createdAt: string;
  appliedAt?: string;
};

export type DayPlanTaskMutationResult = {
  mutation: DayPlanTaskMutation;
  replayed: boolean;
};

export type DayPlanAssistantOperation =
  | {
      operation: "edit_item";
      itemId: string;
      title?: string;
      outcome?: string;
      definitionOfDone?: string | null;
      position?: number;
    }
  | {
      operation: "set_owner";
      itemId: string;
      owner: DayPlanOwner;
    }
  | {
      operation: "create_item";
      clientId: string;
      title: string;
      outcome: string;
      definitionOfDone?: string;
      project?: string;
      owner?: DayPlanOwner;
      priority?: "low" | "medium" | "high";
      position: number;
    }
  | {
      operation: "complete_item";
      itemId: string;
    }
  | {
      operation: "reorder";
      orderedItemIds: string[];
    };

export type DayPlanAssistantProposal = {
  assistantText: string;
  needsClarification: boolean;
  operations: DayPlanAssistantOperation[];
};

export type DayPlanAssistantTurnState =
  | "queued"
  | "running"
  | "proposed"
  | "applied"
  | "conflict"
  | "failed"
  | "cancelled";

export type DayPlanAssistantTurn = {
  id: string;
  dayPlanId: string;
  baseVersion: number;
  userText: string;
  state: DayPlanAssistantTurnState;
  proposal?: DayPlanAssistantProposal;
  resultVersion?: number;
  errorCode?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  appliedAt?: string;
};

export type DayPlanExecutionConfig = {
  dayPlanId: string;
  itemId: string;
  mode: DayPlanExecutionMode;
  modelAlias: DayPlanModelAlias;
  workspaceId?: string;
  budgetUsd?: number;
  briefHash: string;
  authorizationHash: string;
  lastMutationId: string;
  configuredAt: string;
  updatedAt: string;
};

export type DayPlanReadinessCode =
  | "ready"
  | "owner_not_agent"
  | "mode_required"
  | "together_requires_plan_review"
  | "brief_changed"
  | "execution_disabled"
  | "definition_of_done_required"
  | "workspace_required"
  | "workspace_not_allowlisted"
  | "workspace_missing"
  | "workspace_not_git"
  | "workspace_dirty"
  | "project_not_opted_in"
  | "budget_required"
  | "budget_exceeds_limit";

export type DayPlanExecutionReadiness = {
  ready: boolean;
  codes: DayPlanReadinessCode[];
  checkedAt: string;
  workspacePath?: string;
  maximumBudgetUsd?: number;
};

export type DayPlanExecutionRunStatus =
  | "queued"
  | "starting"
  | "running"
  | "plan_ready"
  | "ready_to_join"
  | "awaiting_review"
  | "failed"
  | "interrupted"
  | "cancelling"
  | "cancelled";

export type DayPlanExecutionRun = {
  id: string;
  dayPlanId: string;
  itemId: string;
  taskId: string;
  owner: DayPlanOwner;
  mode: DayPlanExecutionMode;
  modelAlias: DayPlanModelAlias;
  status: DayPlanExecutionRunStatus;
  idempotencyKey: string;
  attempt: number;
  claudeSessionId: string;
  // Loopback-only command projection for recovering when the Claude deep link is blocked.
  resumeCommand?: string;
  briefHash: string;
  authorizationHash: string;
  promptSnapshot: {
    title: string;
    outcome: string;
    definitionOfDone?: string;
    whyToday: string;
    project?: string;
    dueAt?: string;
    progressNote?: string;
    nextStep?: string;
  };
  workspaceId?: string;
  workspacePath?: string;
  budgetUsd?: number;
  readiness: DayPlanExecutionReadiness;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  pid?: number;
  heartbeatAt?: string;
  resultSummary?: DayPlanExecutionResultSummary;
  exitCode?: number;
  errorCode?: string;
};

export type DayPlanExecutionResultSummary = {
  kind: "plan" | "execution";
  text: string;
  durationMs?: number;
  totalCostUsd?: number;
};

export type DayPlanExecutionWorkspaceMetadata = {
  id: string;
  maximumBudgetUsd: number;
};

export type DayPlanUnreadyItem = {
  itemId: string;
  taskId: string;
  title: string;
  readiness: DayPlanExecutionReadiness;
};

export type DayPlanKickoffSkip = {
  itemId: string;
  taskId: string;
  title: string;
  reason: "not_ready" | "already_live" | "result_available";
  status?: DayPlanExecutionRunStatus;
  readiness?: DayPlanExecutionReadiness;
};

export type ConfigureDayPlanExecutionInput = {
  planId: string;
  itemId: string;
  expectedVersion: number;
  mutationId: string;
  mode: DayPlanExecutionMode;
  modelAlias: DayPlanModelAlias;
  workspaceId?: string;
  budgetUsd?: number;
};

export type DayPlanExecutionConfigResult = {
  config: DayPlanExecutionConfig;
  readiness: DayPlanExecutionReadiness;
  replayed: boolean;
};

export type KickoffDayPlanItemInput = {
  planId: string;
  itemId: string;
  expectedVersion: number;
  mutationId: string;
};

export type KickoffDayPlanItemResult = {
  plan: DayPlan;
  run?: DayPlanExecutionRun;
  readiness: DayPlanExecutionReadiness;
  worker?: {
    queued: true;
    workerAvailable: boolean;
    lane: "execution";
  };
  replayed: boolean;
};
