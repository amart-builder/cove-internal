import type {
  DayPlan,
  DayPlanExecutionReadiness,
  DayPlanExecutionRun,
  DayPlanExecutionRunStatus,
  DayPlanKickoffSkip,
  DayPlanUnreadyItem,
} from "./types";
import { buildClaudeResumeCommand } from "../claude-execution/resume-command";

export type DayPlanExecutionAccessMode = "loopback" | "session";

// Morning Brief content (and anything derived from it) is loopback-only. The
// full blob is already gated, but item.brief annotations (whyToday,
// whatClaudeCanStart) and plan.briefId are persisted into the plan itself, so
// every response that carries a plan must strip them for non-loopback access:
// the main GET, mutation results, and 409 conflict payloads alike.
export function publicDayPlan(
  plan: DayPlan,
  accessMode: DayPlanExecutionAccessMode | undefined,
): DayPlan {
  if (accessMode === "loopback") return plan;
  const publicPlan = { ...plan };
  delete publicPlan.briefId;
  return {
    ...publicPlan,
    items: plan.items.map((item) => {
      const publicItem = { ...item };
      delete publicItem.brief;
      return publicItem;
    }),
  };
}

// A run's claudeSessionId is a resumable handle into a local Claude CLI session. It is
// only safe to expose when the request is loopback (same machine, not a remote session).
// The board can open a queued/running planning session as well as a ready result; remote
// sessions still never receive this resumable local handle.
export function includesClaudeSessionId(
  accessMode: DayPlanExecutionAccessMode | undefined,
  status: DayPlanExecutionRunStatus,
): boolean {
  return (
    accessMode === "loopback" &&
    [
      "queued",
      "starting",
      "running",
      "plan_ready",
      "ready_to_join",
      "awaiting_review",
    ].includes(status)
  );
}

export function publicExecutionReadiness(
  readiness: DayPlanExecutionReadiness,
): DayPlanExecutionReadiness {
  const publicReadiness = { ...readiness };
  delete publicReadiness.workspacePath;
  return publicReadiness;
}

export function publicExecutionRun(
  run: DayPlanExecutionRun,
  accessMode?: DayPlanExecutionAccessMode,
): DayPlanExecutionRun {
  const publicRun = { ...run };
  delete publicRun.workspacePath;
  delete publicRun.pid;
  if (includesClaudeSessionId(accessMode, run.status)) {
    publicRun.resumeCommand = buildClaudeResumeCommand(
      run.workspacePath ?? process.cwd(),
      run.claudeSessionId,
    );
  } else {
    delete (publicRun as Partial<DayPlanExecutionRun>).claudeSessionId;
    delete publicRun.resumeCommand;
  }
  return {
    ...publicRun,
    readiness: publicExecutionReadiness(run.readiness),
  };
}

export function publicUnreadyItem(item: DayPlanUnreadyItem): DayPlanUnreadyItem {
  return {
    ...item,
    readiness: publicExecutionReadiness(item.readiness),
  };
}

export function publicKickoffSkip(item: DayPlanKickoffSkip): DayPlanKickoffSkip {
  return item.readiness
    ? { ...item, readiness: publicExecutionReadiness(item.readiness) }
    : item;
}
