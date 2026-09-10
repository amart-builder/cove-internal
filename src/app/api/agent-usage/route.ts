import { NextRequest, NextResponse } from "next/server";
import { readAgentSettings } from "@/lib/agent-settings.mjs";
import { readBackgroundUsage } from "@/lib/background-usage.mjs";
import { isTrustedCoveRequest } from "@/lib/request-security";
import { getRuntimeMode } from "@/lib/runtime/mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isTrustedCoveRequest(request)) return NextResponse.json({ error: "Untrusted request host." }, { status: 403 });
  if (getRuntimeMode() !== "local") return NextResponse.json({ enabled: false });
  try {
    const settings = readAgentSettings();
    return NextResponse.json(settings ? { enabled: true, settings, usage: readBackgroundUsage(process.env, Date.now(), settings) } : { enabled: false });
  } catch {
    return NextResponse.json({ error: "Cove could not read its model settings or usage. Ask your setup agent to check them before restarting background work." }, { status: 503 });
  }
}
