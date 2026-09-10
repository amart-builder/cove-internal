import { NextRequest, NextResponse } from "next/server";
import { isTrustedCoveRequest } from "@/lib/request-security";
import { getRuntimeMode } from "@/lib/runtime/mode";
import { openLocalDatabase } from "@/lib/local/database";
import { getQuietCurrentCsrfToken } from "@/lib/quiet-current/store";
import { operatorTimezone } from "@/lib/operator";
import {
  reconcileResponsibilities,
  listResponsibilities,
  acknowledgeResponsibility,
  sourceRecord,
  sourceVersion,
} from "@/lib/responsibility/store";
import {
  assessCapacity,
  localDay,
  localHour,
  plannedDay,
} from "@/lib/responsibility/planning";
import { createGoogleWorkspaceGateway } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  if (!isTrustedCoveRequest(request))
    return NextResponse.json({ error: "Untrusted request." }, { status: 403 });
  if (getRuntimeMode() !== "local")
    return NextResponse.json({ enabled: false });
  const db = openLocalDatabase();
  const now = new Date();
  const timezone = operatorTimezone();
  const date = localDay(now, timezone);
  try {
    reconcileResponsibilities(db, now);
    const rows = listResponsibilities(db);
    const day = plannedDay(db, rows, date, timezone);
    let events = null;
    try {
      const calendar = createGoogleWorkspaceGateway().calendar;
      if (calendar)
        events = await calendar.listEvents({
          timeMin: localHour(date, 0, timezone).toISOString(),
          timeMax: localHour(date, 23, timezone).toISOString(),
          timeZone: timezone,
          maxResults: 250,
        });
    } catch {
      /* Unknown calendar stays explicit. */
    }
    if (events && events.length >= 250) events = null; // A capped calendar cannot prove free time.
    const due = rows.filter((row) => Date.parse(row.next_check_at) <= +now);
    const jobRow = db
      .prepare(
        "SELECT status,run_after AS nextAttempt,last_error AS error FROM cove_jobs WHERE type='chief-of-staff-wake' ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get() as
      | { status: string; nextAttempt: string; error: string | null }
      | undefined;
    const job = jobRow
      ? {
          status: jobRow.status,
          nextAttempt: jobRow.nextAttempt,
          error: jobRow.error?.includes("background_usage_limit:")
            ? "background_usage_limit:"
            : undefined,
        }
      : undefined;
    const preparations = db
      .prepare(
        "SELECT * FROM cove_preparations ORDER BY created_at DESC LIMIT 5",
      )
      .all() as Array<{
      ref_kind: "task" | "commitment";
      ref_id: string;
      source_version: string;
    }>;
    return NextResponse.json({
      enabled: true,
      total: rows.length,
      counts: {
        tasks: rows.filter((row) => row.ref_kind === "task").length,
        confirmedCommitments: rows.filter((row) => row.ref_kind === "commitment" && !row.needs_confirmation).length,
        unconfirmed: rows.filter((row) => row.needs_confirmation).length,
      },
      pendingReview: due.length,
      job,
      capacity: assessCapacity({
        now,
        date,
        timezone,
        events,
        items: day.items,
      }),
      plannedCount: day.items.length,
      carried: day.carried.slice(0, 3),
      items: [...rows]
        .sort(
          (a, b) =>
            Number(a.needs_confirmation) - Number(b.needs_confirmation) ||
            a.next_check_at.localeCompare(b.next_check_at),
        )
        .slice(0, 8),
      preparations: preparations.map((p) => {
        const source = sourceRecord(db, p.ref_kind, p.ref_id);
        return {
          ...p,
          stale:
            !source ||
            source.status !== "open" ||
            sourceVersion(source) !== p.source_version,
        };
      }),
    });
  } finally {
    db.close();
  }
}
export async function POST(request: NextRequest) {
  if (
    !isTrustedCoveRequest(request) ||
    request.headers.get("x-cove-csrf") !== getQuietCurrentCsrfToken()
  )
    return NextResponse.json({ error: "Untrusted request." }, { status: 403 });
  if (getRuntimeMode() !== "local")
    return NextResponse.json(
      { error: "Local Cove is required." },
      { status: 400 },
    );
  const text = await request.text();
  if (text.length > 1024)
    return NextResponse.json({ error: "Request too large." }, { status: 413 });
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (
    body?.action !== "acknowledge" ||
    !["task", "commitment"].includes(body.ref_kind) ||
    typeof body.ref_id !== "string" ||
    body.ref_id.length > 200 ||
    !Number.isInteger(body.revision)
  )
    return NextResponse.json(
      { error: "Invalid responsibility." },
      { status: 400 },
    );
  const db = openLocalDatabase();
  try {
    reconcileResponsibilities(db);
    const ok = acknowledgeResponsibility(
      db,
      body.ref_kind,
      body.ref_id,
      body.revision,
    );
    return NextResponse.json({ ok }, { status: ok ? 200 : 409 });
  } finally {
    db.close();
  }
}
