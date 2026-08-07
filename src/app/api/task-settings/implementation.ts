import { NextRequest, NextResponse } from "next/server";
import { getQuietCurrentCsrfToken } from "@/lib/quiet-current/store";
import { hasDayPlanRouteAccess } from "@/lib/request-security";
import { getRuntimeMode, type RuntimeMode } from "@/lib/runtime/mode";
import {
  readTaskSettings,
  writeTaskSettings,
  type TaskSettings,
} from "@/lib/tasks/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4 * 1024;

type RouteDependencies = {
  runtimeMode?: RuntimeMode;
  readSettings?: () => TaskSettings;
  writeSettings?: (settings: TaskSettings) => TaskSettings;
};

class TaskSettingsRequestError extends Error {}

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
  return NextResponse.json({ enabled: false });
}

function focusCount(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 3) {
    throw new TaskSettingsRequestError("focus_count must be an integer from 1 to 3.");
  }
  return Number(value);
}

export async function handleTaskSettingsGet(
  request: NextRequest,
  dependencies: RouteDependencies = {},
) {
  const denied = accessError(request, false);
  if (denied) return denied;
  const unavailable = localOnly(dependencies);
  if (unavailable) return unavailable;
  const read = dependencies.readSettings ?? readTaskSettings;
  return NextResponse.json({ enabled: true, settings: read() });
}

export async function handleTaskSettingsPatch(
  request: NextRequest,
  dependencies: RouteDependencies = {},
) {
  const denied = accessError(request, true);
  if (denied) return denied;
  const unavailable = localOnly(dependencies);
  if (unavailable) {
    return NextResponse.json(
      { error: "Task settings are available only in local mode." },
      { status: 404 },
    );
  }
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      throw new TaskSettingsRequestError("Task settings request is too large.");
    }
    const body = JSON.parse(raw) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new TaskSettingsRequestError("Task settings request must be a JSON object.");
    }
    const patch = body as Record<string, unknown>;
    const unknownKeys = Object.keys(patch).filter((key) => key !== "focus_count");
    if (unknownKeys.length > 0 || !("focus_count" in patch)) {
      throw new TaskSettingsRequestError("Task settings patch is invalid.");
    }
    const read = dependencies.readSettings ?? readTaskSettings;
    const write = dependencies.writeSettings ?? writeTaskSettings;
    const settings = write({
      ...read(),
      focus_count: focusCount(patch.focus_count),
    });
    return NextResponse.json({ enabled: true, settings });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error
          ? error.message
          : "Task settings could not be updated.",
      },
      {
        status: error instanceof TaskSettingsRequestError || error instanceof SyntaxError
          ? 400
          : 500,
      },
    );
  }
}

export function GET(request: NextRequest) {
  return handleTaskSettingsGet(request);
}

export function PATCH(request: NextRequest) {
  return handleTaskSettingsPatch(request);
}
