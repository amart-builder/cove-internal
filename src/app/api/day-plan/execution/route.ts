import { NextRequest, NextResponse } from "next/server";
import {
  currentDayPlanAccessMode,
  hasDayPlanRouteAccess,
} from "@/lib/request-security";
import {
  DayPlanInvalidTransition,
  DayPlanNotFound,
  DayPlanVersionConflict,
  getDayPlanStore,
} from "@/lib/day-plan/store";
import {
  publicDayPlan,
  publicExecutionReadiness,
  publicExecutionRun,
} from "@/lib/day-plan/public-execution";
import type {
  DayPlanExecutionMode,
  DayPlanModelAlias,
} from "@/lib/day-plan/types";
import { getQuietCurrentCsrfToken } from "@/lib/quiet-current/store";
import {
  isClaudeWorkerAvailable,
  triggerOneShotWorker,
} from "@/lib/claude-execution/trigger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;
const MUTATION_ID = /^[A-Za-z0-9:_-]+$/;
const MODES = new Set<DayPlanExecutionMode>(["plan_review", "autonomous"]);
const MODELS = new Set<DayPlanModelAlias>(["sonnet", "opus", "fable"]);

function text(value: unknown, name: string, maximum: number, required = true): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`${name} is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`${name} must be text.`);
  const result = value.trim();
  if (required && !result) throw new Error(`${name} is required.`);
  if (result.length > maximum) throw new Error(`${name} is too long.`);
  return result || undefined;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value as number;
}

export function parseExecutionPostBody(value: unknown):
  | { action: "cancel"; runId: string }
  | { action: "kickoff"; input: Parameters<ReturnType<typeof getDayPlanStore>["kickoffItem"]>[0] }
  | { action: "configure"; input: Parameters<ReturnType<typeof getDayPlanStore>["configureExecution"]>[0] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be an object.");
  }
  const body = value as Record<string, unknown>;
  const action = text(body.action, "action", 40)!;
  if (action === "cancel") {
    return { action, runId: text(body.runId, "runId", 200)! };
  }
  const planId = text(body.planId, "planId", 200)!;
  const itemId = text(body.itemId, "itemId", 240)!;
  const mutationId = text(body.mutationId, "mutationId", 240)!;
  if (!MUTATION_ID.test(mutationId)) throw new Error("mutationId has an invalid format.");
  const expectedVersion = positiveInteger(body.expectedVersion, "expectedVersion");
  if (action === "kickoff") {
    return { action, input: { planId, itemId, mutationId, expectedVersion } };
  }
  if (action !== "configure") throw new Error("Unknown execution action.");
  const mode = text(body.mode, "mode", 30)! as DayPlanExecutionMode;
  const modelAlias = text(body.modelAlias, "modelAlias", 30)! as DayPlanModelAlias;
  if (!MODES.has(mode)) throw new Error("Unknown execution mode.");
  if (!MODELS.has(modelAlias)) throw new Error("Unknown Claude model.");
  const budgetUsd = body.budgetUsd === undefined ? undefined : Number(body.budgetUsd);
  if (budgetUsd !== undefined && (!Number.isFinite(budgetUsd) || budgetUsd <= 0)) {
    throw new Error("budgetUsd must be a positive number.");
  }
  return {
    action,
    input: {
      planId,
      itemId,
      expectedVersion,
      mutationId,
      mode,
      modelAlias,
      workspaceId: text(body.workspaceId, "workspaceId", 120, false),
      budgetUsd,
    },
  };
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof DayPlanVersionConflict) {
    return NextResponse.json(
      {
        error: "version_conflict",
        currentPlan: publicDayPlan(error.currentPlan, currentDayPlanAccessMode()),
      },
      { status: 409 },
    );
  }
  if (error instanceof DayPlanNotFound) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof DayPlanInvalidTransition || error instanceof SyntaxError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "Execution request failed." },
    { status: 400 },
  );
}

export async function GET(request: NextRequest) {
  if (!hasDayPlanRouteAccess(request)) {
    return NextResponse.json({ error: "Untrusted request host." }, { status: 403 });
  }
  try {
    const planId = text(request.nextUrl.searchParams.get("planId"), "planId", 200)!;
    const store = getDayPlanStore();
    const plan = store.getPlan(planId);
    if (!plan) throw new DayPlanNotFound();
    const accessMode = currentDayPlanAccessMode();
    return NextResponse.json({
      items: plan.items.map((item) => ({
        itemId: item.id,
        config: store.getExecutionConfig(plan.id, item.id),
        readiness: publicExecutionReadiness(
          store.getExecutionReadiness(plan.id, item.id),
        ),
      })),
      runs: store.listExecutionRuns(plan.id).map((run) =>
        publicExecutionRun(run, accessMode),
      ),
      workspaces: store.listExecutionWorkspaces(),
      workerAvailable: isClaudeWorkerAvailable(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  if (!hasDayPlanRouteAccess(request)) {
    return NextResponse.json({ error: "Untrusted request host." }, { status: 403 });
  }
  if (request.headers.get("x-forge-csrf") !== getQuietCurrentCsrfToken()) {
    return NextResponse.json({ error: "Forge request token is missing." }, { status: 403 });
  }
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Execution request is too large." }, { status: 413 });
    }
    const parsed = parseExecutionPostBody(JSON.parse(raw) as unknown);
    const store = getDayPlanStore();
    const accessMode = currentDayPlanAccessMode();
    if (parsed.action === "cancel") {
      return NextResponse.json({
        run: publicExecutionRun(store.cancelExecutionRun(parsed.runId), accessMode),
      });
    }
    if (parsed.action === "configure") {
      const result = store.configureExecution(parsed.input);
      return NextResponse.json({
        ...result,
        readiness: publicExecutionReadiness(result.readiness),
      });
    }
    const result = store.kickoffItem(parsed.input);
    const worker = result.run?.status === "queued"
      ? triggerOneShotWorker("execution")
      : undefined;
    return NextResponse.json({
      ...result,
      plan: publicDayPlan(result.plan, accessMode),
      run: result.run ? publicExecutionRun(result.run, accessMode) : undefined,
      readiness: publicExecutionReadiness(result.readiness),
      worker,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
