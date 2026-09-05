import { NextRequest, NextResponse } from "next/server";
import { openClaudeLoginInTerminal } from "@/lib/buddy/claude-login";
import { getQuietCurrentCsrfToken } from "@/lib/quiet-current/store";
import { hasDayPlanRouteAccess } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LoginRouteDependencies = Parameters<typeof openClaudeLoginInTerminal>[0];

function denied(request: NextRequest): NextResponse | undefined {
  if (!hasDayPlanRouteAccess(request)) {
    return NextResponse.json({ ok: false, error: "Untrusted request host." }, { status: 403 });
  }
  if (request.headers.get("x-cove-csrf") !== getQuietCurrentCsrfToken()) {
    return NextResponse.json({ ok: false, error: "Cove request token is missing." }, { status: 403 });
  }
}

export async function handleClaudeLoginPost(
  request: NextRequest,
  dependencies: LoginRouteDependencies = {},
) {
  const accessError = denied(request);
  if (accessError) return accessError;
  const result = openClaudeLoginInTerminal(dependencies);
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

export function POST(request: NextRequest) {
  return handleClaudeLoginPost(request);
}
