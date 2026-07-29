import { NextRequest, NextResponse } from "next/server";
import { BUDDY_DELETE_TABLES, normalizeBuddyReceipts } from "@/lib/buddy/receipts";
import { getBuddyStore } from "@/lib/buddy/store";
import { getQuietCurrentCsrfToken } from "@/lib/quiet-current/store";
import { hasDayPlanRouteAccess } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function denied(request: NextRequest): NextResponse | undefined {
  if (!hasDayPlanRouteAccess(request)) {
    return NextResponse.json({ error: "Untrusted request host." }, { status: 403 });
  }
  if (request.headers.get("x-cove-csrf") !== getQuietCurrentCsrfToken()) {
    return NextResponse.json({ error: "Cove request token is missing." }, { status: 403 });
  }
}

function requiredText(value: unknown, name: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${name} is invalid.`);
  }
  return value.trim();
}

/**
 * Locate the still-open pending delete that a request claims to be acting on.
 *
 * This is the whole delete gate. A permanent delete is supposed to be possible
 * only because Buddy declared the row in its turn receipts, the UI rendered a
 * confirmation card for it, and the operator tapped Confirm. Nothing downstream
 * can re-check that: by the time the token reaches the consume endpoint it is
 * just a valid token. So the binding to a real, on-screen, undisposed card has
 * to happen here, at mint time, or the card is decoration.
 */
function findOpenPendingDelete(turnId: string, table: string, id: string) {
  const store = getBuddyStore();
  const turn = store.getTurn(turnId);
  const receipts = turn?.receipts_json
    ? normalizeBuddyReceipts(JSON.parse(turn.receipts_json))
    : undefined;
  const pending = receipts?.pendingDeletes.find(
    (item) => item.table === table && item.id === id && !item.disposition,
  );
  if (!turn || !receipts || !pending) throw new Error("Pending delete was not found on this turn.");
  return { store, turn, receipts, pending };
}

function persistDisposition(input: {
  turnId: string;
  table: string;
  id: string;
  disposition: "confirmed" | "dismissed";
  expiresAt?: string;
}) {
  const { store, turn, receipts, pending } = findOpenPendingDelete(input.turnId, input.table, input.id);
  pending.disposition = input.disposition;
  if (input.expiresAt) pending.expiresAt = input.expiresAt;
  store.setTurnReceipts(turn.id, JSON.stringify(receipts));
}

export async function POST(request: NextRequest) {
  const accessError = denied(request);
  if (accessError) return accessError;
  try {
    const body = await request.json() as Record<string, unknown>;
    const table = requiredText(body.table, "table", 60);
    if (!(BUDDY_DELETE_TABLES as readonly string[]).includes(table)) {
      return NextResponse.json({ error: "table is not allowed." }, { status: 400 });
    }
    const id = requiredText(body.id, "id", 200);
    const turnId = body.turnId === undefined ? undefined : requiredText(body.turnId, "turnId", 200);
    if (body.action === "dismiss" || body.action === "resolve") {
      if (!turnId) throw new Error("turnId is required to update a pending delete.");
      const disposition = body.action === "dismiss" ? "dismissed" : "confirmed";
      persistDisposition({ turnId, table, id, disposition });
      return NextResponse.json({ disposition });
    }
    // Minting is the confirm tap. It must name the turn whose card was tapped,
    // and that card must still be open, or no token is issued.
    if (!turnId) throw new Error("turnId is required to confirm a delete.");
    const { pending } = findOpenPendingDelete(turnId, table, id);
    // The label is read back from the stored receipt, never from the request,
    // so what gets recorded as deleted is what the operator was actually shown.
    const minted = getBuddyStore().mintPendingDelete({ table, rowId: id, label: pending.label });
    return NextResponse.json(minted);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Delete confirmation failed." }, {
      status: 400,
    });
  }
}
