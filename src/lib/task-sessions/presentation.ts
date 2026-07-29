import {
  TASK_SESSION_STATUS_LABELS,
  type TaskSessionRunStatus,
} from "./types";

export function taskSessionSettlementNote(
  status: TaskSessionRunStatus | undefined,
): string | undefined {
  if (status !== "running" && status !== "awaiting_approval") return undefined;
  return `Claude session: ${TASK_SESSION_STATUS_LABELS[status]}. Closing the day will not stop it.`;
}
