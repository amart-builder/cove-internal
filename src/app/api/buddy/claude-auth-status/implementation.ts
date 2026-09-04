import { NextRequest, NextResponse } from "next/server";
import { probeClaudeAuthStatus } from "@/lib/buddy/claude-login";
import { hasDayPlanRouteAccess } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AuthStatusRouteDependencies = Parameters<typeof probeClaudeAuthStatus>[0];

export async function handleClaudeAuthStatusGet(
  request: NextRequest,
  dependencies: AuthStatusRouteDependencies = {},
) {
  if (!hasDayPlanRouteAccess(request)) {
    return NextResponse.json({ error: "Untrusted request host." }, { status: 403 });
  }
  const status = await probeClaudeAuthStatus(dependencies);
  return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
}

export function GET(request: NextRequest) {
  return handleClaudeAuthStatusGet(request);
}
