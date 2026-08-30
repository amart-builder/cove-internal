/**
 * Final deterministic write boundary for model-triaged inbound work.
 *
 * The model proposes a task shape. This module resolves columns, preserves
 * source provenance, applies recurrence and autonomy defaults, performs the
 * actual REST write, and degrades to a safe fallback task when triage fails.
 */
import { ensureCoveAutonomySettings } from "../autonomy/settings";
import type { InboundEvent, Task } from "../data/types";
import { localDateInTimezone } from "../day-plan/brief";
import { operatorTimezone } from "../operator";
import { taskColumnKeyForName, type TaskColumnKey } from "../tasks/columns";
import type { TriageOutput } from "../triage/protocol";
import { coveEnv } from "../env";
import { getRuntimeMode } from "../runtime/mode";

export type InboundTaskWriterOptions = {
  dataDir?: string;
  fetchImpl?: typeof fetch;
  webBaseUrl?: string;
  fetchTimeoutMs?: number;
  now?: () => Date;
  proposedRecurrenceCadence?: string;
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
    coveEnv("BRIEF_WEB_BASE") ??
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
    `${baseUrl}/api/cove-rest/${table}?${query}`,
    { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" },
  );
  if (!response.ok) throw new Error(`cove-rest ${table} ${response.status}`);
  const value = await response.json() as unknown;
  if (!Array.isArray(value)) throw new Error(`cove-rest ${table} shape`);
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

function groundworkTaskRow(value: unknown): Task | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const task = value as Partial<Task>;
  if (
    typeof task.id !== "string" ||
    typeof task.title !== "string" ||
    typeof task.description !== "string" ||
    !Array.isArray(task.tags) ||
    !task.tags.every((tag) => typeof tag === "string") ||
    (
      task.status !== "open" &&
      task.status !== "done" &&
      task.status !== "archived"
    )
  ) {
    throw new Error("cove-rest tasks row shape");
  }
  return task as Task;
}

async function listGroundworkTasksWithTag(
  tag: "groundwork-queued" | "groundwork-running",
  options: InboundTaskWriterOptions = {},
): Promise<Task[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = webBase(options);
  const timeoutMs = options.fetchTimeoutMs ?? 10_000;
  const values = await rows(
    fetchImpl,
    baseUrl,
    "tasks",
    timeoutMs,
    "select=id,title,description,project,tags,status,created_at,updated_at" +
      `&status=eq.open&tags=cs.${encodeURIComponent(`{${tag}}`)}` +
      "&order=created_at.asc&limit=20",
  );
  return values.flatMap((value) => {
    const task = groundworkTaskRow(value);
    return task?.tags.includes(tag) ? [task] : [];
  });
}

export async function listGroundworkQueuedTasks(
  options: InboundTaskWriterOptions = {},
): Promise<Task[]> {
  return listGroundworkTasksWithTag("groundwork-queued", options);
}

export async function listGroundworkRunningTasks(
  options: InboundTaskWriterOptions = {},
): Promise<Task[]> {
  return listGroundworkTasksWithTag("groundwork-running", options);
}

export async function getTaskThroughCoveRest(
  id: string,
  options: InboundTaskWriterOptions = {},
): Promise<Task | undefined> {
  const values = await rows(
    options.fetchImpl ?? fetch,
    webBase(options),
    "tasks",
    options.fetchTimeoutMs ?? 10_000,
    "select=id,title,description,project,tags,status,created_at,updated_at" +
      `&id=eq.${encodeURIComponent(id)}&limit=1`,
  );
  return groundworkTaskRow(values[0]);
}

export async function updateTaskThroughCoveRest(
  id: string,
  patch: Partial<Task>,
  options: InboundTaskWriterOptions = {},
  guard: { expectedTag?: string } = {},
): Promise<Task | undefined> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = webBase(options);
  const timeoutMs = options.fetchTimeoutMs ?? 10_000;
  const token = await csrfToken(fetchImpl, baseUrl, timeoutMs);
  const response = await fetchImpl(
    `${baseUrl}/api/cove-rest/tasks?id=eq.${encodeURIComponent(id)}${
      guard.expectedTag
        ? `&tags=cs.${encodeURIComponent(`{${guard.expectedTag}}`)}`
        : ""
    }`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Cove-CSRF": token,
        "X-Cove-Task-Write": "automation",
      },
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`cove-rest tasks ${response.status}: ${text.slice(0, 300)}`);
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (!Array.isArray(value)) {
      throw new Error("shape");
    }
    if (value.length === 0) return undefined;
    return groundworkTaskRow(value[0]);
  } catch {
    throw new Error("cove-rest tasks patch shape");
  }
}

export async function createAnalystInboundTask(
  event: InboundEvent,
  input: {
    title: string;
    description: string;
    brief: string;
    dueAt: string;
    priority: "low" | "medium" | "high";
    notificationPolicy: "none" | "predeadline" | "due" | "both";
    remindAt?: string | null;
  },
  options: InboundTaskWriterOptions = {},
): Promise<string> {
  if (await inboundTaskExists(event.id, options)) return event.id;
  const targetColumn = await columnId("not-started", options);
  return createTask(event, {
    id: event.id,
    column_id: targetColumn,
    title: input.title,
    description: input.description,
    brief: input.brief,
    due_at: input.dueAt,
    priority: input.priority,
    notification_policy: input.notificationPolicy,
    remind_at: input.remindAt ?? null,
    tags: ["triaged", "meeting-analyst"],
    position: 0,
    source_type: "inbound_event",
  }, options);
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
    const response = await fetchImpl(`${baseUrl}/api/cove-rest/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cove-CSRF": token,
        "X-Cove-Task-Write": "automation",
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
  throw new Error(`cove-rest tasks ${result.response.status}: ${result.text.slice(0, 300)}`);
}

function withoutProject(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const { project: _project, ...compatible } = body;
  void _project;
  return compatible;
}

async function columnId(
  key: Extract<TaskColumnKey, "not-started" | "today">,
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
    taskColumnKeyForName(String((value as Record<string, unknown>).name)) === key
  ) as Record<string, unknown> | undefined;
  if (typeof match?.id !== "string") {
    throw new Error(`inbound_${key.replace(/-/g, "_")}_column_missing`);
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

/**
 * A consolidated meeting bundle must land exactly as captured: the first
 * line is the task title and the checklist lines plus the Meeting footer are
 * the description. Model triage can reword everything else, but not this.
 * The rule in prompts/triage.md is guidance; this override is the guarantee.
 *
 * Only events from the meeting pipeline (source "meeting") qualify. A chat
 * or manual capture that happens to start with "Follow ups:" keeps normal
 * triage behavior.
 */
function meetingBundleOverride(
  event: InboundEvent,
): { title: string; description: string } | undefined {
  if (event.source !== "meeting") return undefined;
  const lines = event.raw_text.split(/\r?\n/);
  const title = (lines[0] ?? "").trim();
  if (!title.startsWith("Follow ups:")) return undefined;
  return { title, description: lines.slice(1).join("\n").trim() };
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
  const clock = options.now ?? (() => new Date());
  const proposedCadence = getRuntimeMode() === "local"
    ? options.proposedRecurrenceCadence
    : undefined;
  const recurrenceLocalDate = proposedCadence
    ? localDateInTimezone(clock(), operatorTimezone())
    : undefined;
  const targetColumn = await columnId(
    proposedCadence ? "today" : "not-started",
    options,
  );
  const bundle = meetingBundleOverride(event);
  return createTask(event, {
    id: event.id,
    column_id: targetColumn,
    title: bundle?.title ??
      (event.raw_text.slice(0, 80) || `Inbound item from ${event.source}`),
    description: `${bundle?.description ?? event.raw_text}\n\nArrived via ${event.source} and needs triage.`,
    priority: "medium",
    due_at: recurrenceLocalDate ?? fallbackInboundDueAt(clock()),
    tags: [
      "needs-triage",
      ...(proposedCadence ? ["recurrence-proposed"] : []),
    ],
    ...(proposedCadence
      ? { proposed_recurrence_cadence: proposedCadence }
      : {}),
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
  const proposedCadence = getRuntimeMode() === "local"
    ? options.proposedRecurrenceCadence
    : undefined;
  const targetColumn = await columnId(
    proposedCadence || input.column === "Must happen today"
      ? "today"
      : "not-started",
    options,
  );
  const recurrenceLocalDate = proposedCadence
    ? localDateInTimezone((options.now ?? (() => new Date()))(), operatorTimezone())
    : undefined;
  return createTask(event, {
    id: event.id,
    column_id: targetColumn,
    title: input.title,
    description: input.description,
    project: input.project ?? "Atlas",
    priority: input.priority ?? "medium",
    ...(recurrenceLocalDate ? { due_at: recurrenceLocalDate } : {}),
    tags: [
      "needs-triage",
      ...(proposedCadence ? ["recurrence-proposed"] : []),
    ],
    ...(proposedCadence
      ? { proposed_recurrence_cadence: proposedCadence }
      : {}),
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
  const proposedCadence = getRuntimeMode() === "local"
    ? options.proposedRecurrenceCadence
    : undefined;
  const columnKey = proposedCadence ||
      (
        dueToday &&
        (triage.surface === "now" || triage.priority === "high")
      )
    ? "today"
    : "not-started";
  const targetColumn = await columnId(columnKey, options);
  const bundle = meetingBundleOverride(event);
  const description = bundle?.description ?? [
    triage.description,
    `Offer: ${triage.offer}`,
    `Autonomy: ${triage.autonomy}`,
    `Groundwork: ${triage.groundwork_notes ?? "Not started."}`,
    `Urgency: ${triage.urgency_reason}`,
  ].join("\n\n");
  let queueGroundwork = false;
  try {
    queueGroundwork =
      ensureCoveAutonomySettings(options.dataDir).level !== "off" &&
      triage.autonomy !== "none";
  } catch (error) {
    console.error("Cove autonomy setting unavailable; groundwork was not queued.", error);
  }
  return createTask(event, {
    id: event.id,
    column_id: targetColumn,
    title: bundle?.title ?? triage.title,
    description,
    project: triage.project,
    priority: triage.priority,
    due_at: triage.due_at,
    tags: [
      "triaged",
      `autonomy-${triage.autonomy}`,
      ...(proposedCadence ? ["recurrence-proposed"] : []),
      ...(queueGroundwork
        ? ["groundwork-queued", `groundwork-grade:${triage.autonomy}`]
        : []),
    ],
    ...(proposedCadence
      ? { proposed_recurrence_cadence: proposedCadence }
      : {}),
    position: 0,
    source_type: "inbound_event",
  }, options);
}
