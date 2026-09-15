import { NextRequest, NextResponse } from "next/server";
import { isTrustedCoveRequest } from "@/lib/request-security";
import { openLocalDatabase } from "@/lib/local/database";
import { getQuietCurrentCsrfToken } from "@/lib/quiet-current/store";
import {
  answerPlanningQuestion,
  planningQuestions,
} from "@/lib/chief-of-staff/questions";
import { tryEnqueueChiefOfStaffWake } from "@/lib/chief-of-staff/hooks";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  if (!isTrustedCoveRequest(request))
    return NextResponse.json({ error: "Untrusted request." }, { status: 403 });
  const db = openLocalDatabase();
  try {
    return NextResponse.json({
      questions: planningQuestions(
        db,
        new Date(),
        request.nextUrl.searchParams.has("taskId")
          ? { kind: "task", id: request.nextUrl.searchParams.get("taskId")! }
          : undefined,
      ),
      csrfToken: getQuietCurrentCsrfToken(),
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
  const text = await request.text();
  if (text.length > 4096)
    return NextResponse.json({ error: "Request too large." }, { status: 413 });
  const db = openLocalDatabase();
  try {
    const body = JSON.parse(text);
    const question = answerPlanningQuestion(db, {
      id: body.id,
      revision: body.revision,
      answer: body.answer,
      source: body.source ?? "planning-question-form",
      disposition: body.disposition ?? "answered",
    });
    tryEnqueueChiefOfStaffWake({
      reason: "manual",
      payload: { questionId: question.id, decision: question.decision_key },
    });
    return NextResponse.json({ question });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid answer." },
      { status: 409 },
    );
  } finally {
    db.close();
  }
}
