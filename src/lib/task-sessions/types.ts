export type TaskSessionProvider = "claude" | "codex";
export type TaskSessionOwner = "claude" | "together";
export type TaskSessionLaunchMode = "planning" | "auto";
export type TaskSessionPermissionMode = "acceptEdits" | "plan";
export type TaskSessionModel = `claude-${string}` | `gpt-${string}`;
export type TaskSessionEffort = "low" | "medium" | "high";
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
  provider?: "claude" | "codex";
  providerSessionId?: string;
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
  provider?: TaskSessionProvider;
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

export const TASK_SESSION_TIMEOUT_MS = 45 * 60 * 1000;
export const TASK_SESSION_STALE_ESCAPE_MS = 10 * 60 * 1000;
