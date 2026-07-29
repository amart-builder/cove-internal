import { NextRequest, NextResponse } from "next/server";
import type { AttioCRMRecord, AttioObjectType } from "@/lib/data/attio-crm";
import { isTrustedForgeRequest } from "@/lib/request-security";
import { getRuntimeMode } from "@/lib/runtime/mode";
import { EXTERNAL_CRM_MESSAGE } from "@/lib/crm";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type AttioValue = Record<string, unknown>;

type AttioRecord = {
  id?: {
    record_id?: string;
  };
  created_at?: string;
  web_url?: string;
  values?: Record<string, AttioValue[]>;
};

const ATTIO_API_BASE = "https://api.attio.com/v2";
const DEFAULT_LIMIT = 500;

function getAttioKey(): string {
  return process.env.ATTIO_API_KEY || process.env.ATTIO_TOKEN || "";
}

function boundedLimit(request: NextRequest): number {
  const raw = Number(request.nextUrl.searchParams.get("limit") ?? DEFAULT_LIMIT);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(raw), 500);
}

async function queryAttioRecords(
  object: AttioObjectType,
  limit: number,
): Promise<AttioRecord[]> {
  const key = getAttioKey();
  const response = await fetch(
    `${ATTIO_API_BASE}/objects/${object}/records/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ limit, offset: 0 }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Attio ${object} query failed: ${message}`);
  }

  const payload = (await response.json()) as { data?: AttioRecord[] };
  return payload.data ?? [];
}

function values(record: AttioRecord, slug: string): AttioValue[] {
  return record.values?.[slug] ?? [];
}

function firstValue(record: AttioRecord, slug: string): AttioValue | undefined {
  return values(record, slug)[0];
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function text(record: AttioRecord, slug: string): string | undefined {
  const value = firstValue(record, slug);
  if (!value) return undefined;

  return (
    asString(value.value) ||
    asString(value.full_name) ||
    asString(value.email_address) ||
    asString(value.original_email_address) ||
    asString(value.phone_number) ||
    asString(value.domain) ||
    asString(value.root_domain) ||
    asString(value.uri)
  );
}

function selectText(record: AttioRecord, slug: string): string | undefined {
  const value = firstValue(record, slug);
  const option = value?.option;
  if (!option || typeof option !== "object") return text(record, slug);

  const optionRecord = option as Record<string, unknown>;
  return (
    asString(optionRecord.title) ||
    asString(optionRecord.name) ||
    asString(optionRecord.value) ||
    asString(optionRecord.id)
  );
}

function allSelectText(record: AttioRecord, slug: string): string[] {
  return values(record, slug)
    .map((value) => {
      const option = value.option;
      if (!option || typeof option !== "object") return asString(value.value);
      const optionRecord = option as Record<string, unknown>;
      return (
        asString(optionRecord.title) ||
        asString(optionRecord.name) ||
        asString(optionRecord.value)
      );
    })
    .filter((value): value is string => Boolean(value));
}

function interactionAt(record: AttioRecord, slug: string): string | undefined {
  return asString(firstValue(record, slug)?.interacted_at);
}

function location(record: AttioRecord, slug: string): string | undefined {
  const value = firstValue(record, slug);
  if (!value) return undefined;

  return [
    asString(value.line_1),
    asString(value.line_2),
    asString(value.locality),
    asString(value.region),
    asString(value.country_code),
  ]
    .filter(Boolean)
    .join(", ");
}

function recordReferenceIds(record: AttioRecord, slug: string): string[] {
  return values(record, slug)
    .map((value) => asString(value.target_record_id))
    .filter((value): value is string => Boolean(value));
}

function sourceAttributes(record: AttioRecord): string[] {
  return Object.entries(record.values ?? {})
    .filter(([, entries]) => entries.length > 0)
    .map(([key]) => key)
    .sort();
}

function unique(valuesToDedupe: Array<string | undefined>): string[] {
  return Array.from(
    new Set(valuesToDedupe.filter((value): value is string => Boolean(value))),
  );
}

function buildCompanyNameMap(records: AttioRecord[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const record of records) {
    const id = record.id?.record_id;
    const name = text(record, "name");
    if (id && name) map.set(id, name);
  }
  return map;
}

function normalizePeopleRecord(
  record: AttioRecord,
  companyNames: Map<string, string>,
): AttioCRMRecord {
  const id = record.id?.record_id ?? crypto.randomUUID();
  const company =
    recordReferenceIds(record, "company")
      .map((companyId) => companyNames.get(companyId))
      .find(Boolean) ||
    text(record, "company_2");
  const tier = selectText(record, "network_tier") || "Uncategorized";
  const description = text(record, "description");

  return {
    _id: `people:${id}`,
    objectType: "people",
    name: text(record, "name") || text(record, "email_addresses") ||
      "Unnamed person",
    email: text(record, "email_addresses"),
    phone: text(record, "phone_numbers"),
    company,
    role: text(record, "job_title") || text(record, "role"),
    linkedin: text(record, "linkedin"),
    location: location(record, "primary_location"),
    notes: description,
    description,
    tier,
    relationship: selectText(record, "relationship_status") ||
      selectText(record, "lp_stage"),
    relevant: selectText(record, "relevant"),
    tags: unique([
      tier,
      selectText(record, "relationship_status"),
      selectText(record, "relevant"),
      selectText(record, "investor_type"),
      ...allSelectText(record, "themes"),
    ]),
    lastContactDate:
      interactionAt(record, "last_interaction") ||
      interactionAt(record, "last_email_interaction") ||
      interactionAt(record, "last_calendar_interaction"),
    nextInteractionDate:
      interactionAt(record, "next_interaction") ||
      interactionAt(record, "next_calendar_interaction"),
    attioUrl: record.web_url,
    sourceAttributes: sourceAttributes(record),
  };
}

function normalizeCompanyRecord(record: AttioRecord): AttioCRMRecord {
  const id = record.id?.record_id ?? crypto.randomUUID();
  const domain = text(record, "domains");
  const tier = selectText(record, "categories") || "Company";
  const description = text(record, "description");

  return {
    _id: `companies:${id}`,
    objectType: "companies",
    name: text(record, "name") || domain || "Unnamed company",
    company: domain,
    role: text(record, "employee_range") || text(record, "estimated_arr_usd"),
    linkedin: text(record, "linkedin"),
    location: location(record, "primary_location"),
    notes: description,
    description,
    tier,
    tags: unique([
      tier,
      ...allSelectText(record, "categories"),
      text(record, "funding_raised_usd"),
      text(record, "foundation_date"),
    ]),
    lastContactDate:
      interactionAt(record, "last_interaction") ||
      interactionAt(record, "last_email_interaction") ||
      interactionAt(record, "last_calendar_interaction"),
    nextInteractionDate:
      interactionAt(record, "next_interaction") ||
      interactionAt(record, "next_calendar_interaction"),
    attioUrl: record.web_url,
    sourceAttributes: sourceAttributes(record),
  };
}

export async function GET(request: NextRequest) {
  if (!isTrustedForgeRequest(request)) {
    return new NextResponse("Untrusted request host.", { status: 403 });
  }
  if (getRuntimeMode() === "local") {
    return NextResponse.json(
      { error: EXTERNAL_CRM_MESSAGE },
      { status: 501 },
    );
  }
  if (!getAttioKey()) {
    return new NextResponse("ATTIO_API_KEY is not configured.", { status: 500 });
  }

  try {
    const limit = boundedLimit(request);
    const [peopleRaw, companiesRaw] = await Promise.all([
      queryAttioRecords("people", limit),
      queryAttioRecords("companies", limit),
    ]);
    const companyNames = buildCompanyNameMap(companiesRaw);
    const people = peopleRaw.map((record) =>
      normalizePeopleRecord(record, companyNames)
    );
    const companies = companiesRaw.map(normalizeCompanyRecord);

    return NextResponse.json({
      source: "attio",
      generatedAt: new Date().toISOString(),
      people,
      companies,
      records: [...people, ...companies],
    });
  } catch (err) {
    return new NextResponse(
      err instanceof Error ? err.message : "Attio CRM request failed.",
      { status: 502 },
    );
  }
}
