import { getDayPlanCsrfToken } from "./day-plan";
import { getRuntimeMode } from "../runtime/mode";
import type {
  LaunchTaskSessionInput,
  TaskSessionRun,
} from "../task-sessions/types";

type TaskSessionSnapshot = {
  enabled: boolean;
  runs: TaskSessionRun[];
};

type Listener = () => void;
const listeners = new Set<Listener>();

export const TASK_SESSION_POLL_INTERVAL_MS = 30_000;

export function subscribeTaskSessionChanges(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announceTaskSessionChange(): void {
  for (const listener of listeners) listener();
}

async function payload(response: Response): Promise<Record<string, unknown>> {
  return await response.json().catch(() => ({})) as Record<string, unknown>;
}

export async function listTaskSessionRuns(
  taskIds: readonly string[] = [],
): Promise<TaskSessionSnapshot> {
  if (getRuntimeMode() !== "local") return { enabled: false, runs: [] };
  const query = new URLSearchParams();
  for (const taskId of taskIds.slice(0, 200)) query.append("taskId", taskId);
  const response = await fetch(
    `/api/task-session-runs${query.size > 0 ? `?${query}` : ""}`,
    { cache: "no-store" },
  );
  const body = await payload(response);
  if (!response.ok) {
    throw new Error(
      typeof body.error === "string"
        ? body.error
        : "Cove couldn't load Claude session runs.",
    );
  }
  return body as TaskSessionSnapshot;
}

export async function launchTaskSessionRun(
  input: LaunchTaskSessionInput,
): Promise<TaskSessionRun> {
  if (getRuntimeMode() !== "local") {
    throw new Error("Task sessions are available only in local mode.");
  }
  const response = await fetch("/api/task-session-runs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cove-CSRF": await getDayPlanCsrfToken(),
    },
    body: JSON.stringify({ action: "launch", ...input }),
    cache: "no-store",
  });
  const body = await payload(response);
  if (!response.ok) {
    throw new Error(
      typeof body.error === "string"
        ? body.error
        : "Cove couldn't start the Claude session.",
    );
  }
  announceTaskSessionChange();
  return body.run as TaskSessionRun;
}

export async function abandonTaskSessionRun(runId: string): Promise<TaskSessionRun> {
  if (getRuntimeMode() !== "local") {
    throw new Error("Task sessions are available only in local mode.");
  }
  const response = await fetch("/api/task-session-runs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cove-CSRF": await getDayPlanCsrfToken(),
    },
    body: JSON.stringify({ action: "abandon", runId }),
    cache: "no-store",
  });
  const body = await payload(response);
  if (!response.ok) {
    throw new Error(
      typeof body.error === "string"
        ? body.error
        : "Cove couldn't stop the Claude session.",
    );
  }
  announceTaskSessionChange();
  return body.run as TaskSessionRun;
}
