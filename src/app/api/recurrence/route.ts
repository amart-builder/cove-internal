import { NextRequest, NextResponse } from "next/server";
import { getQuietCurrentCsrfToken } from "@/lib/quiet-current/store";
import {
  hasDayPlanRouteAccess,
  isTrustedCoveRequest,
} from "@/lib/request-security";
import { getRuntimeMode } from "@/lib/runtime/mode";
import {
  confirmTaskRecurrence,
  createRecurringTemplate,
  listRecurringTemplates,
  updateRecurringTemplate,
} from "@/lib/tasks/recurrence";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function text(
  value: unknown,
  name: string,
  options: { required?: boolean; max?: number } = {},
): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (options.required) throw new Error(`${name} is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`${name} must be text.`);
  const result = value.trim();
  if (!result && options.required) throw new Error(`${name} is required.`);
  if (result.length > (options.max ?? 4000)) {
    throw new Error(`${name} is too long.`);
  }
  return result;
}

function requireLocalRuntime(): void {
  if (getRuntimeMode() !== "local") {
    throw new Error("Recurring rhythms require Cove's local runtime.");
  }
}

export async function GET(request: NextRequest) {
  try {
    if (!isTrustedCoveRequest(request)) {
      return NextResponse.json({ error: "Untrusted request host." }, {
        status: 403,
      });
    }
    requireLocalRuntime();
    return NextResponse.json({ templates: listRecurringTemplates() });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Recurrence failed.",
    }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!hasDayPlanRouteAccess(request)) {
      return NextResponse.json({ error: "Recurrence access is not allowed." }, {
        status: 403,
      });
    }
    if (request.headers.get("x-cove-csrf") !== getQuietCurrentCsrfToken()) {
      return NextResponse.json({ error: "Cove request token is missing." }, {
        status: 403,
      });
    }
    requireLocalRuntime();
    const body = await request.json() as Record<string, unknown>;
    const action = text(body.action, "action", {
      required: true,
      max: 30,
    });
    if (action === "confirm") {
      return NextResponse.json(confirmTaskRecurrence({
        taskId: text(body.taskId, "taskId", { required: true, max: 200 })!,
        cadence: text(body.cadence, "cadence", { max: 40 }),
      }), { status: 201 });
    }
    if (action === "create") {
      return NextResponse.json(createRecurringTemplate({
        title: text(body.title, "title", { required: true, max: 240 })!,
        description: text(body.description, "description", { max: 4000 }),
        cadence: text(body.cadence, "cadence", {
          required: true,
          max: 40,
        })!,
      }), { status: 201 });
    }
    if (action === "update") {
      const pausedUntil = body.pausedUntil === null
        ? null
        : text(body.pausedUntil, "pausedUntil", { max: 10 });
      return NextResponse.json(updateRecurringTemplate({
        id: text(body.id, "id", { required: true, max: 200 })!,
        cadence: text(body.cadence, "cadence", { max: 40 }),
        ...(body.pausedUntil !== undefined ? { pausedUntil } : {}),
        ...(typeof body.active === "boolean" ? { active: body.active } : {}),
      }));
    }
    throw new Error("Unknown recurrence action.");
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Recurrence failed.",
    }, { status: 400 });
  }
}
