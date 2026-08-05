import { getRuntimeMode } from "../runtime/mode";
import type { TaskSettings } from "../tasks/settings";
import { getDayPlanCsrfToken } from "./day-plan";

type TaskSettingsSnapshot = {
  enabled: boolean;
  settings?: TaskSettings;
  error?: string;
};

async function payload(response: Response): Promise<TaskSettingsSnapshot> {
  return await response.json().catch(() => ({})) as TaskSettingsSnapshot;
}

export async function getTaskSettings(): Promise<TaskSettings> {
  if (getRuntimeMode() !== "local") {
    throw new Error("Task settings are available only in local mode.");
  }
  const response = await fetch("/api/task-settings", { cache: "no-store" });
  const body = await payload(response);
  if (!response.ok || !body.settings) {
    throw new Error(body.error ?? "Cove couldn't load task settings.");
  }
  return body.settings;
}

export async function updateTaskSettings(
  patch: Pick<TaskSettings, "focus_count">,
): Promise<TaskSettings> {
  if (getRuntimeMode() !== "local") {
    throw new Error("Task settings are available only in local mode.");
  }
  const response = await fetch("/api/task-settings", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-Cove-CSRF": await getDayPlanCsrfToken(),
    },
    body: JSON.stringify(patch),
    cache: "no-store",
  });
  const body = await payload(response);
  if (!response.ok || !body.settings) {
    throw new Error(body.error ?? "Cove couldn't update task settings.");
  }
  return body.settings;
}
