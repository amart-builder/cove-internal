import { createHash } from "node:crypto";
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
import {
  assistantCreateItemIntakeText,
  validateAssistantProposal,
} from "@/lib/day-plan/assistant-patch";
import type { InboundEvent } from "@/lib/data/types";
import { recordEvent, resolveEvent } from "@/lib/intake/inbox";
import { createCapturedInboundTask } from "@/lib/intake/task-writer";
import { operatorName } from "@/lib/operator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_BODY_BYTES = 24 * 1024;
class AssistantApplyRequestError extends Error {}

export function deterministicCreateId(
  planId: string,
  expectedVersion: number,
  clientId: string,
): string {
  const bytes = createHash("sha256")
    .update(`${planId}\0${expectedVersion}\0${clientId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

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

function errorReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500) || "assistant_apply_failed";
}

async function dismissCapturedEvent(
  event: InboundEvent,
  reason: string,
): Promise<void> {
  if (event.spooled === true) {
    await recordEvent({
      id: event.id,
      source: event.source,
      sourceId: event.source_id,
      rawText: event.raw_text,
      machine: event.machine ?? undefined,
      createdAt: event.created_at,
      state: "dismissed",
    });
    return;
  }
  await resolveEvent(event.id, { state: "dismissed", error: reason });
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
  const captured: Array<{
    event: InboundEvent;
    operation: Extract<DayPlanAssistantOperation, { operation: "create_item" }>;
  }> = [];
  let applied = false;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Assistant apply request is too large." }, { status: 413 });
    }
    const input = parseAssistantApplyBody(JSON.parse(raw) as unknown);
    const store = getDayPlanStore();
    const currentPlan = store.getReadModel().currentPlan;
    if (!currentPlan || currentPlan.version !== input.expectedVersion) {
      store.applyAssistantOperations(input);
      throw new Error("Assistant apply did not return a result.");
    }
    if (
      currentPlan.state !== "proposed" ||
      currentPlan.arrivalState !== "opened"
    ) {
      throw new DayPlanInvalidTransition(
        "Arrival items can change only while arrival is open.",
      );
    }
    validateAssistantProposal(currentPlan, {
      assistantText: "Buddy updated the day plan.",
      needsClarification: false,
      operations: input.operations,
    });
    const createOperations = input.operations.filter(
      (operation): operation is Extract<DayPlanAssistantOperation, {
        operation: "create_item";
      }> => operation.operation === "create_item",
    );
    const createdItemIds = createOperations.map((operation) =>
      deterministicCreateId(
        currentPlan.id,
        input.expectedVersion,
        operation.clientId,
      )
    );
    const captureResults = await Promise.all(createOperations.map(async (operation, index) => {
      const id = createdItemIds[index];
      const capture = await recordEvent({
        id,
        source: "day-plan",
        sourceId:
          `assistant:${currentPlan.id}:${input.expectedVersion}:${operation.clientId}`,
        rawText: assistantCreateItemIntakeText(operation),
      });
      return { event: capture.event, operation };
    }));
    captured.push(...captureResults.filter(({ event }) => event.spooled !== false));
    if (captureResults.some(({ event }) => event.spooled === false)) {
      throw new Error("Assistant create item could not reach the intake inbox.");
    }
    const result = store.applyAssistantOperations({
      ...input,
      createdItemIds,
    });
    applied = true;
    await Promise.all(captured.map(async ({ event, operation }) => {
      await createCapturedInboundTask(event, {
        title: operation.title.trim(),
        description: `${assistantCreateItemIntakeText(operation)}\n\nArrived via day-plan and needs triage.`,
        project: operation.project?.trim() || "Atlas",
        priority: operation.priority ?? "medium",
        column: "Must happen today",
      });
    }));
    await Promise.all(captured.map(async ({ event }) => {
      if (event.spooled === true) return;
      try {
        await resolveEvent(event.id, {
          state: "triaged",
          taskId: event.id,
        });
      } catch (error) {
        console.error("Assistant task exists but its intake receipt remains pending.", error);
      }
    }));
    return NextResponse.json({
      plan: publicDayPlan(result.plan, currentDayPlanAccessMode()),
      changes: operationChanges(result.plan, input.operations, result.createdItemIds),
    });
  } catch (error) {
    if (!applied && captured.length > 0) {
      const reason = errorReason(error);
      await Promise.allSettled(
        captured.map(({ event }) => dismissCapturedEvent(event, reason)),
      );
    }
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
