import { NextRequest, NextResponse } from "next/server";
import { latestCoveHealthSnapshot } from "@/lib/health/collector";
import { isTrustedForgeRequest } from "@/lib/request-security";
import { getRuntimeMode } from "@/lib/runtime/mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isTrustedForgeRequest(request)) {
    return NextResponse.json({ error: "Untrusted request host." }, { status: 403 });
  }
  if (getRuntimeMode() !== "local") {
    return NextResponse.json(
      { error: "Health collection uses the local Cove runtime." },
      { status: 409 },
    );
  }
  return NextResponse.json({ snapshot: latestCoveHealthSnapshot() });
}
