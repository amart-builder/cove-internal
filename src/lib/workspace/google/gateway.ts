/**
 * Fixed-capability Google Workspace gateway.
 *
 * Provider credentials stay behind this module. Callers receive typed methods
 * for the small set of reads and mutations Cove supports, not a generic Google
 * request primitive. Most importantly, the mail interface has no send, trash,
 * delete, forward, or settings method. Responses are size-bounded and parsed as
 * untrusted provider data before they reach product logic.
 */
import type {
  CalendarEvent,
  MailHeader,
  MailListPage,
  MailMessage,
  MailThread,
  ReadonlyCalendarGateway,
  ReadonlyDocumentsGateway,
  RestrictedMailGateway,
  WorkspaceGateway,
} from "../contracts";
import type { WorkspaceConfig } from "../config";
import { readWorkspaceConfig } from "../config";
import { WorkspaceGatewayError } from "../errors";
import { GoogleAccessTokenProvider } from "./auth";
import { buildReplyMime, buildSupportMime } from "./mime";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const DOCS_API = "https://docs.googleapis.com/v1/documents";
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

type Json = Record<string, unknown>;
type FetchLike = typeof fetch;

function boundedText(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function id(value: string, name: string): string {
  if (!/^[a-zA-Z0-9_-]{1,500}$/.test(value)) {
    throw new WorkspaceGatewayError({
      code: "invalid_input",
      operation: "validate_id",
      safeMessage: `${name} is invalid.`,
    });
  }
  return value;
}

function headersFrom(payload: unknown): MailHeader[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const rows = (payload as Json).headers;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as Json;
    return typeof row.name === "string" && typeof row.value === "string"
      ? [{ name: row.name.slice(0, 200), value: row.value.slice(0, 10_000) }]
      : [];
  });
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function bodyText(payload: unknown, depth = 0): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || depth > 12) {
    return "";
  }
  const row = payload as Json;
  const mimeType = typeof row.mimeType === "string" ? row.mimeType : "";
  const body = row.body && typeof row.body === "object" && !Array.isArray(row.body)
    ? row.body as Json
    : {};
  if (
    typeof body.data === "string" &&
    (mimeType === "text/plain" || (!mimeType && depth === 0))
  ) {
    return decodeBase64Url(body.data).slice(0, 200_000);
  }
  const parts = Array.isArray(row.parts) ? row.parts : [];
  const plain = parts.map((part) => bodyText(part, depth + 1)).filter(Boolean).join("\n");
  if (plain) return plain.slice(0, 200_000);
  if (typeof body.data === "string" && mimeType === "text/html") {
    return decodeBase64Url(body.data)
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200_000);
  }
  return "";
}

function normalizeMessage(value: unknown): MailMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceGatewayError({
      code: "provider_contract",
      operation: "normalize_message",
      safeMessage: "Google returned an invalid message.",
    });
  }
  const row = value as Json;
  return {
    id: id(boundedText(row.id, 500), "Message id"),
    threadId: id(boundedText(row.threadId, 500), "Thread id"),
    historyId: typeof row.historyId === "string" ? row.historyId : null,
    labelIds: Array.isArray(row.labelIds)
      ? row.labelIds.filter((entry): entry is string => typeof entry === "string").slice(0, 200)
      : [],
    internalDate: typeof row.internalDate === "string" ? row.internalDate : null,
    headers: headersFrom(row.payload),
    snippet: boundedText(row.snippet, 10_000),
    text: bodyText(row.payload),
  };
}

function header(message: MailMessage, name: string): string {
  return message.headers.find((entry) => entry.name.toLowerCase() === name.toLowerCase())
    ?.value ?? "";
}

function parseAddress(value: string): string {
  const bracket = /<([^<>\r\n]+@[^<>\r\n]+)>/.exec(value)?.[1];
  const address = (bracket ?? value).trim();
  if (!/^[^@\s\r\n]+@[^@\s\r\n]+\.[^@\s\r\n]+$/.test(address)) {
    throw new WorkspaceGatewayError({
      code: "provider_contract",
      operation: "build_reply",
      safeMessage: "The source email has no safe reply address.",
    });
  }
  return address;
}

function retryDelay(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : undefined;
}

function responseError(operation: string, response: Response): WorkspaceGatewayError {
  const requestId = response.headers.get("x-guploader-uploadid")
    ?? response.headers.get("x-request-id")
    ?? undefined;
  if (response.status === 401) {
    return new WorkspaceGatewayError({
      code: "auth_required",
      operation,
      safeMessage: "Google Workspace needs to be connected again.",
      httpStatus: response.status,
      providerRequestId: requestId,
    });
  }
  if (response.status === 403) {
    return new WorkspaceGatewayError({
      code: "forbidden",
      operation,
      safeMessage: "Google did not allow this Workspace operation.",
      httpStatus: response.status,
      providerRequestId: requestId,
    });
  }
  if (response.status === 404) {
    return new WorkspaceGatewayError({
      code: "not_found",
      operation,
      safeMessage: "The Google Workspace item no longer exists.",
      httpStatus: response.status,
      providerRequestId: requestId,
    });
  }
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  return new WorkspaceGatewayError({
    code: response.status === 429 ? "rate_limited" : retryable ? "transient" : "provider_contract",
    operation,
    safeMessage: retryable
      ? "Google Workspace was temporarily unavailable."
      : "Google rejected the Workspace operation.",
    retryable,
    httpStatus: response.status,
    retryAfterMs: retryDelay(response),
    providerRequestId: requestId,
  });
}

class GoogleTransport {
  readonly #tokens: GoogleAccessTokenProvider;
  readonly #fetcher: FetchLike;

  constructor(
    tokens: GoogleAccessTokenProvider,
    fetcher: FetchLike,
  ) {
    this.#tokens = tokens;
    this.#fetcher = fetcher;
  }

  async json(
    operation: string,
    url: string,
    init: RequestInit = {},
    options: { idempotent?: boolean; uncertainWrite?: boolean } = {},
  ): Promise<Json> {
    const attempts = options.idempotent ? 3 : 1;
    let refreshed = false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const accessToken = await this.#tokens.getAccessToken();
        const response = await this.#fetcher(url, {
          ...init,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`,
            ...(init.body ? { "Content-Type": "application/json" } : {}),
            ...init.headers,
          },
          signal: init.signal ?? AbortSignal.timeout(30_000),
        });
        if (response.status === 401 && !refreshed) {
          refreshed = true;
          this.#tokens.invalidate();
          attempt -= 1;
          continue;
        }
        if (!response.ok) {
          const error = responseError(operation, response);
          if (options.uncertainWrite && error.retryable) {
            throw new WorkspaceGatewayError({
              code: "unknown_write_outcome",
              operation,
              safeMessage: "Google may have received the draft. Cove will inspect before retrying.",
              httpStatus: error.httpStatus,
              retryAfterMs: error.retryAfterMs,
              providerRequestId: error.providerRequestId,
              cause: error,
            });
          }
          if (error.retryable && attempt + 1 < attempts) continue;
          throw error;
        }
        const size = Number(response.headers.get("content-length"));
        if (Number.isFinite(size) && size > MAX_RESPONSE_BYTES) {
          throw new WorkspaceGatewayError({
            code: "provider_contract",
            operation,
            safeMessage: "Google returned more data than Cove can safely process.",
          });
        }
        const text = await response.text();
        if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
          throw new WorkspaceGatewayError({
            code: "provider_contract",
            operation,
            safeMessage: "Google returned more data than Cove can safely process.",
          });
        }
        return text ? JSON.parse(text) as Json : {};
      } catch (error) {
        if (error instanceof WorkspaceGatewayError) throw error;
        if (options.uncertainWrite) {
          throw new WorkspaceGatewayError({
            code: "unknown_write_outcome",
            operation,
            safeMessage: "Google may have received the draft. Cove will inspect before retrying.",
            cause: error,
          });
        }
        if (attempt + 1 >= attempts) {
          throw new WorkspaceGatewayError({
            code: "transient",
            operation,
            safeMessage: "Google Workspace was temporarily unavailable.",
            retryable: true,
            cause: error,
          });
        }
      }
    }
    throw new WorkspaceGatewayError({
      code: "transient",
      operation,
      safeMessage: "Google Workspace was temporarily unavailable.",
      retryable: true,
    });
  }
}

class GoogleMailGateway implements RestrictedMailGateway {
  #labelIds?: Map<string, string>;
  #verifiedAccount?: Promise<void>;
  readonly #supportRecipients: ReadonlySet<string>;
  readonly #transport: GoogleTransport;

  constructor(
    readonly accountEmail: string,
    supportRecipients: ReadonlySet<string>,
    transport: GoogleTransport,
  ) {
    this.#supportRecipients = supportRecipients;
    this.#transport = transport;
  }

  private async verifyAccount(): Promise<void> {
    if (!this.#verifiedAccount) {
      this.#verifiedAccount = (async () => {
        const row = await this.#transport.json(
          "gmail_profile",
          `${GMAIL_API}/profile`,
          {},
          { idempotent: true },
        );
        const emailAddress = boundedText(row.emailAddress, 500).toLowerCase();
        if (emailAddress !== this.accountEmail) {
          throw new WorkspaceGatewayError({
            code: "auth_required",
            operation: "gmail_profile",
            safeMessage: "Connected Gmail account does not match Cove configuration.",
          });
        }
      })();
    }
    await this.#verifiedAccount;
  }

  async getProfile(): Promise<{ emailAddress: string }> {
    await this.verifyAccount();
    return { emailAddress: this.accountEmail };
  }

  async listMessages(input: {
    query: string;
    pageToken?: string;
    maxResults?: number;
  }): Promise<MailListPage> {
    await this.verifyAccount();
    if (!input.query.trim() || input.query.length > 2_000) {
      throw new WorkspaceGatewayError({
        code: "invalid_input",
        operation: "gmail_list_messages",
        safeMessage: "Gmail query is invalid.",
      });
    }
    const params = new URLSearchParams({
      q: input.query,
      maxResults: String(Math.min(Math.max(input.maxResults ?? 100, 1), 500)),
      ...(input.pageToken ? { pageToken: input.pageToken } : {}),
    });
    const page = await this.#transport.json(
      "gmail_list_messages",
      `${GMAIL_API}/messages?${params}`,
      {},
      { idempotent: true },
    );
    const messages = Array.isArray(page.messages) ? page.messages : [];
    return {
      messages: messages.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const item = value as Json;
        return [{ id: id(boundedText(item.id, 500), "Message id"), threadId: id(boundedText(item.threadId, 500), "Thread id") }];
      }),
      ...(typeof page.nextPageToken === "string" ? { nextPageToken: page.nextPageToken } : {}),
    };
  }

  async getMessage(input: {
    messageId: string;
    format?: "metadata" | "full";
  }): Promise<MailMessage> {
    await this.verifyAccount();
    const params = new URLSearchParams({ format: input.format ?? "full" });
    const row = await this.#transport.json(
      "gmail_get_message",
      `${GMAIL_API}/messages/${id(input.messageId, "Message id")}?${params}`,
      {},
      { idempotent: true },
    );
    return normalizeMessage(row);
  }

  async getThread(input: {
    threadId: string;
    format?: "metadata" | "full";
  }): Promise<MailThread> {
    await this.verifyAccount();
    const params = new URLSearchParams({ format: input.format ?? "full" });
    const row = await this.#transport.json(
      "gmail_get_thread",
      `${GMAIL_API}/threads/${id(input.threadId, "Thread id")}?${params}`,
      {},
      { idempotent: true },
    );
    return {
      id: id(boundedText(row.id, 500), "Thread id"),
      historyId: typeof row.historyId === "string" ? row.historyId : null,
      messages: (Array.isArray(row.messages) ? row.messages : []).map(normalizeMessage),
    };
  }

  async getAttachment(input: {
    messageId: string;
    attachmentId: string;
    maxBytes?: number;
  }): Promise<Uint8Array> {
    await this.verifyAccount();
    const row = await this.#transport.json(
      "gmail_get_attachment",
      `${GMAIL_API}/messages/${id(input.messageId, "Message id")}/attachments/${id(input.attachmentId, "Attachment id")}`,
      {},
      { idempotent: true },
    );
    if (typeof row.data !== "string") {
      throw new WorkspaceGatewayError({
        code: "provider_contract",
        operation: "gmail_get_attachment",
        safeMessage: "Google returned an invalid attachment.",
      });
    }
    const data = Buffer.from(row.data, "base64url");
    if (data.length > Math.min(input.maxBytes ?? 10 * 1024 * 1024, 20 * 1024 * 1024)) {
      throw new WorkspaceGatewayError({
        code: "invalid_input",
        operation: "gmail_get_attachment",
        safeMessage: "Attachment is too large.",
      });
    }
    return data;
  }

  async listDrafts(input: { pageToken?: string; maxResults?: number } = {}): Promise<{
    drafts: Array<{ id: string; messageId: string; threadId: string }>;
    nextPageToken?: string;
  }> {
    await this.verifyAccount();
    const params = new URLSearchParams({
      maxResults: String(Math.min(Math.max(input.maxResults ?? 100, 1), 500)),
      ...(input.pageToken ? { pageToken: input.pageToken } : {}),
    });
    const row = await this.#transport.json(
      "gmail_list_drafts",
      `${GMAIL_API}/drafts?${params}`,
      {},
      { idempotent: true },
    );
    const drafts = Array.isArray(row.drafts) ? row.drafts : [];
    return {
      drafts: drafts.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const draft = value as Json;
        const message = draft.message && typeof draft.message === "object" && !Array.isArray(draft.message)
          ? draft.message as Json
          : {};
        return [{
          id: id(boundedText(draft.id, 500), "Draft id"),
          messageId: id(boundedText(message.id, 500), "Message id"),
          threadId: id(boundedText(message.threadId, 500), "Thread id"),
        }];
      }),
      ...(typeof row.nextPageToken === "string" ? { nextPageToken: row.nextPageToken } : {}),
    };
  }

  private async labels(): Promise<Map<string, string>> {
    if (this.#labelIds) return this.#labelIds;
    const row = await this.#transport.json(
      "gmail_list_labels",
      `${GMAIL_API}/labels`,
      {},
      { idempotent: true },
    );
    const labels = new Map<string, string>([["INBOX", "INBOX"]]);
    for (const value of Array.isArray(row.labels) ? row.labels : []) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const label = value as Json;
      if (typeof label.name === "string" && typeof label.id === "string") {
        labels.set(label.name, label.id);
      }
    }
    this.#labelIds = labels;
    return labels;
  }

  async ensureCoveLabel(input: { name: string }): Promise<{ id: string; name: string }> {
    if (input.name !== "Cove/Triaged" && input.name !== "Cove/Meeting-Processed") {
      throw new WorkspaceGatewayError({
        code: "unsafe_operation",
        operation: "gmail_ensure_label",
        safeMessage: "Cove cannot create workflow or free-form Gmail labels.",
      });
    }
    await this.verifyAccount();
    const labels = await this.labels();
    const existing = labels.get(input.name);
    if (existing) return { id: existing, name: input.name };
    const row = await this.#transport.json(
      "gmail_create_label",
      `${GMAIL_API}/labels`,
      {
        method: "POST",
        body: JSON.stringify({
          name: input.name,
          labelListVisibility: "labelShow",
          messageListVisibility: "show",
        }),
      },
      { uncertainWrite: true },
    );
    const labelId = id(boundedText(row.id, 500), "Label id");
    labels.set(input.name, labelId);
    return { id: labelId, name: input.name };
  }

  async modifyThreadLabels(input: {
    threadId: string;
    addNames?: string[];
    removeNames?: string[];
  }): Promise<void> {
    const addNames = [...new Set(input.addNames ?? [])];
    const removeNames = [...new Set(input.removeNames ?? [])];
    if (addNames.some((name) => name !== "Cove/Triaged" && name !== "Cove/Meeting-Processed")) {
      throw new WorkspaceGatewayError({
        code: "unsafe_operation",
        operation: "gmail_modify_labels",
        safeMessage: "Cove cannot add workflow or free-form Gmail labels.",
      });
    }
    await this.verifyAccount();
    if (removeNames.some((name) =>
      name !== "INBOX" &&
      name !== "Cove/Triaged" &&
      name !== "Cove/Meeting-Processed" &&
      !["Cove/Reply", "Cove/Action", "Cove/FYI", "Cove/Archived", "Cove/Done"].includes(name)
    )) {
      throw new WorkspaceGatewayError({
        code: "unsafe_operation",
        operation: "gmail_modify_labels",
        safeMessage: "Cove cannot remove that Gmail label.",
      });
    }
    const labels = await this.labels();
    const resolve = async (name: string): Promise<string> => {
      if (name === "INBOX") return "INBOX";
      return labels.get(name) ?? (await this.ensureCoveLabel({ name })).id;
    };
    const addLabelIds = await Promise.all(addNames.map(resolve));
    const removeLabelIds = removeNames
      .map((name) => labels.get(name) ?? (name === "INBOX" ? "INBOX" : undefined))
      .filter((value): value is string => Boolean(value));
    await this.#transport.json(
      "gmail_modify_labels",
      `${GMAIL_API}/threads/${id(input.threadId, "Thread id")}/modify`,
      {
        method: "POST",
        body: JSON.stringify({ addLabelIds, removeLabelIds }),
      },
      { idempotent: true },
    );
  }

  async archiveMessages(input: { messageIds: string[] }): Promise<void> {
    await this.verifyAccount();
    const messageIds = [...new Set(input.messageIds)];
    if (messageIds.length === 0 || messageIds.length > 100) {
      throw new WorkspaceGatewayError({
        code: "invalid_input",
        operation: "gmail_archive_messages",
        safeMessage: "Gmail archive target is invalid.",
      });
    }
    for (const messageId of messageIds) {
      await this.#transport.json(
        "gmail_archive_message",
        `${GMAIL_API}/messages/${id(messageId, "Message id")}/modify`,
        {
          method: "POST",
          body: JSON.stringify({ addLabelIds: [], removeLabelIds: ["INBOX"] }),
        },
        { idempotent: true },
      );
    }
  }

  private async replyRaw(input: {
    sourceMessageId: string;
    body: string;
    htmlBody?: string;
    idempotencyKey: string;
  }): Promise<string> {
    const source = await this.getMessage({ messageId: input.sourceMessageId, format: "metadata" });
    const messageId = header(source, "Message-ID");
    return buildReplyMime({
      to: parseAddress(header(source, "Reply-To") || header(source, "From")),
      subject: header(source, "Subject") || "(no subject)",
      body: input.body,
      htmlBody: input.htmlBody,
      inReplyTo: messageId,
      references: (header(source, "References").match(/<[^<>]+>/g) ?? []),
      idempotencyKey: input.idempotencyKey,
      accountEmail: this.accountEmail,
    });
  }

  async createReplyDraft(input: {
    threadId: string;
    sourceMessageId: string;
    body: string;
    htmlBody?: string;
    idempotencyKey: string;
    existingDraftId?: string;
  }): Promise<{ id: string; messageId: string; threadId: string }> {
    await this.verifyAccount();
    const raw = await this.replyRaw(input);
    const row = await this.#transport.json(
      "gmail_create_reply_draft",
      input.existingDraftId
        ? `${GMAIL_API}/drafts/${id(input.existingDraftId, "Draft id")}`
        : `${GMAIL_API}/drafts`,
      {
        method: input.existingDraftId ? "PUT" : "POST",
        body: JSON.stringify({ message: { threadId: id(input.threadId, "Thread id"), raw } }),
      },
      { uncertainWrite: true },
    );
    return this.normalizeDraft(row);
  }

  async createSupportDraft(input: {
    recipient: string;
    subject: string;
    body: string;
    idempotencyKey: string;
  }): Promise<{ id: string; messageId: string }> {
    await this.verifyAccount();
    const recipient = input.recipient.toLowerCase();
    if (!this.#supportRecipients.has(recipient)) {
      throw new WorkspaceGatewayError({
        code: "unsafe_operation",
        operation: "gmail_create_support_draft",
        safeMessage: "That support recipient is not allowlisted.",
      });
    }
    const raw = buildSupportMime({
      to: recipient,
      subject: input.subject,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
      accountEmail: this.accountEmail,
    });
    const row = await this.#transport.json(
      "gmail_create_support_draft",
      `${GMAIL_API}/drafts`,
      { method: "POST", body: JSON.stringify({ message: { raw } }) },
      { uncertainWrite: true },
    );
    const draft = this.normalizeDraft(row);
    return { id: draft.id, messageId: draft.messageId };
  }

  private normalizeDraft(row: Json): { id: string; messageId: string; threadId: string } {
    const message = row.message && typeof row.message === "object" && !Array.isArray(row.message)
      ? row.message as Json
      : {};
    return {
      id: id(boundedText(row.id, 500), "Draft id"),
      messageId: id(boundedText(message.id, 500), "Message id"),
      threadId: id(boundedText(message.threadId, 500), "Thread id"),
    };
  }
}

class GoogleCalendarGateway implements ReadonlyCalendarGateway {
  readonly #transport: GoogleTransport;
  readonly #verifyIdentity: () => Promise<unknown>;

  constructor(
    transport: GoogleTransport,
    verifyIdentity: () => Promise<unknown>,
  ) {
    this.#transport = transport;
    this.#verifyIdentity = verifyIdentity;
  }

  async listEvents(input: {
    timeMin: string;
    timeMax: string;
    timeZone: string;
    maxResults?: number;
  }): Promise<CalendarEvent[]> {
    await this.#verifyIdentity();
    const min = new Date(input.timeMin);
    const max = new Date(input.timeMax);
    if (!Number.isFinite(min.getTime()) || !Number.isFinite(max.getTime()) || min >= max) {
      throw new WorkspaceGatewayError({
        code: "invalid_input",
        operation: "calendar_list_events",
        safeMessage: "Calendar time range is invalid.",
      });
    }
    const params = new URLSearchParams({
      timeMin: min.toISOString(),
      timeMax: max.toISOString(),
      timeZone: input.timeZone.slice(0, 100),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(Math.min(Math.max(input.maxResults ?? 100, 1), 250)),
    });
    const row = await this.#transport.json(
      "calendar_list_events",
      `${CALENDAR_API}?${params}`,
      {},
      { idempotent: true },
    );
    if (row.nextPageToken) throw new WorkspaceGatewayError({
      code: "provider_contract", operation: "calendar_list_events",
      safeMessage: "Calendar returned more events than this bounded check can cover.",
    });
    return (Array.isArray(row.items) ? row.items : []).flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const event = value as Json;
      const start = event.start && typeof event.start === "object" && !Array.isArray(event.start)
        ? event.start as Json
        : {};
      const end = event.end && typeof event.end === "object" && !Array.isArray(event.end)
        ? event.end as Json
        : {};
      const conferenceData =
        event.conferenceData &&
        typeof event.conferenceData === "object" &&
        !Array.isArray(event.conferenceData)
          ? event.conferenceData as Json
          : {};
      const conferenceEntryPoints = Array.isArray(conferenceData.entryPoints)
        ? conferenceData.entryPoints
        : [];
      const meetingUrl = boundedText(event.hangoutLink, 2_000) ||
        conferenceEntryPoints.flatMap((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
          const item = entry as Json;
          return item.entryPointType === "video" && typeof item.uri === "string"
            ? [item.uri.slice(0, 2_000)]
            : [];
        })[0] ||
        "";
      return [{
        id: boundedText(event.id, 500),
        status: boundedText(event.status, 100),
        summary: boundedText(event.summary, 2_000),
        description: boundedText(event.description, 20_000),
        location: boundedText(event.location, 2_000),
        htmlLink: boundedText(event.htmlLink, 2_000),
        meetingUrl,
        start: boundedText(start.dateTime ?? start.date, 100),
        end: boundedText(end.dateTime ?? end.date, 100),
        attendees: (Array.isArray(event.attendees) ? event.attendees : []).flatMap((attendee) => {
          if (!attendee || typeof attendee !== "object" || Array.isArray(attendee)) return [];
          const item = attendee as Json;
          if (typeof item.email !== "string") return [];
          return [{
            email: item.email.slice(0, 500),
            ...(typeof item.displayName === "string" ? { displayName: item.displayName.slice(0, 500) } : {}),
            ...(typeof item.responseStatus === "string" ? { responseStatus: item.responseStatus.slice(0, 100) } : {}),
            ...(typeof item.self === "boolean" ? { self: item.self } : {}),
          }];
        }),
      }];
    });
  }
}

function flattenDoc(value: unknown, output: string[], depth = 0): void {
  if (!value || typeof value !== "object" || depth > 24) return;
  if (Array.isArray(value)) {
    for (const item of value) flattenDoc(item, output, depth + 1);
    return;
  }
  const row = value as Json;
  if (row.textRun && typeof row.textRun === "object" && !Array.isArray(row.textRun)) {
    const content = (row.textRun as Json).content;
    if (typeof content === "string") output.push(content);
  }
  for (const [key, item] of Object.entries(row)) {
    if (key !== "textRun") flattenDoc(item, output, depth + 1);
  }
}

class GoogleDocumentsGateway implements ReadonlyDocumentsGateway {
  readonly #transport: GoogleTransport;
  readonly #verifyIdentity: () => Promise<unknown>;

  constructor(
    transport: GoogleTransport,
    verifyIdentity: () => Promise<unknown>,
  ) {
    this.#transport = transport;
    this.#verifyIdentity = verifyIdentity;
  }

  async getDocumentPlainText(input: {
    documentId: string;
    maxChars?: number;
  }): Promise<string> {
    await this.#verifyIdentity();
    const maxChars = Math.min(Math.max(input.maxChars ?? 200_000, 1), 500_000);
    const row = await this.#transport.json(
      "documents_get",
      `${DOCS_API}/${id(input.documentId, "Document id")}?includeTabsContent=true`,
      {},
      { idempotent: true },
    );
    const output: string[] = [];
    flattenDoc(row, output);
    return output.join("").slice(0, maxChars);
  }
}

export function createGoogleWorkspaceGateway(options: {
  dataDir?: string;
  config?: WorkspaceConfig;
  fetch?: FetchLike;
  tokenProvider?: GoogleAccessTokenProvider;
} = {}): WorkspaceGateway {
  const config = options.config ?? readWorkspaceConfig(options.dataDir);
  const fetcher = options.fetch ?? fetch;
  const tokens = options.tokenProvider ?? new GoogleAccessTokenProvider(config, { fetch: fetcher });
  const transport = new GoogleTransport(tokens, fetcher);
  const mail = new GoogleMailGateway(
    config.accountEmail,
    new Set(config.supportDraftRecipients),
    transport,
  );
  const verifyIdentity = () => mail.getProfile();
  return {
    mail,
    ...(config.capabilities.calendar
      ? { calendar: new GoogleCalendarGateway(transport, verifyIdentity) }
      : {}),
    ...(config.capabilities.documents
      ? { documents: new GoogleDocumentsGateway(transport, verifyIdentity) }
      : {}),
  };
}
