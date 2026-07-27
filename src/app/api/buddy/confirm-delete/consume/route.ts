import { NextRequest, NextResponse } from "next/server";
import { BUDDY_DELETE_TABLES } from "@/lib/buddy/receipts";
import { getBuddyStore } from "@/lib/buddy/store";
import { isLoopbackForgeRequest } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isLoopbackForgeRequest(request)) {
    return NextResponse.json({ error: "Delete tokens can only be consumed from loopback." }, { status: 403 });
  }
  try {
    const body = await request.json() as Record<string, unknown>;
    if (typeof body.token !== "string" || typeof body.table !== "string" || typeof body.id !== "string" ||
      !(BUDDY_DELETE_TABLES as readonly string[]).includes(body.table)) {
      return NextResponse.json({ error: "token, table, and id are required." }, { status: 400 });
    }
    const result = getBuddyStore().consumePendingDelete({
      token: body.token,
      table: body.table,
      rowId: body.id,
    });
    if (!result.ok) {
      const status = result.error === "not_found" ? 404 : result.error === "mismatch" ? 409 : 410;
      return NextResponse.json({ error: result.error }, { status });
    }
    return NextResponse.json({ consumed: true, consumedAt: result.consumedAt });
  } catch {
    return NextResponse.json({ error: "Invalid delete confirmation request." }, { status: 400 });
  }
}
