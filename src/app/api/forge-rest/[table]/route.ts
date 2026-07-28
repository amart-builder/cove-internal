import { NextRequest, NextResponse } from "next/server";
import { getRuntimeMode } from "@/lib/runtime/mode";
import { handleLocalRest } from "@/lib/local/db";
import { getQuietCurrentCsrfToken } from "@/lib/quiet-current/store";
import { hasDayPlanRouteAccess, isTrustedForgeRequest } from "@/lib/request-security";
import { COVE_REST_TABLES } from "@/lib/data/forge-tables";
import { coveEnv } from "../../../../lib/env";

type RouteContext = {
  params: Promise<{ table: string }>;
};

const ALLOWED_TABLES = new Set<string>(COVE_REST_TABLES);
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

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const tablePrefix =
  coveEnv("TABLE_PREFIX") ??
  process.env.NEXT_PUBLIC_FORGE_TABLE_PREFIX ??
  "";

export const dynamic = "force-dynamic";

function resolveTableName(table: string): string {
  return tablePrefix && !table.startsWith(tablePrefix)
    ? `${tablePrefix}${table}`
    : table;
}

function stripKnownPrefix(table: string): string {
  return tablePrefix && table.startsWith(tablePrefix)
    ? table.slice(tablePrefix.length)
    : table;
}

function buildSupabaseUrl(table: string, request: NextRequest): string {
  if (!supabaseUrl) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL is not configured.");
  }

  const url = new URL(`/rest/v1/${resolveTableName(table)}`, supabaseUrl);
  request.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.append(key, value);
  });
  return url.toString();
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

  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : await request.text();

  // Local SQLite mode (default): answer from the on-disk database.
  if (getRuntimeMode() === "local") {
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
