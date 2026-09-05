import { NextRequest, NextResponse } from "next/server";
import { hasDayPlanRouteAccess } from "@/lib/request-security";
import { getQuietCurrentCsrfToken } from "@/lib/quiet-current/store";
import { openCodexLogin, probeCodexAuthStatus } from "@/lib/buddy/codex-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!hasDayPlanRouteAccess(request)) return NextResponse.json({ error: "Untrusted request host." }, { status: 403 });
  return NextResponse.json(await probeCodexAuthStatus());
}

export async function POST(request: NextRequest) {
  if (!hasDayPlanRouteAccess(request) || request.headers.get("x-cove-csrf") !== getQuietCurrentCsrfToken()) return NextResponse.json({ error: "Cove request token is missing or request is untrusted." }, { status: 403 });
  try {
    await openCodexLogin();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not start Codex sign-in." }, { status: 500 });
  }
}
