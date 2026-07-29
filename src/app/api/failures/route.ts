import { NextRequest, NextResponse } from "next/server";
import { dismissFailure, listFailures } from "@/lib/reliability/failures";
import { getQuietCurrentCsrfToken } from "@/lib/quiet-current/store";
import { isTrustedForgeRequest } from "@/lib/request-security";
import { getRuntimeMode } from "@/lib/runtime/mode";
import { listRecentReceiptActivity } from "@/lib/reliability/receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function parseFailureDismissBody(value: unknown): { id: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A failure id is required.");
  }
  const id = (value as Record<string, unknown>).id;
  if (typeof id !== "string" || !id.trim() || id.length > 200) {
    throw new Error("A valid failure id is required.");
  }
  return { id: id.trim() };
}

export async function GET(request: NextRequest) {
  if (!isTrustedForgeRequest(request)) {
    return NextResponse.json({ error: "Untrusted request host." }, { status: 403 });
  }
  const receiptLimit = Math.max(
    1,
    Math.min(30, Number.parseInt(request.nextUrl.searchParams.get("receiptLimit") ?? "15", 10) || 15),
  );
  const cursorFinishedAt = request.nextUrl.searchParams.get("receiptCursorFinishedAt")?.trim();
  const cursorId = request.nextUrl.searchParams.get("receiptCursorId")?.trim();
  const receiptCursor = cursorFinishedAt && cursorId &&
    cursorFinishedAt.length <= 64 && cursorId.length <= 200
    ? { finishedAt: cursorFinishedAt, id: cursorId }
    : undefined;
  const activity = getRuntimeMode() === "local"
    ? listRecentReceiptActivity({ limit: receiptLimit, cursor: receiptCursor })
    : undefined;
  return NextResponse.json({
    failures: listFailures(),
    ...(activity
      ? {
          activity: activity.activities,
          activityHasMore: activity.hasMore,
          activityNextCursor: activity.nextCursor,
        }
      : {}),
    csrfToken: getQuietCurrentCsrfToken(),
  });
}

export async function POST(request: NextRequest) {
  if (!isTrustedForgeRequest(request)) {
    return NextResponse.json({ error: "Untrusted request host." }, { status: 403 });
  }
  if (request.headers.get("x-forge-csrf") !== getQuietCurrentCsrfToken()) {
    return NextResponse.json(
      { error: "Cove request token is missing." },
      { status: 403 },
    );
  }
  try {
    const { id } = parseFailureDismissBody(await request.json());
    if (!dismissFailure(id)) {
      return NextResponse.json(
        { error: "Failure was not found or was already dismissed." },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Dismiss failed." },
      { status: 400 },
    );
  }
}
