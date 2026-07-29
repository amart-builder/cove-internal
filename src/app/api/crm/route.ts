import { NextRequest, NextResponse } from "next/server";
import {
  createCRMBackend,
  resolveAndAppendMeetingActivity,
  type AppendContactActivityInput,
  type ExplicitCreateContactInput,
  type MeetingContactActivityInput,
  type ResolveContactInput,
} from "@/lib/crm";
import type { Contact } from "@/lib/data/types";
import { getQuietCurrentCsrfToken } from "@/lib/quiet-current/store";
import { hasDayPlanRouteAccess } from "@/lib/request-security";
import { getRuntimeMode } from "@/lib/runtime/mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requiredQuery(
  request: NextRequest,
  name: string,
): string {
  const value = request.nextUrl.searchParams.get(name)?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function queryLimit(request: NextRequest, fallback: number): number {
  const value = Number(request.nextUrl.searchParams.get("limit") ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

function recordBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CRM request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

export async function GET(request: NextRequest) {
  if (getRuntimeMode() !== "local") {
    return NextResponse.json(
      { error: "The local CRM interface is available only in local runtime mode." },
      { status: 409 },
    );
  }
  if (!hasDayPlanRouteAccess(request)) {
    return NextResponse.json({ error: "CRM access is not allowed." }, { status: 403 });
  }
  const crm = createCRMBackend();
  try {
    const operation = request.nextUrl.searchParams.get("operation") ?? "list";
    const csrfToken = getQuietCurrentCsrfToken();
    if (operation === "list") {
      return NextResponse.json({
        contacts: crm.listContacts({
          search: request.nextUrl.searchParams.get("search") ?? undefined,
          limit: queryLimit(request, 1_000),
        }),
        csrfToken,
      });
    }
    if (operation === "get") {
      const result = crm.getContactWithRecentActivities(
        requiredQuery(request, "id"),
        queryLimit(request, 20),
      );
      return NextResponse.json({
        contact: result?.contact ?? null,
        activities: result?.activities ?? [],
        csrfToken,
      });
    }
    throw new Error(`Unknown CRM operation: ${operation}`);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "CRM request failed." },
      { status: 400 },
    );
  } finally {
    crm.close();
  }
}

export async function POST(request: NextRequest) {
  if (getRuntimeMode() !== "local") {
    return NextResponse.json(
      { error: "The local CRM interface is available only in local runtime mode." },
      { status: 409 },
    );
  }
  if (!hasDayPlanRouteAccess(request)) {
    return NextResponse.json({ error: "CRM access is not allowed." }, { status: 403 });
  }
  if (request.headers.get("x-forge-csrf") !== getQuietCurrentCsrfToken()) {
    return NextResponse.json(
      { error: "Cove request token is missing." },
      { status: 403 },
    );
  }

  const crm = createCRMBackend();
  try {
    const body = recordBody(await request.json());
    const action = body.action;
    const input = body.input;
    if (typeof action !== "string") throw new Error("CRM action is required.");
    if (action === "resolve") {
      return NextResponse.json({
        resolution: crm.resolveOrCreateContact(
          recordBody(input) as ResolveContactInput,
        ),
      });
    }
    if (action === "explicit_create") {
      return NextResponse.json({
        creation: crm.createContact(
          recordBody(input) as ExplicitCreateContactInput,
        ),
      });
    }
    if (action === "append_activity") {
      return NextResponse.json({
        activity: crm.appendActivity(
          recordBody(input) as AppendContactActivityInput,
        ),
      });
    }
    if (action === "meeting_activity") {
      return NextResponse.json({
        result: resolveAndAppendMeetingActivity(
          recordBody(input) as MeetingContactActivityInput,
          crm,
        ),
      });
    }
    if (action === "update") {
      const update = recordBody(input);
      const contactId = update.contactId;
      if (typeof contactId !== "string" || !contactId.trim()) {
        throw new Error("Contact id is required.");
      }
      const contact = crm.updateContact(
        contactId,
        recordBody(update.patch) as Partial<Contact>,
      );
      if (!contact) {
        return NextResponse.json(
          { error: "Contact was not found." },
          { status: 404 },
        );
      }
      return NextResponse.json({ contact });
    }
    if (action === "delete") {
      const deletion = recordBody(input);
      const contactId = deletion.contactId;
      if (typeof contactId !== "string" || !contactId.trim()) {
        throw new Error("Contact id is required.");
      }
      if (!crm.deleteContact(contactId)) {
        return NextResponse.json(
          { error: "Contact was not found." },
          { status: 404 },
        );
      }
      return NextResponse.json({ ok: true });
    }
    throw new Error(`Unknown CRM action: ${action}`);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "CRM request failed." },
      { status: 400 },
    );
  } finally {
    crm.close();
  }
}
