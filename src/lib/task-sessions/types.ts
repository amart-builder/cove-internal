export type TaskSessionOwner = "claude" | "together";
export type TaskSessionPermissionMode = "acceptEdits" | "plan";
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
  project?: string;
  dueAt?: string;
};

export type TaskSessionRun = {
  id: string;
  taskId: string;
  dayPlanId?: string;
  itemId?: string;
  owner: TaskSessionOwner;
  permissionMode: TaskSessionPermissionMode;
  status: TaskSessionRunStatus;
  claudeSessionId?: string;
  outputDir: string;
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
