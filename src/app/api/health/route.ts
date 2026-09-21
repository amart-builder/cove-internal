import { NextRequest, NextResponse } from "next/server";
import { latestCoveHealthSnapshot } from "@/lib/health/collector";
import { localDatabasePath } from "@/lib/local/database";
import { currentCoveReadiness } from "@/lib/health/readiness";
import { isTrustedCoveRequest } from "@/lib/request-security";
import { getRuntimeMode } from "@/lib/runtime/mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isTrustedCoveRequest(request)) {
    return NextResponse.json({ error: "Untrusted request host." }, { status: 403 });
  }
  if (getRuntimeMode() !== "local") {
    return NextResponse.json(
      { error: "Health collection uses the local Cove runtime." },
      { status: 409 },
    );
  }
  try {
    return NextResponse.json({
      snapshot: latestCoveHealthSnapshot(),
      readiness: currentCoveReadiness(),
    });
  } catch (error) {
    // This is the one route a person -- or someone helping them from a distance
    // -- asks when Cove is misbehaving, and the state it most needs to describe
    // is a database it cannot read. Without this the screen says "some data
    // didn't refresh", which reads as a hiccup, and the route answers 500 with
    // an empty body, so nothing outside the log says otherwise.
    let dbPath: string | undefined;
    try { dbPath = localDatabasePath(); } catch { dbPath = undefined; }
    return NextResponse.json(
      {
        error: "Cove could not read its own state.",
        detail: error instanceof Error ? error.message : String(error),
        ...(dbPath ? { dbPath } : {}),
      },
      { status: 500 },
    );
  }
}
