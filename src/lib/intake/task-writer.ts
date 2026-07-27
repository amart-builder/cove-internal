import type { InboundEvent } from "../data/types";
import { localDateInTimezone } from "../day-plan/brief";
import { operatorTimezone } from "../operator";
import type { TriageOutput } from "../triage/protocol";

export type InboundTaskWriterOptions = {
  fetchImpl?: typeof fetch;
  webBaseUrl?: string;
  fetchTimeoutMs?: number;
  now?: () => Date;
};

const PROJECT_COLUMN_REPROBE_MS = 10 * 60_000;
const projectColumnByBaseUrl = new Map<string, {
  available: boolean;
  checkedAt: number;
}>();

function clockMs(options: InboundTaskWriterOptions): number {
  return (options.now?.() ?? new Date()).getTime();
}

function shouldWriteProject(
  baseUrl: string,
  options: InboundTaskWriterOptions,
): boolean {
  const cached = projectColumnByBaseUrl.get(baseUrl);
  return !cached ||
    cached.available ||
    clockMs(options) - cached.checkedAt >= PROJECT_COLUMN_REPROBE_MS;
}

function webBase(options: InboundTaskWriterOptions): string {
  return (
    options.webBaseUrl ??
    process.env.FORGE_BRIEF_WEB_BASE ??
    "http://127.0.0.1:3200"
  ).replace(/\/$/, "");
}

async function rows(
  fetchImpl: typeof fetch,
  baseUrl: string,
  table: string,
  timeoutMs: number,
  query: string,
): Promise<unknown[]> {
  const response = await fetchImpl(
    `${baseUrl}/api/forge-rest/${table}?${query}`,
    { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" },
  );
  if (!response.ok) throw new Error(`forge-rest ${table} ${response.status}`);
  const value = await response.json() as unknown;
  if (!Array.isArray(value)) throw new Error(`forge-rest ${table} shape`);
  return value;
}

async function csrfToken(
  fetchImpl: typeof fetch,
  baseUrl: string,
  timeoutMs: number,
): Promise<string> {
  const response = await fetchImpl(`${baseUrl}/api/day-plan`, {
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`day_plan_token_${response.status}`);
  const payload = await response.json() as unknown;
  const token = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).csrfToken
    : undefined;
  if (typeof token !== "string" || !token) throw new Error("day_plan_token_missing");
  return token;
}

function missingProjectColumn(status: number, body: string): boolean {
  const message = body.toLowerCase();
  return status >= 400 &&
    message.includes("project") &&
    (
      message.includes("column") ||
      message.includes("schema cache") ||
      message.includes("pgrst204")
    );
}

function responseContainsTask(body: string, id: string): boolean {
  try {
    const value = JSON.parse(body) as unknown;
    return Array.isArray(value) && value.some((row) =>
      row !== null &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      (row as Record<string, unknown>).id === id
    );
  } catch {
    return false;
  }
}

async function existingTask(
  id: string,
  options: Required<Pick<InboundTaskWriterOptions, "fetchImpl">> & {
    baseUrl: string;
    timeoutMs: number;
  },
): Promise<boolean> {
  return (
    await rows(
      options.fetchImpl,
      options.baseUrl,
      "tasks",
      options.timeoutMs,
      `select=id&id=eq.${encodeURIComponent(id)}&limit=1`,
    )
  ).length > 0;
}

export async function inboundTaskExists(
  taskId: string,
  options: InboundTaskWriterOptions = {},
): Promise<boolean> {
  return existingTask(taskId, {
    fetchImpl: options.fetchImpl ?? fetch,
    baseUrl: webBase(options),
    timeoutMs: options.fetchTimeoutMs ?? 10_000,
  });
}

async function createTask(
  event: InboundEvent,
  body: Record<string, unknown>,
  options: InboundTaskWriterOptions,
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = webBase(options);
  const timeoutMs = options.fetchTimeoutMs ?? 10_000;
  if (await existingTask(event.id, { fetchImpl, baseUrl, timeoutMs })) {
    return event.id;
  }
  const token = await csrfToken(fetchImpl, baseUrl, timeoutMs);
  const send = async (payload: Record<string, unknown>) => {
    const response = await fetchImpl(`${baseUrl}/api/forge-rest/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forge-CSRF": token,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    return { response, text: await response.text() };
  };
  const project = typeof body.project === "string" ? body.project : undefined;
  const includeProject = Boolean(project) && shouldWriteProject(baseUrl, options);
  let wroteProject = Boolean(includeProject);
  let result = await send(includeProject ? body : withoutProject(body));
  if (includeProject && !result.response.ok) {
    if (missingProjectColumn(result.response.status, result.text)) {
      projectColumnByBaseUrl.set(baseUrl, {
        available: false,
        checkedAt: clockMs(options),
      });
    }
    wroteProject = false;
    result = await send(withoutProject(body));
  }
  if (result.response.ok && responseContainsTask(result.text, event.id)) {
    if (wroteProject) {
      projectColumnByBaseUrl.set(baseUrl, {
        available: true,
        checkedAt: clockMs(options),
      });
    }
    return event.id;
  }
  if (await existingTask(event.id, { fetchImpl, baseUrl, timeoutMs })) {
    return event.id;
  }
  throw new Error(`forge-rest tasks ${result.response.status}: ${result.text.slice(0, 300)}`);
}

function withoutProject(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const { project: _project, ...compatible } = body;
  void _project;
  return compatible;
}

async function columnId(
  name: "Not Started" | "Must happen today",
  options: InboundTaskWriterOptions,
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = webBase(options);
  const timeoutMs = options.fetchTimeoutMs ?? 10_000;
  const columns = await rows(
    fetchImpl,
    baseUrl,
    "task_columns",
    timeoutMs,
    "select=id,name&order=position.asc",
  );
  const match = columns.find((value) =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).name === name
  ) as Record<string, unknown> | undefined;
  if (typeof match?.id !== "string") {
    throw new Error(`inbound_${name.toLowerCase().replace(/\s+/g, "_")}_column_missing`);
  }
  return match.id;
}

function addCalendarDays(localDate: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) throw new Error("inbound_due_date_invalid");
  return new Date(
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]) + days,
      12,
    ),
  ).toISOString().slice(0, 10);
}

function zoneOffset(localDate: string, timezone: string): string {
  const zoneName = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  }).formatToParts(new Date(`${localDate}T12:00:00.000Z`))
    .find((part) => part.type === "timeZoneName")?.value;
  if (zoneName === "GMT") return "+00:00";
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(zoneName ?? "");
  if (!match) throw new Error("inbound_due_timezone_invalid");
  return `${match[1]}${match[2]}:${match[3]}`;
}

export function fallbackInboundDueAt(
  now: Date,
  timezone = operatorTimezone(),
): string {
  const tomorrow = addCalendarDays(localDateInTimezone(now, timezone), 1);
  return `${tomorrow}T09:00:00${zoneOffset(tomorrow, timezone)}`;
}

export async function createFallbackInboundTask(
  event: InboundEvent,
  options: InboundTaskWriterOptions = {},
): Promise<string> {
  if (await inboundTaskExists(event.id, options)) return event.id;
  const notStarted = await columnId("Not Started", options);
  const clock = options.now ?? (() => new Date());
  return createTask(event, {
    id: event.id,
    column_id: notStarted,
    title: event.raw_text.slice(0, 80) || `Inbound item from ${event.source}`,
    description: `${event.raw_text}\n\nArrived via ${event.source} and needs triage.`,
    priority: "medium",
    due_at: fallbackInboundDueAt(clock()),
    tags: ["needs-triage"],
    position: 0,
    source_type: "inbound_event",
  }, options);
}

export async function createCapturedInboundTask(
  event: InboundEvent,
  input: {
    title: string;
    description: string;
    project?: string;
    priority?: "low" | "medium" | "high";
    column?: "Not Started" | "Must happen today";
  },
  options: InboundTaskWriterOptions = {},
): Promise<string> {
  if (await inboundTaskExists(event.id, options)) return event.id;
  const targetColumn = await columnId(
    input.column ?? "Not Started",
    options,
  );
  return createTask(event, {
    id: event.id,
    column_id: targetColumn,
    title: input.title,
    description: input.description,
    project: input.project ?? "Atlas",
    priority: input.priority ?? "medium",
    tags: ["needs-triage"],
    position: 0,
    source_type: "inbound_event",
  }, options);
}

export async function createTriagedInboundTask(
  event: InboundEvent,
  triage: TriageOutput,
  options: InboundTaskWriterOptions = {},
): Promise<string> {
  if (await inboundTaskExists(event.id, options)) return event.id;
  const clock = options.now ?? (() => new Date());
  const now = clock();
  const timezone = operatorTimezone();
  const dueToday =
    localDateInTimezone(new Date(triage.due_at), timezone) ===
    localDateInTimezone(now, timezone);
  const columnName =
    dueToday && (triage.surface === "now" || triage.priority === "high")
      ? "Must happen today"
      : "Not Started";
  const targetColumn = await columnId(columnName, options);
  const description = [
    triage.description,
    `Offer: ${triage.offer}`,
    `Autonomy: ${triage.autonomy}`,
    `Groundwork: ${triage.groundwork_notes ?? "Not started."}`,
    `Urgency: ${triage.urgency_reason}`,
  ].join("\n\n");
  return createTask(event, {
    id: event.id,
    column_id: targetColumn,
    title: triage.title,
    description,
    project: triage.project,
    priority: triage.priority,
    due_at: triage.due_at,
    tags: ["triaged", `autonomy-${triage.autonomy}`],
    position: 0,
    source_type: "inbound_event",
  }, options);
}
