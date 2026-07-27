import { NextRequest, NextResponse } from "next/server";
import { currentDayPlanAccessMode, hasDayPlanRouteAccess } from "@/lib/request-security";
import { getQuietCurrentCsrfToken } from "@/lib/quiet-current/store";
import { publicDayPlan } from "@/lib/day-plan/public-execution";
import {
  DayPlanInvalidTransition,
  DayPlanNotFound,
  DayPlanVersionConflict,
  getDayPlanStore,
} from "@/lib/day-plan/store";
import type { DayPlan, DayPlanAssistantOperation } from "@/lib/day-plan/types";
import { operatorName } from "@/lib/operator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_BODY_BYTES = 24 * 1024;
class AssistantApplyRequestError extends Error {}

export function parseAssistantApplyBody(value: unknown): {
  expectedVersion: number;
  operations: DayPlanAssistantOperation[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AssistantApplyRequestError("request body must be an object.");
  }
  const body = value as Record<string, unknown>;
  if (!Number.isInteger(body.expectedVersion) || (body.expectedVersion as number) < 1) {
    throw new AssistantApplyRequestError("expectedVersion must be a positive integer.");
  }
  if (!Array.isArray(body.operations) || body.operations.length === 0 || body.operations.length > 12) {
    throw new AssistantApplyRequestError("operations must contain between one and twelve operations.");
  }
  return {
    expectedVersion: body.expectedVersion as number,
    operations: body.operations as DayPlanAssistantOperation[],
  };
}

function operationChanges(
  plan: DayPlan,
  operations: DayPlanAssistantOperation[],
  createdItemIds: string[],
) {
  let createdIndex = 0;
  return operations.map((operation) => {
    if (operation.operation === "create_item") {
      const id = createdItemIds[createdIndex++] ?? operation.clientId;
      return { table: "day_plan", action: "insert", id, summary: `Added '${operation.title}' to today` };
    }
    if (operation.operation === "reorder") {
      return { table: "day_plan", action: "update", id: plan.id, summary: "Reordered today's priorities" };
    }
    const item = plan.items.find((candidate) => candidate.id === operation.itemId);
    const label = item?.title ?? "day-plan item";
    if (operation.operation === "complete_item") {
      return { table: "day_plan", action: "update", id: operation.itemId, summary: `Completed '${label}'` };
    }
    if (operation.operation === "set_owner") {
      const owner = operation.owner === "me" ? operatorName() : operation.owner === "claude" ? "Claude" : "Together";
      return { table: "day_plan", action: "update", id: operation.itemId, summary: `Assigned '${label}' to ${owner}` };
    }
    return { table: "day_plan", action: "update", id: operation.itemId, summary: `Updated '${label}'` };
  });
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
      return NextResponse.json({ error: "Assistant apply request is too large." }, { status: 413 });
    }
    const input = parseAssistantApplyBody(JSON.parse(raw) as unknown);
    const result = getDayPlanStore().applyAssistantOperations(input);
    return NextResponse.json({
      plan: publicDayPlan(result.plan, currentDayPlanAccessMode()),
      changes: operationChanges(result.plan, input.operations, result.createdItemIds),
    });
  } catch (error) {
    if (error instanceof DayPlanVersionConflict) {
      return NextResponse.json({
        error: "version_conflict",
        currentPlan: publicDayPlan(error.currentPlan, currentDayPlanAccessMode()),
      }, { status: 409 });
    }
    if (error instanceof DayPlanNotFound) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof AssistantApplyRequestError ||
      error instanceof DayPlanInvalidTransition || error instanceof SyntaxError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Buddy day-plan apply failed.", error);
    return NextResponse.json({ error: "Assistant apply failed." }, { status: 500 });
  }
}
