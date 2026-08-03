import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { createCRMBackend } from "../crm";
import type { Contact, ContactActivity } from "../data/types";
import { openLocalDatabase } from "../local/database";
import { recordFailure, resolveFailure } from "../reliability/failures";
import { JobScheduler } from "../reliability/jobs";
import {
  recordReceipt,
  recordReceiptInDatabase,
  type Receipt,
} from "../reliability/receipts";
import type { RestrictedMailGateway } from "../workspace";
import { createGoogleWorkspaceGateway, safeWorkspaceFailure } from "../workspace";
import { createGmailOperationHandler } from "./gmail-outbox";
import { requestEmailCompletion } from "./state-machine";

const ARCHIVE_CLAIM_TIMEOUT_MS = 5 * 60 * 1_000;

type EmailItemRow = {
  id: string;
  thread_id: string | null;
  status: string;
  sender_name: string | null;
  sender_email: string | null;
  subject: string | null;
  message_id?: string | null;
  bucket?: string | null;
  source_payload: string | null;
};

export type GmailThreadObservation = {
  emailItemId: string;
  threadId: string;
  inInbox: boolean;
  userReplied: boolean;
  inboxMessageIds?: string[];
};

export type EmailCommitmentInput = {
  threadId: string;
  kind: "follow_up" | "waiting_on";
  title: string;
  sourceQuote: string;
  threadLink: string;
  counterparty?: string;
  dueAt?: string | null;
  contactId?: string | null;
};

export type EmailCRMContext = {
  status: "matched" | "not_found" | "ambiguous";
  contact: Contact | null;
  activities: ContactActivity[];
  waitingOn: Array<{
    id: string;
    title: string;
    details: string | null;
    dueAt: string | null;
  }>;
  candidates?: unknown[];
};

function nowIso(now: Date | (() => Date) | undefined): string {
  const date = typeof now === "function" ? now() : now ?? new Date();
  return date.toISOString();
}

function nowProvider(now: Date | (() => Date) | undefined): () => Date {
  if (typeof now === "function") return now;
  if (now) return () => now;
  return () => new Date();
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Preserve a malformed legacy payload as no metadata.
    }
  }
  return {};
}

function deterministicUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${
    ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  }${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function normalizedQuote(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function requireText(value: string, name: string, max: number): string {
  const result = value.trim();
  if (!result) throw new Error(`${name} is required.`);
  if (result.length > max) throw new Error(`${name} is too long.`);
  return result;
}

function emailRow(db: Database.Database, id: string): EmailItemRow | undefined {
  return db.prepare(
    `SELECT id, thread_id, message_id, status, sender_name, sender_email, subject,
            bucket, source_payload
     FROM email_items WHERE id = ?`,
  ).get(id) as EmailItemRow | undefined;
}

function recordGmailReconcileItemReceipt(
  db: Database.Database,
  input: { id: string; reason: string; startedAt: string; finishedAt: string },
) {
  return recordReceiptInDatabase(db, {
    source: "email-gmail-to-card-item",
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    summary: `Gmail closed email item ${input.id}.`,
    actions: { emailItemId: input.id, reason: input.reason },
    outcome: "success",
  });
}

export async function reconcileGmailToCard(input: {
  observations: GmailThreadObservation[];
  dbPath?: string;
  dataDir?: string;
  now?: Date | (() => Date);
  gateway?: RestrictedMailGateway;
}): Promise<{
  autoChecked: number;
  changedIds: string[];
  recoveredArchiveIds: string[];
  archiveFailures: string[];
  receipt: Receipt;
}> {
  const startedAt = nowIso(input.now);
  const finishedAt = nowIso(input.now);
  const db = openLocalDatabase(input.dbPath);
  const changedIds: string[] = [];
  const recoveredArchiveIds: string[] = [];
  const changedReasons: Record<string, string> = {};
  const repliesToArchive: Array<{
    id: string;
    threadId: string;
    messageId: string;
    inboxMessageIds: string[];
    sourcePayload: string | null;
  }> = [];
  try {
    db.transaction(() => {
      const staleBefore = new Date(
        Date.parse(finishedAt) - ARCHIVE_CLAIM_TIMEOUT_MS,
      ).toISOString();
      const staleClaims = db.prepare(
        `SELECT id, source_payload
         FROM email_items
         WHERE status = 'archiving' AND updated_at < ?
         ORDER BY updated_at, id
         LIMIT 500`,
      ).all(staleBefore) as Array<{
        id: string;
        source_payload: string | null;
      }>;
      const recover = db.prepare(
        `UPDATE email_items
         SET status = 'pending', updated_at = ?, source_payload = ?
         WHERE id = ? AND status = 'archiving' AND updated_at < ?`,
      );
      for (const stale of staleClaims) {
        const metadata = objectValue(stale.source_payload);
        delete metadata.archive_claimed_at;
        metadata.archive_recovered_at = finishedAt;
        metadata.archive_recovery_reason = "stale_claim";
        if (
          recover.run(
            finishedAt,
            JSON.stringify(metadata),
            stale.id,
            staleBefore,
          ).changes === 1
        ) {
          recoveredArchiveIds.push(stale.id);
        }
      }
      const update = db.prepare(
        `UPDATE email_items
         SET status = 'actioned', workflow_state = 'terminal',
             completion_reason = ?, actioned_at = ?, updated_at = ?,
             source_payload = ?
         WHERE id = ? AND status = 'pending'`,
      );
      const claim = db.prepare(
        `UPDATE email_items
         SET status = 'archiving', workflow_state = 'finalizing',
             completion_reason = 'sent_reply', updated_at = ?, source_payload = ?
         WHERE id = ? AND status = 'pending'`,
      );
      for (const observation of input.observations.slice(0, 500)) {
        const id = requireText(observation.emailItemId, "Email item id", 200);
        const threadId = requireText(observation.threadId, "Gmail thread id", 500);
        const row = emailRow(db, id);
        if (!row || row.status !== "pending" || row.thread_id !== threadId) {
          continue;
        }
        const metadata = objectValue(row.source_payload);
        const replyBucket = row.bucket === "reply" || metadata.bucket === "reply";
        if (!observation.inInbox) {
          const reason = "not_in_inbox";
          const reconciledMetadata = {
            ...metadata,
            reconciled_from_gmail: reason,
            reconciled_at: finishedAt,
          };
          if (update.run(
            "manual_archive",
            finishedAt,
            finishedAt,
            JSON.stringify(reconciledMetadata),
            id,
          ).changes === 1) {
            recordGmailReconcileItemReceipt(db, {
              id,
              reason,
              startedAt,
              finishedAt,
            });
            changedIds.push(id);
            changedReasons[id] = reason;
          }
          continue;
        }
        if (observation.userReplied && replyBucket) {
          const currentMessageId = row.message_id ??
            observation.inboxMessageIds?.at(-1);
          if (!currentMessageId) continue;
          const claimedMetadata = {
            ...metadata,
            archive_claimed_at: finishedAt,
            archive_reason: "sent_reply",
          };
          if (claim.run(
            finishedAt,
            JSON.stringify(claimedMetadata),
            id,
          ).changes === 1) {
            repliesToArchive.push({
              id,
              threadId,
              messageId: currentMessageId,
              inboxMessageIds: observation.inboxMessageIds?.length
                ? [...new Set(observation.inboxMessageIds)]
                : [currentMessageId],
              sourcePayload: row.source_payload,
            });
          }
        }
      }
    }).immediate();
  } finally {
    db.close();
  }
  const archiveFailures: string[] = [];
  if (repliesToArchive.length > 0) {
    const gateway = input.gateway ??
      createGoogleWorkspaceGateway({ dataDir: input.dataDir }).mail;
    for (const row of repliesToArchive) {
      try {
        await gateway.archiveMessages({ messageIds: row.inboxMessageIds });
        const finalize = openLocalDatabase(input.dbPath);
        try {
          const metadata: Record<string, unknown> = {
            ...objectValue(row.sourcePayload),
            reconciled_from_gmail: "user_replied",
            reconciled_at: finishedAt,
            gmail_archived_at: finishedAt,
          };
          delete metadata.archive_claimed_at;
          const changed = finalize.transaction(() => {
            const updated = finalize.prepare(
              `UPDATE email_items
               SET status = 'actioned', workflow_state = 'terminal',
                   actioned_at = ?, updated_at = ?, source_payload = ?
               WHERE id = ? AND status = 'archiving'`,
            ).run(
              finishedAt,
              finishedAt,
              JSON.stringify(metadata),
              row.id,
            ).changes === 1;
            if (updated) {
              recordGmailReconcileItemReceipt(finalize, {
                id: row.id,
                reason: "user_replied",
                startedAt,
                finishedAt,
              });
            }
            return updated;
          }).immediate();
          if (changed) {
            changedIds.push(row.id);
            changedReasons[row.id] = "user_replied";
          }
        } finally {
          finalize.close();
        }
      } catch (error) {
        const failure = safeWorkspaceFailure(error);
        archiveFailures.push(`${row.id}: ${failure.message}`);
        const rollback = openLocalDatabase(input.dbPath);
        try {
          rollback.prepare(
            `UPDATE email_items
             SET status = 'pending', workflow_state = 'open',
                 completion_reason = NULL, updated_at = ?, source_payload = ?
             WHERE id = ? AND status = 'archiving'`,
          ).run(finishedAt, row.sourcePayload, row.id);
        } finally {
          rollback.close();
        }
      }
    }
  }
  const summary = [
    ...(recoveredArchiveIds.length > 0
      ? [`${recoveredArchiveIds.length} interrupted Gmail archive(s) were reopened on the email card.`]
      : []),
    ...(changedIds.length > 0
      ? [`${changedIds.length} Gmail thread(s) were checked off on the email card.`]
      : []),
  ].join(" ") || "Email card already matched Gmail.";
  const receipt = recordReceipt({
    dbPath: input.dbPath,
    source: "email-gmail-to-card",
    startedAt,
    finishedAt,
    summary,
    actions: {
      changedIds,
      changedReasons,
      recoveredArchiveIds,
      archiveFailures,
    },
    outcome: archiveFailures.length === 0 ? "success" : "partial",
    failureKey: "reply-inbox-cleanup",
    failureMessage: archiveFailures.length > 0
      ? "Some replied threads could not be archived and remain open on the Email card."
      : undefined,
  });
  return {
    autoChecked: changedIds.length,
    changedIds,
    recoveredArchiveIds,
    archiveFailures,
    receipt,
  };
}

export function captureEmailCommitments(input: {
  commitments: EmailCommitmentInput[];
  dbPath?: string;
  now?: Date | (() => Date);
}): { inserted: number; existing: number; ids: string[]; receipt: Receipt } {
  const startedAt = nowIso(input.now);
  const finishedAt = nowIso(input.now);
  const db = openLocalDatabase(input.dbPath);
  try {
    return db.transaction(() => {
      let inserted = 0;
      let existing = 0;
      const ids: string[] = [];
      const statement = db.prepare(
        `INSERT OR IGNORE INTO commitments
           (id, kind, title, details, counterparty, contact_id, source_kind,
            source_quote, source_ref, due_at, review_at, confidence, confirmed,
            status, evidence, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?, 'detector', ?, ?, ?, NULL, 'medium', 0,
                 'open', ?, ?, ?)`,
      );
      for (const commitment of input.commitments.slice(0, 100)) {
        const threadId = requireText(commitment.threadId, "Gmail thread id", 500);
        const quote = normalizedQuote(
          requireText(commitment.sourceQuote, "Source quote", 4_000),
        );
        const sourceRef = `gmail:${threadId}`;
        const id = deterministicUuid(
          `email-commitment\0${commitment.kind}\0${threadId}\0${quote.toLowerCase()}`,
        );
        const result = statement.run(
          id,
          commitment.kind,
          requireText(commitment.title, "Commitment title", 240),
          commitment.counterparty?.trim().slice(0, 240) || null,
          commitment.contactId?.trim() || null,
          quote,
          sourceRef,
          commitment.dueAt ?? null,
          JSON.stringify({
            threadLink: requireText(commitment.threadLink, "Thread link", 2_000),
            detector: "email-triage",
          }),
          finishedAt,
          finishedAt,
        );
        ids.push(id);
        if (result.changes === 1) inserted += 1;
        else existing += 1;
      }
      const receipt = recordReceiptInDatabase(db, {
        source: "email-commitments",
        startedAt,
        finishedAt,
        summary: `${inserted} email commitment(s) captured; ${existing} already existed.`,
        actions: { inserted, existing, ids },
        outcome: "success",
      });
      return { inserted, existing, ids, receipt };
    }).immediate();
  } finally {
    db.close();
  }
}

function recordCRMResolutionFailure(input: {
  dbPath?: string;
  sourceId: string;
  message: string;
  details: unknown;
  occurredAt: string;
}): void {
  recordFailure({
    dbPath: input.dbPath,
    source: "email-contact-resolution",
    sourceId: input.sourceId,
    message: input.message,
    details: input.details,
    occurredAt: input.occurredAt,
  });
}

export function getEmailCRMContext(input: {
  senderName: string;
  senderEmail: string;
  threadId: string;
  dbPath?: string;
  dataDir?: string;
  now?: Date | (() => Date);
}): EmailCRMContext {
  const occurredAt = nowIso(input.now);
  const senderEmail = requireText(input.senderEmail, "Sender email", 500);
  const threadId = requireText(input.threadId, "Gmail thread id", 500);
  const crm = createCRMBackend({
    dbPath: input.dbPath,
    dataDir: input.dataDir,
    now: typeof input.now === "function"
      ? input.now
      : input.now
        ? () => input.now as Date
        : undefined,
  });
  try {
    const matches = crm.findByNormalizedEmail(senderEmail);
    if (matches.length > 1) {
      recordCRMResolutionFailure({
        dbPath: input.dbPath,
        sourceId: `gmail:${threadId}`,
        message: `Email contact "${input.senderName || senderEmail}" is ambiguous.`,
        details: { threadId, senderEmail, candidates: matches },
        occurredAt,
      });
      return {
        status: "ambiguous",
        contact: null,
        activities: [],
        waitingOn: [],
        candidates: matches,
      };
    }
    const contact = matches[0];
    if (!contact) {
      return {
        status: "not_found",
        contact: null,
        activities: [],
        waitingOn: [],
      };
    }
    resolveFailure("email-contact-resolution", `gmail:${threadId}`, {
      dbPath: input.dbPath,
      resolvedAt: occurredAt,
    });
    const history = crm.getContactWithRecentActivities(contact.id, 20);
    const db = openLocalDatabase(input.dbPath);
    try {
      const waitingOn = db.prepare(
        `SELECT id, title, details, due_at
         FROM commitments
         WHERE status = 'open' AND kind = 'waiting_on'
           AND (
             contact_id = ?
             OR (contact_id IS NULL AND lower(COALESCE(counterparty, '')) = lower(?))
           )
         ORDER BY COALESCE(due_at, updated_at), id
         LIMIT 50`,
      ).all(
        contact.id,
        contact.name,
      ) as Array<{
        id: string;
        title: string;
        details: string | null;
        due_at: string | null;
      }>;
      return {
        status: "matched",
        contact,
        activities: history?.activities ?? [],
        waitingOn: waitingOn.map((row) => ({
          id: row.id,
          title: row.title,
          details: row.details,
          dueAt: row.due_at,
        })),
      };
    } finally {
      db.close();
    }
  } finally {
    crm.close();
  }
}

export function recordEmailCorrespondence(input: {
  senderName: string;
  senderEmail: string;
  threadId: string;
  messageId: string;
  title: string;
  content: string;
  direction: "inbound" | "outbound";
  occurredAt?: string;
  dbPath?: string;
  dataDir?: string;
  now?: Date | (() => Date);
}): { status: "matched" | "created" | "ambiguous"; activityId?: string } {
  const timestamp = nowIso(input.now);
  const crm = createCRMBackend({
    dbPath: input.dbPath,
    dataDir: input.dataDir,
    now: typeof input.now === "function"
      ? input.now
      : input.now
        ? () => input.now as Date
        : undefined,
  });
  try {
    const resolution = crm.resolveOrCreateContact({
      name: input.senderName.trim(),
      email: requireText(input.senderEmail, "Sender email", 500),
      tags: ["email-triage"],
      source: "email",
    });
    if (resolution.status === "ambiguous") {
      recordCRMResolutionFailure({
        dbPath: input.dbPath,
        sourceId: `gmail:${input.threadId}`,
        message: `Email contact "${input.senderName || input.senderEmail}" is ambiguous.`,
        details: {
          threadId: input.threadId,
          senderEmail: input.senderEmail,
          candidates: resolution.candidates,
        },
        occurredAt: timestamp,
      });
      return { status: "ambiguous" };
    }
    const activity = crm.appendActivity({
      contactId: resolution.contact.id,
      companyId: resolution.contact.company_id ?? undefined,
      sourceRef: `gmail:${requireText(input.threadId, "Gmail thread id", 500)}:${
        requireText(input.messageId, "Gmail message id", 500)
      }:correspondence`,
      activityType: "email",
      title: requireText(input.title, "Correspondence title", 240),
      content: input.content.trim().slice(0, 20_000),
      direction: input.direction,
      source: "email",
      occurredAt: input.occurredAt,
      metadata: {
        gmailThreadId: input.threadId,
        gmailMessageId: input.messageId,
        recordedAt: timestamp,
      },
    });
    recordReceipt({
      dbPath: input.dbPath,
      source: "email-correspondence",
      startedAt: timestamp,
      finishedAt: timestamp,
      summary: "Meaningful email correspondence was added to the contact history.",
      actions: {
        contactId: resolution.contact.id,
        activityId: activity.id,
        threadId: input.threadId,
        contactResolution: resolution.status,
      },
      outcome: "success",
    });
    return { status: resolution.status, activityId: activity.id };
  } finally {
    crm.close();
  }
}

export async function archiveEmailItemFromCard(input: {
  emailItemId: string;
  dbPath?: string;
  dataDir?: string;
  now?: Date | (() => Date);
  gateway?: RestrictedMailGateway;
}): Promise<{ archived: boolean; alreadyDone: boolean; receipt?: Receipt }> {
  const startedAt = nowIso(input.now);
  const db = openLocalDatabase(input.dbPath);
  let row: EmailItemRow | undefined;
  try {
    row = emailRow(db, requireText(input.emailItemId, "Email item id", 200));
  } finally {
    db.close();
  }
  if (!row) throw new Error("Email item was not found.");
  if (row.status !== "pending") {
    return { archived: false, alreadyDone: true };
  }
  if (!row.thread_id) throw new Error("Email item has no Gmail thread id.");

  const gateway = input.gateway ??
    createGoogleWorkspaceGateway({ dataDir: input.dataDir }).mail;
  const thread = await gateway.getThread({
    threadId: row.thread_id,
    format: "metadata",
  });
  const inboxMessageIds = thread.messages
    .filter((message) => message.labelIds.includes("INBOX"))
    .map((message) => message.id);
  if (!row.message_id && inboxMessageIds.length === 0) {
    const finishedAt = nowIso(input.now);
    const archived = openLocalDatabase(input.dbPath);
    try {
      archived.prepare(
        `UPDATE email_items
         SET status = 'actioned', workflow_state = 'terminal',
             completion_reason = 'manual_archive', actioned_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      ).run(finishedAt, finishedAt, row.id);
    } finally {
      archived.close();
    }
    return { archived: true, alreadyDone: false };
  }
  if (!row.message_id) {
    const candidate = thread.messages
      .filter((message) => message.labelIds.includes("INBOX"))
      .sort((a, b) => Number(b.internalDate ?? 0) - Number(a.internalDate ?? 0))[0];
    if (!candidate) throw new Error("Email item has no recoverable Gmail message.");
    const repairedAt = nowIso(input.now);
    const repair = openLocalDatabase(input.dbPath);
    try {
      repair.transaction(() => {
        repair.prepare(
          `INSERT OR IGNORE INTO cove_email_messages
             (message_id, thread_id, email_item_id, internal_date, direction,
              state, attempts, observed_at, processed_at, updated_at)
           VALUES (?, ?, ?, ?, 'inbound', 'processed', 0, ?, ?, ?)`,
        ).run(
          candidate.id,
          row!.thread_id,
          row!.id,
          candidate.internalDate,
          repairedAt,
          repairedAt,
          repairedAt,
        );
        repair.prepare(
          `UPDATE email_items
           SET message_id = ?, latest_inbound_message_id = ?,
               thread_version = MAX(thread_version, 1), updated_at = ?
           WHERE id = ? AND message_id IS NULL`,
        ).run(candidate.id, candidate.id, repairedAt, row!.id);
      }).immediate();
    } finally {
      repair.close();
    }
    row.message_id = candidate.id;
  }
  const requested = requestEmailCompletion({
    emailItemId: row.id,
    reason: "card",
    messageIds: inboxMessageIds.length > 0 ? inboxMessageIds : [row.message_id],
    dbPath: input.dbPath,
    now: new Date(startedAt),
  });
  if (requested.alreadyDone) {
    return { archived: false, alreadyDone: true };
  }
  if (!requested.jobId) {
    throw new Error("Gmail archive job was not created.");
  }

  const scheduler = new JobScheduler({
    dbPath: input.dbPath,
    now: nowProvider(input.now),
  });
  let result: Awaited<ReturnType<JobScheduler["runJob"]>>;
  try {
    scheduler.register("gmail-operation", createGmailOperationHandler({
      gateway,
      dbPath: input.dbPath,
      now: nowProvider(input.now),
    }));
    result = await scheduler.runJob(requested.jobId);
  } finally {
    scheduler.close();
  }

  const finishedAt = nowIso(input.now);
  const verify = openLocalDatabase(input.dbPath);
  try {
    const current = verify.prepare(
      "SELECT status, workflow_state FROM email_items WHERE id = ?",
    ).get(row.id) as { status: string; workflow_state: string } | undefined;
    if (current?.status === "actioned" && current.workflow_state === "terminal") {
      return { archived: true, alreadyDone: false };
    }
  } finally {
    verify.close();
  }
  const failure = new Error(
    result === "unavailable"
      ? "The Gmail archive is already being processed."
      : "Gmail archive failed. Cove left the email open and will retry.",
  );
  recordReceipt({
    dbPath: input.dbPath,
    source: "email-card-to-gmail",
    startedAt,
    finishedAt,
    summary: failure.message,
    actions: {
      emailItemId: row.id,
      threadId: row.thread_id,
      messageId: row.message_id,
      operationId: requested.operationId,
      jobId: requested.jobId,
      result,
    },
    outcome: "failed",
    failureKey: row.id,
    failureMessage: failure.message,
  });
  throw failure;
}
