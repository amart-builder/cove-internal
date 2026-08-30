export type TaskSessionOwner = "claude" | "together";
export type TaskSessionLaunchMode = "planning" | "auto";
export type TaskSessionPermissionMode = "acceptEdits" | "plan";
export type TaskSessionModel =
  | "claude-opus-5"
  | "claude-sonnet-5"
  | "claude-haiku-4-5";
export type TaskSessionEffort = "medium" | "high";
export type TaskSessionRunStatus =
  | "running"
  | "awaiting_approval"
  | "failed"
  | "output_ready"
  | "abandoned";

export type TaskSessionPromptSnapshot = {
  title: string;
  detail: string;
  outcome?: string;
  definitionOfDone?: string;
  whyToday?: string;
  project?: string;
  dueAt?: string;
  brief?: string;
};

export type TaskSessionRun = {
  id: string;
  taskId: string;
  dayPlanId?: string;
  itemId?: string;
  owner: TaskSessionOwner;
  permissionMode: TaskSessionPermissionMode;
  model: TaskSessionModel;
  effort: TaskSessionEffort;
  modelReason: string;
  status: TaskSessionRunStatus;
  claudeSessionId?: string;
  outputDir: string;
  workspacePath?: string;
  resumeUrl: string;
  resumeCommand?: string;
  promptSnapshot: TaskSessionPromptSnapshot;
  resultSummary?: string;
  hint?: string;
  errorCode?: string;
  exitCode?: number;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
};

export type LaunchTaskSessionInput = {
  taskId: string;
  dayPlanId?: string;
  itemId?: string;
  owner: TaskSessionOwner;
  mode?: TaskSessionLaunchMode;
  promptSnapshot: TaskSessionPromptSnapshot;
};

export const TASK_SESSION_STATUS_LABELS: Record<TaskSessionRunStatus, string> = {
  running: "running",
  awaiting_approval: "awaiting approval",
  failed: "failed",
  output_ready: "output ready",
  abandoned: "abandoned",
};

export const ACTIVE_TASK_SESSION_STATUSES = new Set<TaskSessionRunStatus>([
  "running",
  "awaiting_approval",
]);
