import { NextRequest, NextResponse } from "next/server";
import { agentProviderStatus, readAgentSettings, setPrimaryAgent } from "@/lib/agent-settings.mjs";
import { hasDayPlanRouteAccess } from "@/lib/request-security";
import { getQuietCurrentCsrfToken } from "@/lib/quiet-current/store";
import { getRuntimeMode } from "@/lib/runtime/mode";

function access(request: NextRequest, mutate = false) {
  if (!hasDayPlanRouteAccess(request)) return NextResponse.json({ error: "Untrusted request host." }, { status: 403 });
  if (getRuntimeMode() !== "local") return NextResponse.json({ error: "Available only in local Cove." }, { status: 404 });
  if (mutate && request.headers.get("x-cove-csrf") !== getQuietCurrentCsrfToken()) {
    return NextResponse.json({ error: "Cove request token is missing." }, { status: 403 });
  }
}

export async function GET(request: NextRequest) {
  const denied = access(request);
  if (denied) return denied;
  return NextResponse.json(agentProviderStatus(readAgentSettings()));
}

export async function PATCH(request: NextRequest) {
  const denied = access(request, true);
  if (denied) return denied;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 1024) throw new Error("Provider request is too large.");
    const body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).some(key => key !== "provider") || !["claude", "codex"].includes(body.provider)) {
      throw new Error("Choose Claude or Codex as the primary provider.");
    }
    if (!readAgentSettings()) throw new Error("Finish Cove provider setup first.");
    const settings = setPrimaryAgent(body.provider);
    return NextResponse.json({ ...agentProviderStatus(settings), summary: `Primary Cove agent changed to ${body.provider === "claude" ? "Claude" : "Codex"}. New tasks and the next chief-of-staff and Buddy turns use this provider. Existing task sessions stay with their original provider.` });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Cove could not change its primary provider." }, { status: 400 });
  }
}
