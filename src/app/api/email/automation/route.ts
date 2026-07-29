import { NextRequest, NextResponse } from "next/server";
import {
  archiveEmailItemFromCard,
  captureEmailCommitments,
  getEmailCRMContext,
  recordEmailCorrespondence,
  type EmailCommitmentInput,
} from "@/lib/email/automation";
import { getQuietCurrentCsrfToken } from "@/lib/quiet-current/store";
import { hasDayPlanRouteAccess } from "@/lib/request-security";
import { getRuntimeMode } from "@/lib/runtime/mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function record(value: unknown, name = "request body"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function text(
  value: unknown,
  name: string,
  options: { required?: boolean; max?: number } = {},
): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (options.required) throw new Error(`${name} is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`${name} must be text.`);
  const result = value.trim();
  if (!result && options.required) throw new Error(`${name} is required.`);
  if (result.length > (options.max ?? 4_000)) {
    throw new Error(`${name} is too long.`);
  }
  return result;
}

function commitments(value: unknown): EmailCommitmentInput[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("commitments must be an array of at most 100 items.");
  }
  return value.map((item) => {
    const row = record(item, "commitment");
    if (row.kind !== "follow_up" && row.kind !== "waiting_on") {
      throw new Error("Commitment kind must be follow_up or waiting_on.");
    }
    return {
      kind: row.kind,
      threadId: text(row.threadId, "threadId", {
        required: true,
        max: 500,
      })!,
      title: text(row.title, "title", { required: true, max: 240 })!,
      sourceQuote: text(row.sourceQuote, "sourceQuote", {
        required: true,
        max: 4_000,
      })!,
      threadLink: text(row.threadLink, "threadLink", {
        required: true,
        max: 2_000,
      })!,
      counterparty: text(row.counterparty, "counterparty", { max: 240 }),
      dueAt: row.dueAt === null
        ? null
        : text(row.dueAt, "dueAt", { max: 80 }),
      contactId: row.contactId === null
        ? null
        : text(row.contactId, "contactId", { max: 200 }),
    };
  });
}

export async function POST(request: NextRequest) {
  if (getRuntimeMode() !== "local") {
    return NextResponse.json(
      { error: "Email automation uses the local Cove runtime." },
      { status: 409 },
    );
  }
  if (!hasDayPlanRouteAccess(request)) {
    return NextResponse.json(
      { error: "Email automation access is not allowed." },
      { status: 403 },
    );
  }
  if (request.headers.get("x-forge-csrf") !== getQuietCurrentCsrfToken()) {
    return NextResponse.json(
      { error: "Cove request token is missing." },
      { status: 403 },
    );
  }
  try {
    const body = record(await request.json());
    const action = text(body.action, "action", { required: true, max: 40 });
    if (action === "card_archive") {
      return NextResponse.json(await archiveEmailItemFromCard({
        emailItemId: text(body.emailItemId, "emailItemId", {
          required: true,
          max: 200,
        })!,
      }));
    }
    if (action === "capture_commitments") {
      return NextResponse.json(captureEmailCommitments({
        commitments: commitments(body.commitments),
      }), { status: 201 });
    }
    if (action === "crm_context") {
      return NextResponse.json(getEmailCRMContext({
        senderName: text(body.senderName, "senderName", { max: 240 }) ?? "",
        senderEmail: text(body.senderEmail, "senderEmail", {
          required: true,
          max: 500,
        })!,
        threadId: text(body.threadId, "threadId", {
          required: true,
          max: 500,
        })!,
      }));
    }
    if (action === "correspondence") {
      if (body.direction !== "inbound" && body.direction !== "outbound") {
        throw new Error("direction must be inbound or outbound.");
      }
      return NextResponse.json(recordEmailCorrespondence({
        senderName: text(body.senderName, "senderName", { max: 240 }) ?? "",
        senderEmail: text(body.senderEmail, "senderEmail", {
          required: true,
          max: 500,
        })!,
        threadId: text(body.threadId, "threadId", {
          required: true,
          max: 500,
        })!,
        messageId: text(body.messageId, "messageId", {
          required: true,
          max: 500,
        })!,
        title: text(body.title, "title", { required: true, max: 240 })!,
        content: text(body.content, "content", { max: 20_000 }) ?? "",
        direction: body.direction,
        occurredAt: text(body.occurredAt, "occurredAt", { max: 80 }),
      }), { status: 201 });
    }
    throw new Error("Unknown email automation action.");
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Email automation failed.";
    const status = /not found/i.test(message) ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
