import { createHash } from "node:crypto";
import {
  createCRMBackend,
  type CRMBackend,
} from "../crm";
import { normalizeContactName } from "../crm/identity";
import { recordFailure, resolveFailure } from "../reliability/failures";
import {
  extractMeetingFollowUps,
  inboundAckState,
  isOperatorOwned,
  meetingFollowUpText,
} from "./meeting-followups.mjs";
import { recordEvent, resolveEvent } from "./inbox";
import { runForgeIntake } from "./run";
import {
  claimMessageIngestion,
  completeMessageIngestion,
  failMessageIngestion,
  renewMessageIngestionLease,
  type IngestionDoor,
} from "./message-ingestion";

export type MeetingFollowUp = {
  owner: string;
  title: string;
  detail: string;
};

export type MeetingNotesEmail = {
  messageId: string;
  threadId: string;
  sender?: string;
  subject: string;
  body: string;
  detectedTool: string;
  receivedAt?: string;
};

type AckResult = {
  kind: "task" | "waiting_on";
  ack: "db" | "spooled";
};

type EventReceipt = {
  event: { id: string; spooled?: boolean };
  spooled?: boolean;
  exitCode?: number;
  error?: string;
};

export type MeetingPipelineOptions = {
  sourceDoor: IngestionDoor;
  dbPath?: string;
  dataDir?: string;
  repoDir?: string;
  baseUrl: string;
  machine?: string;
  now?: () => Date;
  leaseMs?: number;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  fetchTimeoutMs?: number;
  crmBackend?: CRMBackend;
  extractFollowUps?: (
    body: string,
    options?: Record<string, unknown>,
  ) => Promise<MeetingFollowUp[]>;
  isOperatorOwnedImpl?: (owner: string) => boolean;
  runIntakeImpl?: typeof runForgeIntake;
  recordEventImpl?: typeof recordEvent;
  resolveEventImpl?: typeof resolveEvent;
  writeCommitmentImpl?: typeof writeWaitingCommitment;
  afterClaim?: () => void | Promise<void>;
};

export type MeetingPipelineResult = {
  status: "processed" | "skipped";
  reason?: "already-processed" | "already-failed" | "lease-active";
  summary: {
    tasks: number;
    waitingOn: number;
    contactsLinked: number;
    contactsCreated: number;
    contactsAmbiguous: number;
    contactFailures: number;
    parsedItems: number;
  };
  receiptId?: string;
};

function deterministicUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${
    ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  }${hex.slice(17, 20)}-${hex.slice(20)}`;
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
  if (typeof token !== "string" || !token) {
    throw new Error("day_plan_token_missing");
  }
  return token;
}

export async function writeWaitingCommitment(
  item: MeetingFollowUp,
  context: {
    sourceId: string;
    meetingTitle: string;
    baseUrl: string;
    contactId?: string | null;
  },
  options: {
    fetchImpl?: typeof fetch;
    fetchTimeoutMs?: number;
  } = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.fetchTimeoutMs ?? 10_000;
  const id = deterministicUuid(`meeting-waiting:${context.sourceId}`);
  const lookup = await fetchImpl(
    `${context.baseUrl}/api/forge-rest/commitments?select=id,contact_id&id=eq.${encodeURIComponent(id)}&limit=1`,
    { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" },
  );
  if (!lookup.ok) {
    throw new Error(`forge-rest commitments lookup ${lookup.status}`);
  }
  const rows = await lookup.json() as unknown;
  const existing = Array.isArray(rows) &&
      rows[0] &&
      typeof rows[0] === "object" &&
      !Array.isArray(rows[0])
    ? rows[0] as Record<string, unknown>
    : undefined;
  if (existing) {
    if (context.contactId && !existing.contact_id) {
      const token = await csrfToken(fetchImpl, context.baseUrl, timeoutMs);
      const updated = await fetchImpl(
        `${context.baseUrl}/api/forge-rest/commitments?id=eq.${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Forge-CSRF": token,
          },
          body: JSON.stringify({ contact_id: context.contactId }),
          signal: AbortSignal.timeout(timeoutMs),
          cache: "no-store",
        },
      );
      if (!updated.ok) {
        throw new Error(
          `forge-rest commitments contact link ${updated.status}`,
        );
      }
    }
    return id;
  }
  const token = await csrfToken(fetchImpl, context.baseUrl, timeoutMs);
  const response = await fetchImpl(
    `${context.baseUrl}/api/forge-rest/commitments`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forge-CSRF": token,
      },
      body: JSON.stringify({
        id,
        kind: "waiting_on",
        title: item.title,
        details: [
          item.detail,
          context.meetingTitle ? `Meeting: ${context.meetingTitle}` : "",
        ].filter(Boolean).join("\n") || null,
        counterparty: item.owner,
        contact_id: context.contactId ?? null,
        source_kind: "detector",
        source_quote: null,
        source_ref: `gmail:${context.sourceId}`,
        due_at: null,
        review_at: null,
        confidence: "high",
        confirmed: false,
        status: "open",
        evidence: null,
      }),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    },
  );
  if (!response.ok) {
    const body = await response.text();
    const retry = await fetchImpl(
      `${context.baseUrl}/api/forge-rest/commitments?select=id&id=eq.${encodeURIComponent(id)}&limit=1`,
      { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" },
    );
    if (retry.ok && ((await retry.json() as unknown[])?.length ?? 0) > 0) {
      return id;
    }
    throw new Error(
      `forge-rest commitments ${response.status}: ${body.slice(0, 300)}`,
    );
  }
  return id;
}

async function acknowledgeMeetingItem(
  item: MeetingFollowUp,
  context: {
    sourceId: string;
    meetingTitle: string;
    baseUrl: string;
    contactId?: string | null;
  },
  options: MeetingPipelineOptions,
): Promise<AckResult> {
  const text = meetingFollowUpText(item, context.meetingTitle);
  const owns = options.isOperatorOwnedImpl ?? isOperatorOwned;
  if (owns(item.owner)) {
    const result = await (options.runIntakeImpl ?? runForgeIntake)(
      {
        text,
        source: "meeting",
        sourceId: context.sourceId,
      },
      {
        repoDir: options.repoDir,
        dataDir: options.dataDir,
        fetchImpl: options.fetchImpl,
        webBaseUrl: context.baseUrl,
      },
    ) as EventReceipt;
    const state = inboundAckState(result);
    if (result.exitCode !== 0 || state === "failed") {
      throw new Error(
        result.error ?? "Meeting intake did not acknowledge the event.",
      );
    }
    return { kind: "task", ack: state };
  }

  const receipt = await (options.recordEventImpl ?? recordEvent)(
    {
      source: "meeting",
      sourceId: context.sourceId,
      rawText: text,
      machine: options.machine,
    },
    { dataDir: options.dataDir },
  ) as EventReceipt;
  const state = inboundAckState(receipt);
  if (state === "failed") {
    throw new Error("Meeting intake could not write the database or spool.");
  }
  await (options.writeCommitmentImpl ?? writeWaitingCommitment)(
    item,
    context,
    {
      fetchImpl: options.fetchImpl,
      fetchTimeoutMs: options.fetchTimeoutMs,
    },
  );
  if (state === "db") {
    await (options.resolveEventImpl ?? resolveEvent)(
      receipt.event.id,
      { state: "triaged" },
    );
  }
  return { kind: "waiting_on", ack: state };
}

function personKey(name: string): string {
  return normalizeContactName(name) ||
    createHash("sha256").update(name).digest("hex").slice(0, 20);
}

function meetingItemKey(item: MeetingFollowUp): string {
  const content = [item.owner, item.title, item.detail]
    .map((value) => value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase())
    .join("\u0000");
  return createHash("sha256").update(content).digest("hex").slice(0, 24);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export async function processMeetingNotesEmail(
  email: MeetingNotesEmail,
  options: MeetingPipelineOptions,
): Promise<MeetingPipelineResult> {
  const now = options.now ?? (() => new Date());
  const started = now();
  const startedAt = started.toISOString();
  const claim = claimMessageIngestion({
    messageId: email.messageId,
    threadId: email.threadId,
    sourceDoor: options.sourceDoor,
    detectedTool: email.detectedTool,
    dbPath: options.dbPath,
    now: started,
    leaseMs: options.leaseMs,
  });
  const emptySummary = {
    tasks: 0,
    waitingOn: 0,
    contactsLinked: 0,
    contactsCreated: 0,
    contactsAmbiguous: 0,
    contactFailures: 0,
    parsedItems: 0,
  };
  if (!claim.claimed) {
    return {
      status: "skipped",
      reason: claim.reason,
      summary: emptySummary,
      receiptId: claim.row.receiptId ?? undefined,
    };
  }

  let crm = options.crmBackend;
  let ownsCRM = false;
  const leaseMs = Math.max(10_000, options.leaseMs ?? 5 * 60_000);
  const leaseHeartbeat = setInterval(() => {
    try {
      renewMessageIngestionLease({
        messageId: email.messageId,
        leaseToken: claim.leaseToken,
        dbPath: options.dbPath,
        now: now(),
        leaseMs,
      });
    } catch {
      // Completion still verifies the token. A transient renewal failure can
      // recover on the next pulse without hiding a lost lease.
    }
  }, Math.max(5_000, Math.floor(leaseMs / 3)));
  leaseHeartbeat.unref();
  try {
    await options.afterClaim?.();
    const items = await (options.extractFollowUps ?? extractMeetingFollowUps)(
      email.body,
      { repoDir: options.repoDir },
    );
    if (!Array.isArray(items)) {
      throw new Error("Meeting parser returned an invalid result.");
    }
    const summary = { ...emptySummary, parsedItems: items.length };
    const contactIds = new Map<string, string | null>();
    const uniquePeople = new Map<string, string>();
    for (const item of items) {
      const owner = item.owner.trim();
      if (owner) uniquePeople.set(personKey(owner), owner);
    }

    crm ??= createCRMBackend({
      dataDir: options.dataDir,
      dbPath: options.dbPath,
      now,
    });
    ownsCRM = !options.crmBackend;
    for (const [key, name] of uniquePeople) {
      const failureSourceId = `${email.messageId}:contact:${key}`.slice(0, 240);
      try {
        const resolution = crm.resolveAndAppendMeetingActivity({
          contact: { name },
          sourceRef: `gmail:${email.messageId}:contact:${key}`,
          title: email.subject || `${email.detectedTool} meeting notes`,
          content: email.body.slice(0, 20_000),
          occurredAt: email.receivedAt,
          metadata: {
            gmailMessageId: email.messageId,
            gmailThreadId: email.threadId,
            detectedTool: email.detectedTool,
          },
        });
        if (resolution.status === "ambiguous") {
          contactIds.set(key, null);
          summary.contactsAmbiguous += 1;
          recordFailure({
            dbPath: options.dbPath,
            source: "meeting-contact-resolution",
            sourceId: failureSourceId,
            message: `Meeting contact "${name}" is ambiguous.`,
            details: {
              messageId: email.messageId,
              name,
              candidates: resolution.candidates,
            },
            occurredAt: now().toISOString(),
          });
          continue;
        }
        contactIds.set(key, resolution.contactId);
        if (resolution.status === "created") summary.contactsCreated += 1;
        else summary.contactsLinked += 1;
        resolveFailure(
          "meeting-contact-resolution",
          failureSourceId,
          { dbPath: options.dbPath, resolvedAt: now().toISOString() },
        );
      } catch (error) {
        contactIds.set(key, null);
        summary.contactFailures += 1;
        recordFailure({
          dbPath: options.dbPath,
          source: "meeting-contact-resolution",
          sourceId: failureSourceId,
          message: `Meeting contact "${name}" could not be linked.`,
          details: {
            messageId: email.messageId,
            name,
            error: error instanceof Error ? error.message : String(error),
          },
          occurredAt: now().toISOString(),
        });
      }
    }

    for (const item of items) {
      const result = await acknowledgeMeetingItem(
        item,
        {
          sourceId: `${email.messageId}:${meetingItemKey(item)}`,
          meetingTitle: email.subject,
          baseUrl: options.baseUrl,
          contactId: contactIds.get(personKey(item.owner)) ?? null,
        },
        options,
      );
      if (result.kind === "task") summary.tasks += 1;
      else summary.waitingOn += 1;
    }

    const linkedOrCreated = summary.contactsLinked + summary.contactsCreated;
    const outcome =
      summary.contactsAmbiguous > 0 || summary.contactFailures > 0
        ? "partial"
        : "success";
    const source = email.sender?.trim() || email.subject || email.detectedTool;
    const receiptSummary =
      `Found ${email.detectedTool} meeting notes from ${source}: ` +
      `${plural(summary.tasks, "task")}, ` +
      `${plural(summary.waitingOn, "waiting-on")}, ` +
      `${plural(linkedOrCreated, "contact")} linked/created, ` +
      `${plural(summary.contactsAmbiguous, "ambiguous contact")}.`;
    const completed = completeMessageIngestion({
      messageId: email.messageId,
      leaseToken: claim.leaseToken,
      startedAt,
      summary: receiptSummary,
      actions: {
        messageId: email.messageId,
        threadId: email.threadId,
        sourceDoor: options.sourceDoor,
        detectedTool: email.detectedTool,
        ...summary,
      },
      outcome,
      attempts: claim.attempts,
      dbPath: options.dbPath,
      now: now(),
    });
    return {
      status: "processed",
      summary,
      receiptId: completed.receiptId ?? undefined,
    };
  } catch (error) {
    failMessageIngestion({
      messageId: email.messageId,
      leaseToken: claim.leaseToken,
      startedAt,
      attempts: claim.attempts,
      error,
      maxAttempts: options.maxAttempts,
      dbPath: options.dbPath,
      now: now(),
    });
    throw error;
  } finally {
    clearInterval(leaseHeartbeat);
    if (ownsCRM) crm?.close();
  }
}
