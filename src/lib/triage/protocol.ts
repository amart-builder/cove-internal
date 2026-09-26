import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type TriageOutput = {
  title: string;
  description: string;
  project: string;
  priority: "low" | "medium" | "high";
  due_at: string;
  autonomy: "none" | "groundwork" | "nearly_done";
  groundwork_notes: string | null;
  surface: "now" | "scheduled" | "board";
  surface_at: string | null;
  urgency_reason: string;
  offer: string;
  // The open board card that already covers this capture. When set, Cove adds
  // the capture to that card instead of creating a second one.
  existing_task_id: string | null;
};

export const TRIAGE_JSON_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "description",
    "project",
    "priority",
    "due_at",
    "autonomy",
    "groundwork_notes",
    "surface",
    "surface_at",
    "urgency_reason",
    "offer",
    "existing_task_id",
  ],
  properties: {
    // minLength is not decoration. validateTriageOutput rejects an empty or
    // whitespace-only string outright, and a schema that permits one lets the
    // model spend an attempt on an answer the contract will refuse.
    title: { type: "string", minLength: 1, maxLength: 240 },
    description: { type: "string", minLength: 1, maxLength: 4000 },
    project: { type: "string", minLength: 1, maxLength: 160 },
    priority: { enum: ["low", "medium", "high"] },
    due_at: { type: "string", format: "date-time", maxLength: 64 },
    autonomy: { enum: ["none", "groundwork", "nearly_done"] },
    groundwork_notes: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 2000 },
        { type: "null" },
      ],
    },
    surface: { enum: ["now", "scheduled", "board"] },
    surface_at: {
      anyOf: [
        { type: "string", format: "date-time", maxLength: 64 },
        { type: "null" },
      ],
    },
    urgency_reason: { type: "string", minLength: 1, maxLength: 600 },
    offer: { type: "string", minLength: 1, maxLength: 600 },
    existing_task_id: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 200 },
        { type: "null" },
      ],
      description: "The id of the OPEN_BOARD_TASKS row that already covers this outcome, so Cove adds the capture to that card as an update instead of creating another. Null only for distinct new work.",
    },
  },
});

let cachedProtocol: string | undefined;

export function readTriageProtocol(): string {
  if (cachedProtocol !== undefined) return cachedProtocol;
  const modulePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "prompts",
    "triage.md",
  );
  const cwdPath = path.join(process.cwd(), "prompts", "triage.md");
  for (const candidate of new Set([modulePath, cwdPath])) {
    try {
      cachedProtocol = readFileSync(candidate, "utf8").trimEnd();
      return cachedProtocol;
    } catch {
      // Try the other install layout.
    }
  }
  throw new Error(
    `Triage protocol is unreadable. Looked at ${modulePath} and ${cwdPath}.`,
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("triage_invalid_shape");
  }
  return value as Record<string, unknown>;
}

function boundedString(
  value: unknown,
  name: string,
  maximum: number,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`triage_${name}_required`);
  }
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (cleaned.length > maximum) throw new Error(`triage_${name}_too_long`);
  return cleaned;
}

const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Date.parse takes a date the calendar does not have and rolls it forward, so
// "2026-02-30" becomes March 2 and "T24:00" becomes the next day. This is the
// one free-form value in the contract that decides which column a card lands
// in and when its reminder fires, so a rolled-over date is a deadline nobody
// chose. Check the fields the calendar actually allows.
function isoTimestamp(value: unknown, name: string): string {
  const text = boundedString(value, name, 64);
  const parts = ISO_TIMESTAMP.exec(text);
  if (!parts || Number.isNaN(Date.parse(text))) {
    throw new Error(`triage_${name}_invalid`);
  }
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = parts;
  const monthNumber = Number(month);
  if (monthNumber < 1 || monthNumber > 12) throw new Error(`triage_${name}_invalid`);
  const dayNumber = Number(day);
  if (dayNumber < 1 || dayNumber > daysInMonth(Number(year), monthNumber)) {
    throw new Error(`triage_${name}_invalid`);
  }
  if (
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    (second !== undefined && Number(second) > 59) ||
    (offsetHour !== undefined && (Number(offsetHour) > 14 || Number(offsetMinute) > 59))
  ) {
    throw new Error(`triage_${name}_invalid`);
  }
  return text;
}

export function validateTriageOutput(
  value: unknown,
  projectNames: readonly string[],
  // The open board ids the model was shown. Undefined skips the check, for
  // callers that validate shape alone.
  openTaskIds?: ReadonlySet<string>,
): TriageOutput {
  const input = record(value);
  // Optional on the way in so a stored or fixture triage written before the
  // field existed still reads; the wire schema itself requires it.
  if (!Object.hasOwn(input, "existing_task_id")) input.existing_task_id = null;
  const expected = new Set([
    "title",
    "description",
    "project",
    "priority",
    "due_at",
    "autonomy",
    "groundwork_notes",
    "surface",
    "surface_at",
    "urgency_reason",
    "offer",
    "existing_task_id",
  ]);
  if (
    Object.keys(input).length !== expected.size ||
    Object.keys(input).some((key) => !expected.has(key))
  ) {
    throw new Error("triage_invalid_fields");
  }
  const project = boundedString(input.project, "project", 160);
  const allowedProjects = new Set(["Atlas", ...projectNames]);
  if (!allowedProjects.has(project)) throw new Error("triage_project_invalid");
  const priority = input.priority;
  if (priority !== "low" && priority !== "medium" && priority !== "high") {
    throw new Error("triage_priority_invalid");
  }
  const autonomy = input.autonomy;
  if (
    autonomy !== "none" &&
    autonomy !== "groundwork" &&
    autonomy !== "nearly_done"
  ) {
    throw new Error("triage_autonomy_invalid");
  }
  const surface = input.surface;
  if (surface !== "now" && surface !== "scheduled" && surface !== "board") {
    throw new Error("triage_surface_invalid");
  }
  const groundwork = input.groundwork_notes === null
    ? null
    : boundedString(input.groundwork_notes, "groundwork_notes", 2000);
  const surfaceAt = input.surface_at === null
    ? null
    : isoTimestamp(input.surface_at, "surface_at");
  if ((surface === "scheduled") !== Boolean(surfaceAt)) {
    throw new Error("triage_surface_at_mismatch");
  }
  const existingTaskId = input.existing_task_id === null
    ? null
    : boundedString(input.existing_task_id, "existing_task_id", 200);
  if (existingTaskId && openTaskIds && !openTaskIds.has(existingTaskId)) {
    throw new Error("triage_existing_task_unknown");
  }
  return {
    title: boundedString(input.title, "title", 240),
    description: boundedString(input.description, "description", 4000),
    project,
    priority,
    due_at: isoTimestamp(input.due_at, "due_at"),
    autonomy,
    groundwork_notes: groundwork,
    surface,
    surface_at: surfaceAt,
    urgency_reason: boundedString(input.urgency_reason, "urgency_reason", 600),
    offer: boundedString(input.offer, "offer", 600),
    existing_task_id: existingTaskId,
  };
}
