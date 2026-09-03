import { NextRequest, NextResponse } from "next/server";
import {
  createCRMBackend,
  resolveAndAppendMeetingActivity,
  type AppendContactActivityInput,
  type ExplicitCreateContactInput,
  type MeetingContactActivityInput,
  type ResolveContactInput,
} from "@/lib/crm";
import {
  attentionItems,
  PIPELINE_STAGE_LABELS,
  PIPELINE_STAGES,
  parseCalendarDate,
  pipelineSummary,
  PipelineValidationError,
  validatePipelinePatch,
  validatePipelineStage,
} from "@/lib/crm/pipeline";
import {
  LocalPipelineStore,
  PipelineCollisionError,
  PipelineNotFoundError,
} from "@/lib/crm/pipeline-store";
import { mergeContactAtomic } from "@/lib/crm/merge";
import { salesPipelineEnabled } from "@/lib/crm/sales-pipeline";
import {
  buildContactContext,
  renderContactContext,
  resolveContact,
} from "@/lib/crm/contact-context";
import { localDateInTimezone } from "@/lib/day-plan/brief";
import type { Contact } from "@/lib/data/types";
import { operatorTimezone } from "@/lib/operator";
import { getQuietCurrentCsrfToken } from "@/lib/quiet-current/store";
import { hasDayPlanRouteAccess } from "@/lib/request-security";
import { getRuntimeMode } from "@/lib/runtime/mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PIPELINE_ACTIONS = new Set([
  "pipeline_upsert",
  "pipeline_move",
  "pipeline_log_touch",
  "pipeline_remove",
]);

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

function contactIdFrom(value: Record<string, unknown>): string {
  const contactId = value.contactId;
  if (typeof contactId !== "string" || !contactId.trim()) {
    throw new PipelineValidationError("Contact id is required.");
  }
  return contactId.trim();
}

function pipelineErrorStatus(error: unknown): number {
  if (error instanceof PipelineCollisionError) return 409;
  if (error instanceof PipelineNotFoundError) return 404;
  return 400;
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
  let pipelineStore: LocalPipelineStore | undefined;
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
    if (operation === "context") {
      const resolution = resolveContact({
        contactId: request.nextUrl.searchParams.get("id") ?? undefined,
        email: request.nextUrl.searchParams.get("email") ?? undefined,
        crm,
      });
      if (resolution.status === "ambiguous") {
        return NextResponse.json(
          { error: "Contact identity is ambiguous.", candidates: resolution.candidates, csrfToken },
          { status: 409 },
        );
      }
      if (resolution.status === "not_found") {
        return NextResponse.json(
          { error: "Contact was not found.", csrfToken },
          { status: 404 },
        );
      }
      const context = buildContactContext({ contactId: resolution.contact.id });
      if (!context) {
        return NextResponse.json(
          { error: "Contact was not found.", csrfToken },
          { status: 404 },
        );
      }
      return NextResponse.json({
        context,
        rendered: renderContactContext(context, { lane: "buddy" }),
        csrfToken,
      });
    }
    if (operation === "pipeline") {
      if (!salesPipelineEnabled()) {
        return NextResponse.json(
          { error: "sales_pipeline_disabled" },
          { status: 404 },
        );
      }
      pipelineStore = new LocalPipelineStore();
      const requestedToday = request.nextUrl.searchParams.get("today")?.trim();
      const today = requestedToday || localDateInTimezone(
        new Date(),
        operatorTimezone(),
      );
      if (!parseCalendarDate(today)) {
        throw new PipelineValidationError(
          "today must be a calendar date in YYYY-MM-DD format.",
        );
      }
      const deals = pipelineStore.list();
      return NextResponse.json({
        deals,
        stages: PIPELINE_STAGES,
        summary: pipelineSummary(deals, today),
        attention: attentionItems(deals, today),
        today,
        csrfToken,
      });
    }
    throw new Error(`Unknown CRM operation: ${operation}`);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "CRM request failed.",
        csrfToken: getQuietCurrentCsrfToken(),
      },
      { status: pipelineErrorStatus(error) },
    );
  } finally {
    pipelineStore?.close();
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
  if (request.headers.get("x-cove-csrf") !== getQuietCurrentCsrfToken()) {
    return NextResponse.json(
      { error: "Cove request token is missing." },
      { status: 403 },
    );
  }

  const crm = createCRMBackend();
  let pipelineStore: LocalPipelineStore | undefined;
  const csrfToken = getQuietCurrentCsrfToken();
  try {
    const body = recordBody(await request.json());
    const action = body.action;
    const input = body.input;
    if (typeof action !== "string") throw new Error("CRM action is required.");
    if (PIPELINE_ACTIONS.has(action) && !salesPipelineEnabled()) {
      return NextResponse.json(
        { error: "sales_pipeline_disabled" },
        { status: 404 },
      );
    }
    if (action === "resolve") {
      return NextResponse.json({
        resolution: crm.resolveOrCreateContact(
          recordBody(input) as ResolveContactInput,
        ),
        csrfToken,
      });
    }
    if (action === "explicit_create") {
      return NextResponse.json({
        creation: crm.createContact(
          recordBody(input) as ExplicitCreateContactInput,
        ),
        csrfToken,
      });
    }
    if (action === "append_activity") {
      return NextResponse.json({
        activity: crm.appendActivity(
          recordBody(input) as AppendContactActivityInput,
        ),
        csrfToken,
      });
    }
    if (action === "meeting_activity") {
      return NextResponse.json({
        result: resolveAndAppendMeetingActivity(
          recordBody(input) as MeetingContactActivityInput,
          crm,
        ),
        csrfToken,
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
          { error: "Contact was not found.", csrfToken },
          { status: 404 },
        );
      }
      return NextResponse.json({ contact, csrfToken });
    }
    if (action === "pipeline_upsert") {
      pipelineStore ??= new LocalPipelineStore();
      const upsert = recordBody(input);
      const contactId = contactIdFrom(upsert);
      const patch = validatePipelinePatch(upsert.patch);
      const existing = pipelineStore.get(contactId);
      if (existing) {
        if (Object.hasOwn(upsert, "stage")) {
          throw new PipelineValidationError(
            "An existing deal must change stage through pipeline_move.",
          );
        }
        return NextResponse.json({
          deal: pipelineStore.update(contactId, patch),
          csrfToken,
        });
      }
      if (!Object.hasOwn(upsert, "stage")) {
        throw new PipelineValidationError("Stage is required for a new deal.");
      }
      return NextResponse.json({
        deal: pipelineStore.create({
          contactId,
          stage: validatePipelineStage(upsert.stage),
          ...patch,
        }),
        csrfToken,
      });
    }
    if (action === "pipeline_move") {
      pipelineStore ??= new LocalPipelineStore();
      const move = recordBody(input);
      return NextResponse.json({
        deal: pipelineStore.move(
          contactIdFrom(move),
          move.stage,
          move.note,
        ),
        csrfToken,
      });
    }
    if (action === "pipeline_log_touch") {
      pipelineStore ??= new LocalPipelineStore();
      const touch = recordBody(input);
      const contactId = contactIdFrom(touch);
      const touchInput = Object.fromEntries(
        Object.entries(touch).filter(([key]) => key !== "contactId"),
      );
      return NextResponse.json({
        deal: pipelineStore.logTouch(contactId, touchInput),
        csrfToken,
      });
    }
    if (action === "pipeline_remove") {
      pipelineStore ??= new LocalPipelineStore();
      const removal = recordBody(input);
      if (!pipelineStore.remove(contactIdFrom(removal))) {
        return NextResponse.json(
          { error: "Pipeline deal was not found.", csrfToken },
          { status: 404 },
        );
      }
      return NextResponse.json({ ok: true, csrfToken });
    }
    if (action === "merge") {
      // Merging is a human decision made through this API; the email lane
      // and the classifier have no path to it.
      const merge = recordBody(input);
      const winnerId = merge.winnerId;
      const loserId = merge.loserId;
      if (
        typeof winnerId !== "string" || !winnerId.trim() ||
        typeof loserId !== "string" || !loserId.trim()
      ) {
        throw new Error("Merge requires winnerId and loserId.");
      }
      return NextResponse.json({
        contact: mergeContactAtomic({ winnerId, loserId }),
        csrfToken,
      });
    }
    if (action === "delete") {
      const deletion = recordBody(input);
      const contactId = deletion.contactId;
      if (typeof contactId !== "string" || !contactId.trim()) {
        throw new Error("Contact id is required.");
      }
      const normalizedContactId = contactId.trim();
      if (salesPipelineEnabled()) {
        pipelineStore ??= new LocalPipelineStore();
        const deal = pipelineStore.get(normalizedContactId);
        if (deal && deal.stage !== "lost" && deal.stage !== "parked") {
          return NextResponse.json(
            {
              error: `This person is in the sales pipeline (${PIPELINE_STAGE_LABELS[deal.stage]}). Mark them lost or parked first.`,
              csrfToken,
            },
            { status: 409 },
          );
        }
      }
      if (!crm.deleteContact(normalizedContactId)) {
        return NextResponse.json(
          { error: "Contact was not found.", csrfToken },
          { status: 404 },
        );
      }
      return NextResponse.json({ ok: true, csrfToken });
    }
    throw new Error(`Unknown CRM action: ${action}`);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "CRM request failed.",
        csrfToken,
      },
      { status: pipelineErrorStatus(error) },
    );
  } finally {
    pipelineStore?.close();
    crm.close();
  }
}
