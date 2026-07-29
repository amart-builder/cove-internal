import { NextRequest, NextResponse } from "next/server";
import { getRuntimeMode } from "@/lib/runtime/mode";
import { handleLocalRest } from "@/lib/local/db";
import { getQuietCurrentCsrfToken } from "@/lib/quiet-current/store";
import { hasDayPlanRouteAccess, isTrustedForgeRequest } from "@/lib/request-security";
import {
  COVE_CRM_COMPAT_TABLES,
  COVE_REST_TABLES,
} from "@/lib/data/forge-tables";
import { coveEnv } from "../../../../lib/env";
import {
  createCRMBackend,
  type ContactProvenance,
} from "@/lib/crm";
import type { Contact } from "@/lib/data/types";

type RouteContext = {
  params: Promise<{ table: string }>;
};

const ALLOWED_TABLES = new Set<string>([
  ...COVE_REST_TABLES,
  ...COVE_CRM_COMPAT_TABLES,
]);
const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

// PostgREST query parameters that shape the response rather than select rows.
// Anything else is a column filter.
const NON_FILTER_PARAMS = new Set([
  "select",
  "order",
  "limit",
  "offset",
  "on_conflict",
  "columns",
]);

/**
 * True when the query names at least one row to act on.
 *
 * A filterless PATCH or DELETE is not an error to PostgREST, it is a whole-table
 * operation: `DELETE /api/forge-rest/tasks` empties the board and returns 200.
 * The local SQLite path already refuses both, but the Supabase path passes the
 * query straight through, so the guard belongs here where every runtime and
 * every caller (UI, worker, Buddy's CLI) goes through it.
 */
export function targetsSpecificRows(params: URLSearchParams): boolean {
  for (const key of params.keys()) {
    if (!NON_FILTER_PARAMS.has(key)) return true;
  }
  return false;
}

export function forgeRestMutationAccessFailure(
  request: NextRequest,
  expectedCsrfToken?: string,
): "host" | "csrf" | undefined {
  if (!hasDayPlanRouteAccess(request)) return "host";
  if (request.headers.get("x-forge-csrf") !== (expectedCsrfToken ?? getQuietCurrentCsrfToken())) {
    return "csrf";
  }
}

export const dynamic = "force-dynamic";

function configuredTablePrefix(): string {
  return coveEnv("TABLE_PREFIX") ??
    process.env.NEXT_PUBLIC_FORGE_TABLE_PREFIX ??
    "";
}

function resolveTableName(table: string): string {
  const tablePrefix = configuredTablePrefix();
  return tablePrefix && !table.startsWith(tablePrefix)
    ? `${tablePrefix}${table}`
    : table;
}

function stripKnownPrefix(table: string): string {
  const tablePrefix = configuredTablePrefix();
  return tablePrefix && table.startsWith(tablePrefix)
    ? table.slice(tablePrefix.length)
    : table;
}

function buildSupabaseUrl(table: string, request: NextRequest): string {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not configured.");
  }

  const url = new URL(`/rest/v1/${resolveTableName(table)}`, supabaseUrl);
  request.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.append(key, value);
  });
  return url.toString();
}

function filterValue(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key);
  if (!value) return undefined;
  const dot = value.indexOf(".");
  return (dot >= 0 ? value.slice(dot + 1) : value)
    .replace(/^\*+|\*+$/g, "")
    .trim() || undefined;
}

function parsedObjectBody(body: string | undefined): Record<string, unknown> {
  const parsed = body ? JSON.parse(body) as unknown : undefined;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CRM request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function compatibilitySource(value: unknown): ContactProvenance {
  return value === "meeting-notes" || value === "email" ? value : "manual";
}

function handleCRMCompatibility(
  table: string,
  method: string,
  params: URLSearchParams,
  body: string | undefined,
): NextResponse {
  const crm = createCRMBackend();
  try {
    if (table === "contacts") {
      const id = filterValue(params, "id");
      if (method === "GET") {
        if (id) {
          const result = crm.getContactWithRecentActivities(id, 1);
          return NextResponse.json(result ? [result.contact] : []);
        }
        const emailFilter = params.get("email");
        const email = filterValue(params, "email");
        if (email && emailFilter?.startsWith("eq.")) {
          return NextResponse.json(crm.findByNormalizedEmail(email));
        }
        const search = email ?? filterValue(params, "name");
        return NextResponse.json(crm.listContacts({
          search,
          limit: Number(params.get("limit") ?? 1_000),
        }));
      }
      if (method === "POST") {
        const input = parsedObjectBody(body);
        const resolution = crm.resolveOrCreateContact({
          name: String(input.name ?? ""),
          email: typeof input.email === "string" ? input.email : undefined,
          companyId: typeof input.company_id === "string"
            ? input.company_id
            : undefined,
          phone: typeof input.phone === "string" ? input.phone : undefined,
          role: typeof input.role === "string" ? input.role : undefined,
          linkedin: typeof input.linkedin === "string"
            ? input.linkedin
            : undefined,
          location: typeof input.location === "string"
            ? input.location
            : undefined,
          howWeMet: typeof input.how_we_met === "string"
            ? input.how_we_met
            : undefined,
          tier: typeof input.tier === "string" ? input.tier : undefined,
          tags: Array.isArray(input.tags)
            ? input.tags.filter((tag): tag is string => typeof tag === "string")
            : undefined,
          notes: typeof input.notes === "string" ? input.notes : undefined,
          source: compatibilitySource(
            input.source ?? input.provenance_source,
          ),
        });
        if (resolution.status === "ambiguous") {
          return NextResponse.json(
            {
              error: "Contact identity is ambiguous.",
              candidates: resolution.candidates,
            },
            { status: 409 },
          );
        }
        return NextResponse.json([resolution.contact]);
      }
      if (!id) throw new Error("Contact id filter is required.");
      if (method === "PATCH") {
        const contact = crm.updateContact(
          id,
          parsedObjectBody(body) as Partial<Contact>,
        );
        return NextResponse.json(contact ? [contact] : []);
      }
      if (method === "DELETE") {
        crm.deleteContact(id);
        return new NextResponse(null, { status: 204 });
      }
    }

    if (table === "contact_activities") {
      if (method === "GET") {
        const contactId = filterValue(params, "contact_id");
        if (!contactId) {
          throw new Error("contact_id filter is required for activity history.");
        }
        return NextResponse.json(
          crm.getContactWithRecentActivities(
            contactId,
            Number(params.get("limit") ?? 1_000),
          )?.activities ?? [],
        );
      }
      if (method === "POST") {
        const input = parsedObjectBody(body);
        return NextResponse.json([crm.appendActivity({
          contactId: String(input.contact_id ?? ""),
          companyId: typeof input.company_id === "string"
            ? input.company_id
            : undefined,
          sourceRef: typeof input.source_ref === "string"
            ? input.source_ref
            : undefined,
          activityType: String(input.activity_type ?? ""),
          title: String(input.title ?? ""),
          content: typeof input.content === "string" ? input.content : undefined,
          direction:
            input.direction === "inbound" ||
              input.direction === "outbound" ||
              input.direction === "internal"
              ? input.direction
              : "internal",
          source: compatibilitySource(
            input.source ??
              (input.metadata as Record<string, unknown> | undefined)?.source,
          ),
          occurredAt: typeof input.created_at === "string"
            ? input.created_at
            : undefined,
          metadata:
            input.metadata &&
              typeof input.metadata === "object" &&
              !Array.isArray(input.metadata)
              ? input.metadata as Record<string, unknown>
              : undefined,
        })]);
      }
      throw new Error(
        "Relationship history supports reads and appends, not in-place edits.",
      );
    }

    throw new Error("Unknown CRM compatibility request.");
  } finally {
    crm.close();
  }
}

async function handleRequest(
  request: NextRequest,
  context: RouteContext
): Promise<NextResponse> {
  const method = request.method;
  if (MUTATING_METHODS.has(method)) {
    const accessFailure = forgeRestMutationAccessFailure(request);
    if (accessFailure === "host") {
      return new NextResponse("Untrusted request host.", { status: 403 });
    }
    if (accessFailure === "csrf") {
      return new NextResponse("Cove request token is missing.", { status: 403 });
    }
  }
  if (!MUTATING_METHODS.has(method) && !isTrustedForgeRequest(request)) {
    return new NextResponse("Untrusted request host.", { status: 403 });
  }
  if (
    (method === "PATCH" || method === "DELETE") &&
    !targetsSpecificRows(request.nextUrl.searchParams)
  ) {
    return new NextResponse(
      `Refusing a ${method} with no filter: it would affect every row. ` +
        "Name the rows, for example id=eq.<id>.",
      { status: 400 },
    );
  }
  const { table } = await context.params;
  const decodedTable = decodeURIComponent(table);
  const unprefixedTable = stripKnownPrefix(decodedTable);
  const runtimeMode = getRuntimeMode();
  if (
    runtimeMode === "local" &&
    method === "DELETE" &&
    unprefixedTable === "tasks" &&
    (
      request.headers.get("x-cove-hard-delete") !== "recently-deleted" ||
      request.nextUrl.searchParams.get("status") !== "eq.archived"
    )
  ) {
    return new NextResponse(
      "Tasks can only be permanently deleted from Recently deleted.",
      { status: 403 },
    );
  }
  if (
    runtimeMode === "local" &&
    COVE_CRM_COMPAT_TABLES.includes(
      unprefixedTable as typeof COVE_CRM_COMPAT_TABLES[number],
    ) &&
    !hasDayPlanRouteAccess(request)
  ) {
    return new NextResponse("CRM access is not allowed.", { status: 403 });
  }

  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : await request.text();

  if (
    runtimeMode === "local" &&
    (unprefixedTable === "contacts" ||
      unprefixedTable === "contact_activities")
  ) {
    try {
      return handleCRMCompatibility(
        unprefixedTable,
        method,
        request.nextUrl.searchParams,
        body,
      );
    } catch (error) {
      return new NextResponse(
        error instanceof Error ? error.message : "CRM request failed.",
        { status: 400 },
      );
    }
  }

  // Local SQLite mode (default): answer from the on-disk database.
  if (runtimeMode === "local") {
    try {
      const result = handleLocalRest(
        unprefixedTable,
        method,
        request.nextUrl.searchParams,
        body
      );
      if (result.status === 204 || result.body === undefined) {
        return new NextResponse(null, { status: result.status });
      }
      if (typeof result.body === "string") {
        return new NextResponse(result.body, { status: result.status });
      }
      return NextResponse.json(result.body, { status: result.status });
    } catch (err) {
      return new NextResponse(
        err instanceof Error ? err.message : "Local database error.",
        { status: 500 }
      );
    }
  }

  // Cloud (Supabase) mode.
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return new NextResponse("SUPABASE_SERVICE_ROLE_KEY is not configured.", {
      status: 500,
    });
  }

  if (!ALLOWED_TABLES.has(unprefixedTable)) {
    return new NextResponse("Unknown Cove table.", { status: 404 });
  }

  let response: Response;
  try {
    response = await fetch(buildSupabaseUrl(unprefixedTable, request), {
      method,
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: body || undefined,
    });
  } catch (err) {
    return new NextResponse(
      err instanceof Error ? err.message : "Supabase request failed.",
      { status: 502 }
    );
  }

  const text = await response.text();
  return new NextResponse(text, {
    status: response.status,
    headers: {
      "Content-Type":
        response.headers.get("Content-Type") ?? "application/json",
    },
  });
}

export function GET(request: NextRequest, context: RouteContext) {
  return handleRequest(request, context);
}

export function POST(request: NextRequest, context: RouteContext) {
  return handleRequest(request, context);
}

export function PATCH(request: NextRequest, context: RouteContext) {
  return handleRequest(request, context);
}

export function PUT(request: NextRequest, context: RouteContext) {
  return handleRequest(request, context);
}

export function DELETE(request: NextRequest, context: RouteContext) {
  return handleRequest(request, context);
}
