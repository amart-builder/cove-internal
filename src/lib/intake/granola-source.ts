import { createHash } from "node:crypto";

const DEFAULT_GRANOLA_API_BASE_URL = "https://public-api.granola.ai/v1";
const MIN_REQUEST_INTERVAL_MS = 250;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRY_AFTER_MS = 10_000;
const MAX_BODY_CHARACTERS = 20_000;
const TRUNCATION_MARKER = "[Content truncated by Cove.]";

export type GranolaPerson = {
  name?: string | null;
  email?: string | null;
};

export type GranolaNoteSummary = {
  id: string;
  title?: string | null;
  owner?: GranolaPerson | null;
  created_at: string;
  updated_at: string;
};

export type GranolaNote = GranolaNoteSummary & {
  attendees?: GranolaPerson[] | null;
  summary_text?: string | null;
  summary_markdown?: string | null;
  private_notes_text?: string | null;
  private_notes_markdown?: string | null;
  transcript?: unknown;
  calendar_event?: {
    event_title?: string | null;
    scheduled_start_time?: string | null;
    scheduled_end_time?: string | null;
  } | null;
  web_url: string;
};

export type GranolaListPage = {
  notes: GranolaNoteSummary[];
  hasMore: boolean;
  cursor?: string;
};

export class GranolaApiError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Granola API request failed with HTTP ${status}.`);
    this.name = "GranolaApiError";
    this.status = status;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Granola API response is missing ${field}.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parsePerson(value: unknown): GranolaPerson | undefined {
  const row = objectValue(value);
  if (!row) return undefined;
  const name = optionalString(row.name);
  const email = optionalString(row.email);
  return name || email ? { name, email } : undefined;
}

function parseNoteSummary(value: unknown): GranolaNoteSummary {
  const row = objectValue(value);
  if (!row) throw new Error("Granola API returned an invalid note.");
  return {
    id: requiredString(row.id, "note id"),
    title: optionalString(row.title),
    owner: parsePerson(row.owner),
    created_at: requiredString(row.created_at, "created_at"),
    updated_at: requiredString(row.updated_at, "updated_at"),
  };
}

function parseNote(value: unknown): GranolaNote {
  const row = objectValue(value);
  if (!row) throw new Error("Granola API returned an invalid note detail.");
  const summary = parseNoteSummary(row);
  const calendar = objectValue(row.calendar_event);
  return {
    ...summary,
    attendees: Array.isArray(row.attendees)
      ? row.attendees.flatMap((person) => {
          const parsed = parsePerson(person);
          return parsed ? [parsed] : [];
        })
      : [],
    summary_text: optionalString(row.summary_text),
    summary_markdown: optionalString(row.summary_markdown),
    private_notes_text: optionalString(row.private_notes_text),
    private_notes_markdown: optionalString(row.private_notes_markdown),
    calendar_event: calendar
      ? {
          event_title: optionalString(calendar.event_title),
          scheduled_start_time: optionalString(calendar.scheduled_start_time),
          scheduled_end_time: optionalString(calendar.scheduled_end_time),
        }
      : null,
    web_url: requiredString(row.web_url, "web_url"),
  };
}

function retryAfterMs(value: string | null, now: number): number {
  if (!value) return MIN_REQUEST_INTERVAL_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.max(0, timestamp - now)
    : MIN_REQUEST_INTERVAL_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createGranolaClient(options: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  sleepImpl?: (ms: number) => Promise<void>;
}) {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("Granola API key is required.");
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? sleep;
  const baseUrl = (
    options.baseUrl ?? process.env.GRANOLA_API_BASE_URL ?? DEFAULT_GRANOLA_API_BASE_URL
  ).replace(/\/$/, "");
  let lastRequestAt = 0;

  async function request(path: string): Promise<unknown> {
    const makeRequest = async (): Promise<Response> => {
      const waitMs = Math.max(0, MIN_REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt));
      if (waitMs > 0) await sleepImpl(waitMs);
      lastRequestAt = Date.now();
      return fetchImpl(`${baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    };
    let response = await makeRequest();
    if (response.status === 429) {
      await sleepImpl(Math.min(
        MAX_RETRY_AFTER_MS,
        retryAfterMs(response.headers.get("retry-after"), Date.now()),
      ));
      response = await makeRequest();
    }
    if (!response.ok) throw new GranolaApiError(response.status);
    return response.json() as Promise<unknown>;
  }

  return {
    async listNotes(input: {
      updatedAfter: string;
      pageSize?: number;
      cursor?: string;
    }): Promise<GranolaListPage> {
      const pageSize = input.pageSize ?? 30;
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 30) {
        throw new Error("Granola page size must be an integer from 1 to 30.");
      }
      const query = new URLSearchParams({
        updated_after: input.updatedAfter,
        page_size: String(pageSize),
      });
      if (input.cursor) query.set("cursor", input.cursor);
      const row = objectValue(await request(`/notes?${query}`));
      const hasMore = typeof row?.hasMore === "boolean"
        ? row.hasMore
        : row?.has_more;
      if (!row || !Array.isArray(row.notes) || typeof hasMore !== "boolean") {
        throw new Error("Granola API returned an invalid notes page.");
      }
      const cursor = optionalString(row.cursor) ?? optionalString(row.next_cursor);
      if (hasMore && !cursor) {
        throw new Error("Granola API notes page is missing its next cursor.");
      }
      return {
        notes: row.notes.map(parseNoteSummary),
        hasMore,
        ...(cursor ? { cursor } : {}),
      };
    },

    async getNote(noteId: string): Promise<GranolaNote> {
      return parseNote(await request(`/notes/${encodeURIComponent(noteId)}`));
    },
  };
}

export function granolaNoteHasSummary(note: GranolaNote): boolean {
  return Boolean(optionalString(note.summary_markdown) ?? optionalString(note.summary_text));
}

export function granolaNoteRevisionHash(note: GranolaNote): string {
  return createHash("sha256").update(JSON.stringify({
    summary: optionalString(note.summary_markdown) ?? optionalString(note.summary_text) ?? "",
    privateNotes: optionalString(note.private_notes_markdown) ??
      optionalString(note.private_notes_text) ?? "",
  })).digest("hex");
}

function boundedBody(content: string, sourceLine: string): string {
  const suffix = `\n\n${sourceLine}`;
  if (`${content}${suffix}`.length <= MAX_BODY_CHARACTERS) {
    return `${content}${suffix}`;
  }
  const truncatedSuffix = `\n\n${TRUNCATION_MARKER}${suffix}`;
  return `${content.slice(0, MAX_BODY_CHARACTERS - truncatedSuffix.length).trimEnd()}${truncatedSuffix}`;
}

export function granolaNoteToMeetingInput(note: GranolaNote): {
  messageId: string;
  threadId: string;
  detectedTool: "granola";
  subject: string;
  body: string;
  attendees: Array<{ name: string; email?: string }>;
  startAt?: string;
  endAt?: string;
  durationMinutes?: number;
  receivedAt: string;
  fragment: false;
  artifactUrl?: string;
} {
  const summary = optionalString(note.summary_markdown) ?? optionalString(note.summary_text);
  if (!summary) throw new Error(`Granola note ${note.id} has no complete summary.`);
  const privateNotes = optionalString(note.private_notes_markdown) ??
    optionalString(note.private_notes_text);
  const content = privateNotes
    ? `${summary}\n\n## Private notes\n\n${privateNotes}`
    : summary;
  const webUrl = requiredString(note.web_url, "web_url");
  const startAt = optionalString(note.calendar_event?.scheduled_start_time);
  const endAt = optionalString(note.calendar_event?.scheduled_end_time);
  const durationMinutes = startAt && endAt && Number.isFinite(Date.parse(startAt)) &&
      Number.isFinite(Date.parse(endAt))
    ? Math.max(0, Math.round((Date.parse(endAt) - Date.parse(startAt)) / 60_000))
    : undefined;
  const attendees = [...(note.attendees ?? []), ...(note.owner ? [note.owner] : [])]
    .flatMap((person) => {
      const email = optionalString(person.email);
      const name = optionalString(person.name) ?? email;
      return name ? [{ name, ...(email ? { email } : {}) }] : [];
    });
  return {
    messageId: `granola:${note.id}`,
    threadId: `granola:${note.id}`,
    detectedTool: "granola",
    subject: optionalString(note.title) ??
      optionalString(note.calendar_event?.event_title) ?? "Granola meeting",
    body: boundedBody(content, `Source: ${webUrl}`),
    attendees,
    ...(startAt ? { startAt } : {}),
    ...(endAt ? { endAt } : {}),
    ...(durationMinutes !== undefined ? { durationMinutes } : {}),
    receivedAt: startAt ?? note.created_at,
    fragment: false,
    artifactUrl: webUrl,
  };
}
