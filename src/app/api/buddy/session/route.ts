import os from "node:os";
import { NextRequest, NextResponse } from "next/server";
import { hasDayPlanRouteAccess } from "@/lib/request-security";
import { getQuietCurrentCsrfToken } from "@/lib/quiet-current/store";
import { BUDDY_STALE_TURN_MS, getBuddyStore } from "@/lib/buddy/store";
import type { BuddyStore, BuddyState } from "@/lib/buddy/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export { BUDDY_STALE_TURN_MS } from "@/lib/buddy/store";

export function prepareBuddySessionReset(store: BuddyStore): BuddyState | null {
  store.sweepStaleTurns(BUDDY_STALE_TURN_MS);
  return store.resetBuddySession();
}

function sessionPayload() {
  const state = getBuddyStore().getBuddyState();
  return {
    headSessionId: state.headSessionId,
    turnCount: state.turnCount,
    totalCostUsd: state.totalCostUsd,
    createdAt: state.createdAt,
    hostname: os.hostname(),
    deepLinksEnabled: process.env.FORGE_BUDDY_DEEPLINKS !== "0",
  };
}

export async function GET(request: NextRequest) {
  if (!hasDayPlanRouteAccess(request)) {
    return NextResponse.json({ error: "Untrusted request host." }, { status: 403 });
  }
  return NextResponse.json(sessionPayload());
}

export async function POST(request: NextRequest) {
  if (!hasDayPlanRouteAccess(request)) {
    return NextResponse.json({ error: "Untrusted request host." }, { status: 403 });
  }
  if (request.headers.get("x-forge-csrf") !== getQuietCurrentCsrfToken()) {
    return NextResponse.json({ error: "Forge request token is missing." }, { status: 403 });
  }
  try {
    const body = await request.json() as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body) ||
      (body as Record<string, unknown>).action !== "reset") {
      return NextResponse.json({ error: "Unknown Buddy session action." }, { status: 400 });
    }
    const store = getBuddyStore();
    const reset = prepareBuddySessionReset(store);
    if (!reset) {
      return NextResponse.json(
        { error: "Buddy is already working on a turn." },
        { status: 409 },
      );
    }
    return NextResponse.json(sessionPayload());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Buddy session failed." },
      { status: 400 },
    );
  }
}
