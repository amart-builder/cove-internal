import type {
  MorningBriefGeneration,
  MorningBriefSalesActionRecord,
  MorningBriefSalesActionState,
  PublicMorningBrief,
} from "../day-plan/brief";
import type {
  DayPlan,
  DayPlanExecutionConfig,
  DayPlanExecutionConfigResult,
  DayPlanExecutionReadiness,
  DayPlanExecutionRun,
  DayPlanExecutionWorkspaceMetadata,
  DayPlanMutationInput,
  DayPlanMutationResult,
  DayPlanReadModel,
  DayPlanReconciliationResult,
  DayPlanTaskMutationResult,
  EnsureDayPlanInput,
  KickoffDayPlanItemInput,
  KickoffDayPlanItemResult,
  ConfigureDayPlanExecutionInput,
} from "../day-plan/types";

export type DayPlanApiSnapshot = DayPlanReadModel & {
  csrfToken: string;
  // Present only on loopback requests, and only for the brief the current plan
  // consumed at ensure time.
  morningBrief?: PublicMorningBrief;
  // Brief generation/availability for the current plan's date. Loopback-only,
  // like morningBrief; absent on non-loopback and when there is no plan.
  briefGeneration?: MorningBriefGeneration;
};
export type DayPlanExecutionState = {
  items: Array<{
    itemId: string;
    config?: DayPlanExecutionConfig;
    readiness: DayPlanExecutionReadiness;
  }>;
  runs: DayPlanExecutionRun[];
  workspaces: DayPlanExecutionWorkspaceMetadata[];
  workerAvailable: boolean;
};
export type DayPlanExecutionRunState = Pick<
  DayPlanExecutionState,
  "runs" | "workerAvailable"
>;

export class DayPlanApiConflict extends Error {
  constructor(public readonly currentPlan: DayPlan) {
    super("The day plan changed. Cove refreshed the newest version.");
    this.name = "DayPlanApiConflict";
  }
}

let csrfToken: string | undefined;

export async function getDayPlanCsrfToken(): Promise<string> {
  if (!csrfToken) await getDayPlanState();
  return csrfToken!;
}

async function responsePayload(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

export async function getDayPlanState(): Promise<DayPlanApiSnapshot> {
  const response = await fetch("/api/day-plan", { cache: "no-store" });
  const payload = await responsePayload(response);
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string" ? payload.error : "Cove couldn't load the day plan.",
    );
  }
  const snapshot = payload as DayPlanApiSnapshot;
  csrfToken = snapshot.csrfToken;
  return snapshot;
}

async function postDayPlan<T = DayPlanMutationResult>(
  body: Record<string, unknown>,
): Promise<T> {
  if (!csrfToken) await getDayPlanState();
  const response = await fetch("/api/day-plan", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forge-CSRF": csrfToken!,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const payload = await responsePayload(response);
  if (response.status === 409 && payload.currentPlan) {
    throw new DayPlanApiConflict(payload.currentPlan as DayPlan);
  }
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string" ? payload.error : "Cove couldn't update the day plan.",
    );
  }
  return payload as T;
}

async function postProtected<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  if (!csrfToken) await getDayPlanState();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forge-CSRF": csrfToken!,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const payload = await responsePayload(response);
  if (response.status === 409 && payload.currentPlan) {
    throw new DayPlanApiConflict(payload.currentPlan as DayPlan);
  }
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string" ? payload.error : "Cove request failed.",
    );
  }
  return payload as T;
}

export function ensureDayPlan(input: EnsureDayPlanInput): Promise<DayPlanMutationResult> {
  return postDayPlan({ action: "ensure", ...input });
}

export function mutateDayPlan(
  input: DayPlanMutationInput,
): Promise<DayPlanMutationResult> {
  return postDayPlan(input);
}

// Durably records the first meaningful arrival interaction on the server so a
// late brief can never hot-swap after the user has touched the arrival. Never
// bumps the plan version; safe to call fire-and-forget.
export function markDayPlanArrivalInteraction(input: {
  planId: string;
  mutationId: string;
}): Promise<{ plan: DayPlan; replayed: boolean }> {
  return postDayPlan<{ plan: DayPlan; replayed: boolean }>({
    action: "arrival_interact",
    ...input,
  });
}

export function acknowledgeDayPlanReconciliation(
  reconciliationId: string,
): Promise<DayPlanReconciliationResult> {
  return postDayPlan<DayPlanReconciliationResult>({
    action: "reconciliation_applied",
    reconciliationId,
  });
}

export function acknowledgeDayPlanTaskMutation(
  mutationId: string,
): Promise<DayPlanTaskMutationResult> {
  return postDayPlan<DayPlanTaskMutationResult>({
    action: "task_mutation_applied",
    mutationId,
  });
}

// Marks a Morning Brief sales action approved, edited, or skipped. State only:
// nothing is ever sent on the user's behalf.
export function markMorningBriefSalesAction(input: {
  briefId: string;
  actionIndex: number;
  state: MorningBriefSalesActionState;
  editedText?: string;
}): Promise<{ states: MorningBriefSalesActionRecord[] }> {
  return postDayPlan<{ states: MorningBriefSalesActionRecord[] }>({
    action: "brief_action",
    ...input,
  });
}

// "Brief me anyway": the manual override on the closure gate. It queues a brief
// the gate is withholding, or attaches one that was already written but held
// back from the arrival, or does nothing when a generation is already running
// here or on the other machine. `attached` means the plan just consumed a brief
// and the caller should refetch.
export function forceMorningBrief(
  localDate: string,
): Promise<{ briefGeneration?: MorningBriefGeneration; attached?: boolean }> {
  return postDayPlan<{ briefGeneration?: MorningBriefGeneration; attached?: boolean }>({
    action: "brief_force",
    localDate,
  });
}

export function configureDayPlanExecution(
  input: ConfigureDayPlanExecutionInput,
): Promise<DayPlanExecutionConfigResult> {
  return postProtected("/api/day-plan/execution", { action: "configure", ...input });
}

export function kickoffDayPlanItem(
  input: KickoffDayPlanItemInput,
): Promise<KickoffDayPlanItemResult> {
  return postProtected("/api/day-plan/execution", { action: "kickoff", ...input });
}

export function cancelDayPlanExecutionRun(
  runId: string,
): Promise<{ run: DayPlanExecutionRun }> {
  return postProtected("/api/day-plan/execution", { action: "cancel", runId });
}

export async function getDayPlanExecutionState(
  planId: string,
): Promise<DayPlanExecutionState> {
  const response = await fetch(
    `/api/day-plan/execution?planId=${encodeURIComponent(planId)}`,
    { cache: "no-store" },
  );
  const payload = await responsePayload(response);
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string" ? payload.error : "Cove couldn't load Claude execution state.",
    );
  }
  return payload as DayPlanExecutionState;
}

export async function getDayPlanExecutionRunState(
  planId: string,
): Promise<DayPlanExecutionRunState> {
  const response = await fetch(
    `/api/day-plan/execution?planId=${encodeURIComponent(planId)}&statusOnly=1`,
    { cache: "no-store" },
  );
  const payload = await responsePayload(response);
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : "Cove couldn't load Claude run state.",
    );
  }
  return payload as DayPlanExecutionRunState;
}

export function newDayPlanMutationId(): string {
  return crypto.randomUUID();
}

export function onceOnlyDayPlanMutationId(
  action: "ensure" | "start-day" | "settlement-commit",
  stableId: string,
): string {
  return `${action}:${stableId}`;
}
