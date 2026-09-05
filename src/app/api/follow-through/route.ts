import { NextRequest, NextResponse } from "next/server";
import { isTrustedCoveRequest } from "@/lib/request-security";
import { getRuntimeMode } from "@/lib/runtime/mode";
import { readAgentSettings } from "@/lib/agent-settings.mjs";
import { openLocalDatabase } from "@/lib/local/database";
import { followThroughStatus, snoozeFollowThrough, acknowledgeFollowThrough } from "@/lib/attention/follow-through.mjs";
import { getQuietCurrentCsrfToken } from "@/lib/quiet-current/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  if (!isTrustedCoveRequest(request)) return NextResponse.json({ error: "Untrusted request host." }, { status:403 });
  if (getRuntimeMode() !== "local" || !readAgentSettings() || process.env.COVE_FOLLOW_THROUGH === "0") return NextResponse.json({enabled:false});
  const db = openLocalDatabase();
  try { return NextResponse.json({enabled:true,...followThroughStatus(db)}); }
  finally { db.close(); }
}
export async function POST(request: NextRequest) {
  if (!isTrustedCoveRequest(request) || request.headers.get("x-cove-csrf") !== getQuietCurrentCsrfToken()) return NextResponse.json({error:"Untrusted request."},{status:403});
  if (getRuntimeMode() !== "local") return NextResponse.json({error:"Local Cove is required."},{status:400});
  const raw = await request.text();
  if (raw.length > 1024) return NextResponse.json({error:"Request is too large."},{status:413});
  let body;
  try { body=JSON.parse(raw); } catch { return NextResponse.json({error:"Invalid request."},{status:400}); }
  if (!["snooze","acknowledge"].includes(body?.action) || typeof body.id !== "string" || !/^[a-f0-9]{64}$/.test(body.id)) return NextResponse.json({error:"Invalid reminder."},{status:400});
  const db=openLocalDatabase();
  try { return NextResponse.json({ok:body.action === "acknowledge" ? acknowledgeFollowThrough(db,body.id) : snoozeFollowThrough(db,body.id)}); }
  finally { db.close(); }
}
