import { NextRequest, NextResponse } from "next/server";
import { getQuietCurrentCsrfToken } from "@/lib/quiet-current/store";
import { hasDayPlanRouteAccess } from "@/lib/request-security";
import { getRuntimeMode, type RuntimeMode } from "@/lib/runtime/mode";
import {
  getTaskSessionManager,
  type TaskSessionManager,
} from "@/lib/task-sessions/manager";
import type {
  LaunchTaskSessionInput,
  TaskSessionOwner,
  TaskSessionPromptSnapshot,
} from "@/lib/task-sessions/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 20 * 1024;

type RouteDependencies = {
  manager?: TaskSessionManager;
  runtimeMode?: RuntimeMode;
};

class TaskSessionRequestError extends Error {}

function requiredText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new TaskSessionRequestError(`${name} is invalid.`);
  }
  return value.trim();
}

function optionalText(value: unknown, name: string, maximum: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredText(value, name, maximum);
}

function promptSnapshot(value: unknown): TaskSessionPromptSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TaskSessionRequestError("promptSnapshot is invalid.");
  }
  const prompt = value as Record<string, unknown>;
  return {
    title: requiredText(prompt.title, "title", 240),
    detail: requiredText(prompt.detail, "detail", 12_000),
    outcome: optionalText(prompt.outcome, "outcome", 4_000),
    definitionOfDone: optionalText(
      prompt.definitionOfDone,
      "definitionOfDone",
      4_000,
    ),
    project: optionalText(prompt.project, "project", 300),
    dueAt: optionalText(prompt.dueAt, "dueAt", 100),
  };
}

function owner(value: unknown): TaskSessionOwner {
  if (value !== "claude" && value !== "together") {
    throw new TaskSessionRequestError("owner must be Claude or Together.");
  }
  return value;
}

function accessError(request: NextRequest, csrf: boolean): NextResponse | undefined {
  if (!hasDayPlanRouteAccess(request)) {
    return NextResponse.json({ error: "Untrusted request host." }, { status: 403 });
  }
  if (csrf && request.headers.get("x-cove-csrf") !== getQuietCurrentCsrfToken()) {
    return NextResponse.json({ error: "Cove request token is missing." }, { status: 403 });
  }
}

function localOnly(dependencies: RouteDependencies): NextResponse | undefined {
  if ((dependencies.runtimeMode ?? getRuntimeMode()) === "local") return undefined;
  return NextResponse.json({ enabled: false, runs: [] });
}

export async function handleTaskSessionRunsGet(
  request: NextRequest,
  dependencies: RouteDependencies = {},
) {
  const denied = accessError(request, false);
  if (denied) return denied;
  const unavailable = localOnly(dependencies);
  if (unavailable) return unavailable;
  const taskIds = request.nextUrl.searchParams
    .getAll("taskId")
    .map((value) => value.trim())
    .filter(Boolean);
  if (taskIds.length > 200 || taskIds.some((value) => value.length > 240)) {
    return NextResponse.json({ error: "Too many task ids." }, { status: 400 });
  }
  const manager = dependencies.manager ?? getTaskSessionManager();
  manager.reapOrphans();
  return NextResponse.json({
    enabled: true,
    runs: manager.listLatest(taskIds.length > 0 ? taskIds : undefined),
  });
}

export async function handleTaskSessionRunsPost(
  request: NextRequest,
  dependencies: RouteDependencies = {},
) {
  const denied = accessError(request, true);
  if (denied) return denied;
  const unavailable = localOnly(dependencies);
  if (unavailable) {
    return NextResponse.json(
      { error: "Task sessions are available only in local mode." },
      { status: 404 },
    );
  }
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      throw new TaskSessionRequestError("Task session request is too large.");
    }
    const body = JSON.parse(raw) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new TaskSessionRequestError("Task session request is invalid.");
    }
    const object = body as Record<string, unknown>;
    if (object.action !== "launch") {
      throw new TaskSessionRequestError("Unknown task session action.");
    }
    const input: LaunchTaskSessionInput = {
      taskId: requiredText(object.taskId, "taskId", 240),
      dayPlanId: optionalText(object.dayPlanId, "dayPlanId", 240),
      itemId: optionalText(object.itemId, "itemId", 240),
      owner: owner(object.owner),
      promptSnapshot: promptSnapshot(object.promptSnapshot),
    };
    const manager = dependencies.manager ?? getTaskSessionManager();
    return NextResponse.json({ run: manager.launch(input) }, { status: 201 });
  } catch (error) {
    if (!(error instanceof TaskSessionRequestError) && !(error instanceof SyntaxError)) {
      console.error("Task session launch failed.", error);
    }
    return NextResponse.json(
      {
        error: error instanceof Error
          ? error.message
          : "Could not start the Claude session.",
      },
      {
        status: error instanceof TaskSessionRequestError || error instanceof SyntaxError
          ? 400
          : 500,
      },
    );
  }
}

export function GET(request: NextRequest) {
  return handleTaskSessionRunsGet(request);
}

export function POST(request: NextRequest) {
  return handleTaskSessionRunsPost(request);
}
