/**
 * Canonical Cove state machine for one Gmail thread.
 *
 * Message claims are keyed by Gmail message ID and the user-facing item is keyed
 * by thread ID. This module decides workflow state and enqueues provider
 * operations, but it does not call Gmail. Keeping those steps separate makes a
 * crash between local intent and provider confirmation recoverable.
 */
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { openLocalDatabase } from "../local/database";
import { enqueueJobInDatabase } from "../reliability/jobs";
import { recordReceiptInDatabase } from "../reliability/receipts";
import { normalizeDraftBody, stripTrailingSignature } from "./draft-format";

export type EmailBucket = "reply" | "action" | "fyi" | "noise";

type EmailThreadRow = {
  id: string;
  thread_id: string;
  thread_version: number;
  latest_inbound_message_id: string | null;
  workflow_state: string;
  status: string;
};

function clean(value: string, name: string, max = 500): string {
  const result = value.trim();
  if (!result || result.length > max) throw new Error(`${name} is invalid.`);
  return result;
}

function stableUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${
    ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  }${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function numericDate(value: string | null | undefined): bigint {
  try {
    return BigInt(value || "0");
  } catch {
    return BigInt(0);
  }
}

function gmailOperationKey(input: {
  kind: "upsert_draft" | "archive_messages";
  threadId: string;
  threadVersion: number;
  messageId: string;
}): string {
  return `${input.kind}:${input.threadId}:v${input.threadVersion}:${input.messageId}`;
}

function currentThread(db: Database.Database, threadId: string): EmailThreadRow | undefined {
  return db.prepare(
    `SELECT id, thread_id, thread_version, latest_inbound_message_id,
            workflow_state, status
     FROM email_items WHERE thread_id = ?`,
  ).get(threadId) as EmailThreadRow | undefined;
}

function todayColumnId(db: Database.Database): string | null {
  const row = db.prepare(
    `SELECT id FROM task_columns
     WHERE lower(name) IN ('must happen today','needs to happen today','today')
     ORDER BY position, id LIMIT 1`,
  ).get() as { id: string } | undefined;
  return row?.id ?? null;
}

export function ensureRollingEmailCardInDatabase(
  db: Database.Database,
  input: { now: string; open: boolean },
): string {
  const current = db.prepare(
    `SELECT id FROM tasks
     WHERE tags LIKE '%"email-current"%'
     ORDER BY COALESCE(updated_at, created_at, '') DESC, id
     LIMIT 1`,
  ).get() as { id: string } | undefined;
  const id = current?.id ?? stableUuid("cove:rolling-email-card");
  const columnId = todayColumnId(db);
  if (!current) {
    db.prepare(
      `INSERT INTO tasks
         (id, column_id, title, description, priority, tags, project, position,
          status, source_type, remind_native, remind_text, created_at, updated_at)
       VALUES (?, ?, 'Email',
         'Replies and actions that still need you. Gmail Inbox is the source of truth.',
         'high', '["email","email-current"]', 'Cove', -1000, ?, 'email',
         0, 0, ?, ?)`,
    ).run(id, columnId, input.open ? "open" : "done", input.now, input.now);
  } else {
    db.prepare(
      `UPDATE tasks
       SET title = 'Email', status = ?, source_type = 'email',
           column_id = COALESCE(?, column_id), updated_at = ?
       WHERE id = ?`,
    ).run(input.open ? "open" : "done", columnId, input.now, id);
  }
  return id;
}

function syncRollingCard(db: Database.Database, now: string): string {
  const open = Boolean(db.prepare(
    `SELECT 1 FROM email_items
     WHERE status = 'pending' AND workflow_state IN ('open','finalizing','failed')
     LIMIT 1`,
  ).get());
  return ensureRollingEmailCardInDatabase(db, { now, open });
}

export function observeInboundMessage(input: {
  messageId: string;
  threadId: string;
  gmailHistoryId?: string | null;
  internalDate: string;
  accountEmail: string;
  senderName?: string | null;
  senderEmail?: string | null;
  subject?: string | null;
  bodyExcerpt?: string | null;
  receivedAt?: string | null;
  dbPath?: string;
  now?: Date;
  // The five-minute incremental lane passes false so a permanently failed
  // classification cannot restart its retry ladder every tick. Catch-up
  // remains the scheduled runner's job.
  resurrectFailed?: boolean;
}): {
  inserted: boolean;
  newer: boolean;
  emailItemId: string;
  threadVersion: number;
} {
  const now = (input.now ?? new Date()).toISOString();
  const messageId = clean(input.messageId, "Message id");
  const threadId = clean(input.threadId, "Thread id");
  const db = openLocalDatabase(input.dbPath);
  try {
    return db.transaction(() => {
      const existingMessage = db.prepare(
        `SELECT email_item_id, state
         FROM cove_email_messages WHERE message_id = ?`,
      ).get(messageId) as { email_item_id: string; state: string } | undefined;
      if (existingMessage) {
        const thread = currentThread(db, threadId);
        if (
          existingMessage.state === "failed" && thread &&
          input.resurrectFailed !== false
        ) {
          db.prepare(
            `UPDATE cove_email_messages
             SET state = 'observed', last_error = NULL, updated_at = ?
             WHERE message_id = ? AND state = 'failed'`,
          ).run(now, messageId);
          db.prepare(
            `UPDATE email_items
             SET workflow_state = 'observed', status = 'pending', updated_at = ?
             WHERE id = ? AND workflow_state = 'failed'`,
          ).run(now, existingMessage.email_item_id);
          const key = `email-classify:${messageId}`;
          const job = db.prepare(
            "SELECT id FROM cove_jobs WHERE idempotency_key = ?",
          ).get(key) as { id: string } | undefined;
          if (job) {
            db.prepare(
              `UPDATE cove_jobs
               SET status = 'queued', run_after = ?, lease_until = NULL,
                   lease_token = NULL, attempts = 0, finished_at = NULL,
                   last_error = NULL
               WHERE id = ?`,
            ).run(now, job.id);
          } else {
            enqueueJobInDatabase(db, {
              type: "email-classify",
              payload: {
                messageId,
                emailItemId: existingMessage.email_item_id,
                threadVersion: thread.thread_version,
              },
              idempotencyKey: key,
              maxAttempts: 5,
            }, new Date(now));
          }
          return {
            inserted: false,
            newer: true,
            emailItemId: existingMessage.email_item_id,
            threadVersion: thread.thread_version,
          };
        }
        return {
          inserted: false,
          newer: false,
          emailItemId: existingMessage.email_item_id,
          threadVersion: thread?.thread_version ?? 0,
        };
      }

      let thread = currentThread(db, threadId);
      const wasNewThread = !thread;
      const emailItemId = thread?.id ?? stableUuid(`gmail-thread:${threadId}`);
      const previousMessage = thread?.latest_inbound_message_id
        ? db.prepare(
          `SELECT message_id, internal_date, gmail_history_id
           FROM cove_email_messages WHERE message_id = ?`,
        ).get(thread.latest_inbound_message_id) as {
          message_id: string;
          internal_date: string | null;
          gmail_history_id: string | null;
        } | undefined
        : undefined;
      const inputDate = numericDate(input.internalDate);
      const previousDate = numericDate(previousMessage?.internal_date);
      const inputHistory = numericDate(input.gmailHistoryId);
      const previousHistory = numericDate(previousMessage?.gmail_history_id);
      const newer = !thread ||
        inputDate > previousDate ||
        (
          inputDate === previousDate &&
          (
            inputHistory > previousHistory ||
            (
              inputHistory === previousHistory &&
              messageId > (previousMessage?.message_id ?? "")
            )
          )
        );

      if (wasNewThread) {
        db.prepare(
          `INSERT INTO email_items
             (id, message_id, thread_id, classification, status, sender_name,
              sender_email, subject, body_excerpt, source_payload,
              recommended_action, priority, received_at, account_email,
              created_at, updated_at, workflow_state, thread_version,
              latest_inbound_message_id, latest_gmail_history_id)
           VALUES (?, ?, ?, NULL, 'pending', ?, ?, ?, ?, '{}', NULL, 0, ?, ?,
                   ?, ?, 'observed', 1, ?, ?)`,
        ).run(
          emailItemId,
          messageId,
          threadId,
          input.senderName ?? null,
          input.senderEmail ?? null,
          input.subject ?? null,
          input.bodyExcerpt ?? null,
          input.receivedAt ?? now,
          input.accountEmail,
          now,
          now,
          messageId,
          input.gmailHistoryId ?? null,
        );
        thread = currentThread(db, threadId);
      }

      db.prepare(
        `INSERT INTO cove_email_messages
           (message_id, thread_id, email_item_id, gmail_history_id,
            internal_date, direction, state, attempts, observed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'inbound', ?, 0, ?, ?)`,
      ).run(
        messageId,
        threadId,
        emailItemId,
        input.gmailHistoryId ?? null,
        input.internalDate,
        newer ? "observed" : "superseded",
        now,
        now,
      );

      if (newer && thread) {
        const nextVersion = wasNewThread ? 1 : thread.thread_version + 1;
        db.prepare(
          `UPDATE cove_gmail_operations
           SET status = 'superseded', updated_at = ?, completed_at = ?
           WHERE thread_id = ? AND status IN ('pending','uncertain')`,
        ).run(now, now, threadId);
        db.prepare(
          `UPDATE email_items
           SET message_id = ?, sender_name = ?, sender_email = ?, subject = ?,
               body_excerpt = ?, received_at = ?, account_email = ?,
               workflow_state = 'observed', status = 'pending',
               thread_version = ?, latest_inbound_message_id = ?,
               latest_gmail_history_id = ?, actioned_at = NULL,
               completion_reason = NULL, surfaced_message_id = NULL,
               surfaced_at = NULL, surface_receipt_id = NULL,
               updated_at = ?
           WHERE id = ?`,
        ).run(
          messageId,
          input.senderName ?? null,
          input.senderEmail ?? null,
          input.subject ?? null,
          input.bodyExcerpt ?? null,
          input.receivedAt ?? now,
          input.accountEmail,
          nextVersion,
          messageId,
          input.gmailHistoryId ?? null,
          now,
          emailItemId,
        );
        enqueueJobInDatabase(db, {
          type: "email-classify",
          payload: { messageId, emailItemId, threadVersion: nextVersion },
          idempotencyKey: `email-classify:${messageId}`,
          maxAttempts: 5,
        }, new Date(now));
        return { inserted: true, newer: true, emailItemId, threadVersion: nextVersion };
      }
      return {
        inserted: true,
        newer: false,
        emailItemId,
        threadVersion: thread?.thread_version ?? 0,
      };
    }).immediate();
  } finally {
    db.close();
  }
}

function enqueueOperation(
  db: Database.Database,
  input: {
    emailItemId: string;
    threadId: string;
    messageId: string;
    threadVersion: number;
    kind: "upsert_draft" | "archive_messages";
    payload: unknown;
    now: string;
  },
): { operationId: string; jobId: string } {
  const operationKey = gmailOperationKey(input);
  const operationId = stableUuid(`gmail-operation:${operationKey}`);
  const resolvedOperationId = db.prepare(
    "SELECT id FROM cove_gmail_operations WHERE operation_key = ?",
  ).pluck().get(operationKey) as string | undefined;
  db.prepare(
    `UPDATE cove_gmail_operations
     SET status = 'superseded', updated_at = ?, completed_at = ?
     WHERE thread_id = ? AND status IN ('pending','uncertain') AND id != ?`,
  ).run(
    input.now,
    input.now,
    input.threadId,
    resolvedOperationId ?? operationId,
  );
  const inserted = db.prepare(
    `INSERT INTO cove_gmail_operations
       (id, email_item_id, thread_id, expected_message_id,
        expected_thread_version, kind, operation_key, payload_json, status,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT(operation_key) DO NOTHING`,
  ).run(
    operationId,
    input.emailItemId,
    input.threadId,
    input.messageId,
    input.threadVersion,
    input.kind,
    operationKey,
    JSON.stringify(input.payload),
    input.now,
    input.now,
  );
  const operation = db.prepare(
    `SELECT id, status, job_id
     FROM cove_gmail_operations WHERE operation_key = ?`,
  ).get(operationKey) as {
    id: string;
    status: string;
    job_id: string | null;
  };
  if (
    inserted.changes === 0 &&
    (operation.status === "dead" || operation.status === "superseded")
  ) {
    db.prepare(
      `UPDATE cove_gmail_operations
       SET status = 'pending', remote_id = NULL, result_json = NULL,
           last_error = NULL, updated_at = ?, completed_at = NULL
       WHERE id = ?`,
    ).run(input.now, operation.id);
    if (operation.job_id) {
      db.prepare(
        `UPDATE cove_jobs
         SET status = 'queued', run_after = ?, lease_until = NULL,
             lease_token = NULL, attempts = 0, finished_at = NULL,
             last_error = NULL
         WHERE id = ?`,
      ).run(input.now, operation.job_id);
    }
  }
  const job = enqueueJobInDatabase(db, {
    type: "gmail-operation",
    payload: { operationId: operation.id },
    idempotencyKey: `gmail-operation:${operation.id}`,
    maxAttempts: 8,
  }, new Date(input.now));
  if (operation.job_id !== job.job.id) {
    db.prepare(
      `UPDATE cove_gmail_operations
       SET job_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(job.job.id, input.now, operation.id);
  }
  return { operationId: operation.id, jobId: job.job.id };
}

export function applyEmailClassification(input: {
  messageId: string;
  emailItemId: string;
  threadVersion: number;
  bucket: EmailBucket;
  summary: string;
  recommendedAction?: string | null;
  draftBody?: string | null;
  voiceJudgeScore?: number | null;
  voiceJudgeVerdict?: string | null;
  signatureText?: string | null;
  artifactPayload?: unknown;
  modelVersion: string;
  dbPath?: string;
  now?: Date;
}): {
  applied: boolean;
  operationId?: string;
  cardId?: string;
  cause?: "missing_item" | "item_not_open" | "version_mismatch";
} {
  const now = (input.now ?? new Date()).toISOString();
  const draftBody = input.draftBody == null
    ? null
    : normalizeDraftBody(
      stripTrailingSignature(input.draftBody, input.signatureText),
    ).slice(0, 100_000);
  const db = openLocalDatabase(input.dbPath);
  try {
    return db.transaction(() => {
      const thread = db.prepare(
        `SELECT id, thread_id, thread_version, latest_inbound_message_id,
                gmail_draft_id, draft_body_hash, workflow_state, status
         FROM email_items WHERE id = ?`,
      ).get(input.emailItemId) as {
        id: string;
        thread_id: string;
        thread_version: number;
        latest_inbound_message_id: string | null;
        gmail_draft_id: string | null;
        draft_body_hash: string | null;
        workflow_state: string;
        status: string;
      } | undefined;
      const rejectClassification = (
        cause: "missing_item" | "item_not_open" | "version_mismatch",
      ) => {
        db.prepare(
          `UPDATE cove_email_messages
           SET state = 'superseded', updated_at = ?
           WHERE message_id = ? AND state IN ('observed','classifying')`,
        ).run(now, input.messageId);
        return { applied: false, cause };
      };
      if (!thread) {
        return rejectClassification("missing_item");
      }
      if (thread.status !== "pending" || thread.workflow_state !== "observed") {
        return rejectClassification("item_not_open");
      }
      if (
        thread.thread_version !== input.threadVersion ||
        thread.latest_inbound_message_id !== input.messageId
      ) {
        return rejectClassification("version_mismatch");
      }
      if (input.bucket === "reply" && !draftBody) {
        throw new Error("Reply classification requires a draft body.");
      }
      const olderDraftWarning = "An older Cove draft is still in Gmail; check it before sending.";
      const baseRecommendedAction = input.recommendedAction ??
        (input.bucket === "reply" ? "reply" : "review");
      const recommendedAction = thread.gmail_draft_id &&
          input.bucket === "action" &&
          !draftBody &&
          baseRecommendedAction.startsWith("Cove withheld the reply draft:") &&
          !baseRecommendedAction.includes(olderDraftWarning)
        ? `${baseRecommendedAction} ${olderDraftWarning}`
        : baseRecommendedAction;
      db.prepare(
        `UPDATE cove_email_messages
         SET state = 'processed', classification_json = ?, model_version = ?,
             processed_at = ?, updated_at = ?
         WHERE message_id = ?`,
      ).run(
        JSON.stringify({
          bucket: input.bucket,
          summary: input.summary.slice(0, 4_000),
          recommendedAction,
        }),
        input.modelVersion.slice(0, 200),
        now,
        now,
        input.messageId,
      );
      const terminalAfterArchive = input.bucket === "fyi" || input.bucket === "noise";
      db.prepare(
        `UPDATE email_items
         SET classification = ?, bucket = ?, summary = ?,
             recommended_action = ?, workflow_state = ?, status = 'pending',
             draft_response = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        input.bucket === "noise" ? "log_only" : input.bucket === "fyi" ? "tiding" : "action_item",
        input.bucket,
        input.summary.slice(0, 4_000),
        recommendedAction,
        terminalAfterArchive ? "finalizing" : "open",
        draftBody,
        now,
        input.emailItemId,
      );

      let cardId: string | undefined;
      if (input.bucket === "action" || input.bucket === "fyi") {
        cardId = ensureRollingEmailCardInDatabase(db, { now, open: true });
        const receipt = recordReceiptInDatabase(db, {
          source: "email-surfaced",
          startedAt: now,
          finishedAt: now,
          summary: input.bucket === "fyi"
            ? "An informational email was recorded before it was archived."
            : "An email action was added to the rolling Email card.",
          actions: {
            emailItemId: input.emailItemId,
            messageId: input.messageId,
            threadId: thread.thread_id,
            bucket: input.bucket,
          },
          outcome: "success",
        });
        db.prepare(
          `UPDATE email_items
           SET surfaced_message_id = ?, surfaced_at = ?, surface_receipt_id = ?
           WHERE id = ?`,
        ).run(input.messageId, now, receipt.id, input.emailItemId);
      } else if (input.bucket === "noise") {
        recordReceiptInDatabase(db, {
          source: "email-surfaced",
          startedAt: now,
          finishedAt: now,
          summary: input.summary.trim() ||
            "A low-value email was recorded before Cove queued it for archive.",
          actions: {
            emailItemId: input.emailItemId,
            messageId: input.messageId,
            threadId: thread.thread_id,
            bucket: input.bucket,
          },
          outcome: "success",
        });
      }

      let operationId: string | undefined;
      if (input.bucket === "reply") {
        operationId = enqueueOperation(db, {
          emailItemId: input.emailItemId,
          threadId: thread.thread_id,
          messageId: input.messageId,
          threadVersion: input.threadVersion,
          kind: "upsert_draft",
          payload: {
            body: draftBody,
            existingDraftId: thread.gmail_draft_id,
            ...(thread.draft_body_hash
              ? { existingDraftBodyHash: thread.draft_body_hash }
              : {}),
            voiceJudgeScore: input.voiceJudgeScore ?? null,
            voiceJudgeVerdict: input.voiceJudgeVerdict?.slice(0, 300) ?? null,
          },
          now,
        }).operationId;
      } else if (terminalAfterArchive) {
        operationId = enqueueOperation(db, {
          emailItemId: input.emailItemId,
          threadId: thread.thread_id,
          messageId: input.messageId,
          threadVersion: input.threadVersion,
          kind: "archive_messages",
          payload: { messageIds: [input.messageId], reason: input.bucket },
          now,
        }).operationId;
      }
      if (input.artifactPayload) {
        enqueueJobInDatabase(db, {
          type: "email-artifacts",
          payload: input.artifactPayload,
          idempotencyKey: `email-artifacts:${input.messageId}`,
          maxAttempts: 8,
        }, new Date(now));
      }
      return { applied: true, operationId, cardId };
    }).immediate();
  } finally {
    db.close();
  }
}

export function requestEmailCompletion(input: {
  emailItemId: string;
  reason: "card" | "sent_reply" | "manual_archive";
  messageIds?: string[];
  dbPath?: string;
  now?: Date;
}): { alreadyDone: boolean; operationId?: string; jobId?: string } {
  const now = (input.now ?? new Date()).toISOString();
  const db = openLocalDatabase(input.dbPath);
  try {
    return db.transaction(() => {
      const row = db.prepare(
        `SELECT id, thread_id, thread_version, latest_inbound_message_id,
                workflow_state, status
         FROM email_items WHERE id = ?`,
      ).get(clean(input.emailItemId, "Email item id", 200)) as EmailThreadRow | undefined;
      if (!row) throw new Error("Email item was not found.");
      if (row.status !== "pending" || row.workflow_state === "terminal") {
        return { alreadyDone: true };
      }
      if (!row.latest_inbound_message_id) {
        throw new Error("Email item has no current inbound message.");
      }
      const operationKey = gmailOperationKey({
        kind: "archive_messages",
        threadId: row.thread_id,
        threadVersion: row.thread_version,
        messageId: row.latest_inbound_message_id,
      });
      const existing = db.prepare(
        `SELECT id, job_id
         FROM cove_gmail_operations
         WHERE operation_key = ? AND status IN ('pending','uncertain')`,
      ).get(operationKey) as { id: string; job_id: string | null } | undefined;
      if (existing) {
        db.prepare(
          `UPDATE email_items
           SET workflow_state = 'finalizing', completion_reason = ?, updated_at = ?
           WHERE id = ?`,
        ).run(input.reason, now, row.id);
        const operation = enqueueOperation(db, {
          emailItemId: row.id,
          threadId: row.thread_id,
          messageId: row.latest_inbound_message_id,
          threadVersion: row.thread_version,
          kind: "archive_messages",
          payload: {
            messageIds: input.messageIds?.length
              ? [...new Set(input.messageIds)]
              : [row.latest_inbound_message_id],
            reason: input.reason,
          },
          now,
        });
        return {
          alreadyDone: false,
          operationId: operation.operationId,
          jobId: operation.jobId,
        };
      }
      db.prepare(
        `UPDATE cove_gmail_operations
         SET status = 'superseded', updated_at = ?, completed_at = ?
         WHERE thread_id = ? AND status IN ('pending','uncertain')`,
      ).run(now, now, row.thread_id);
      db.prepare(
        `UPDATE email_items
         SET workflow_state = 'finalizing', completion_reason = ?, updated_at = ?
         WHERE id = ?`,
      ).run(input.reason, now, row.id);
      const operation = enqueueOperation(db, {
        emailItemId: row.id,
        threadId: row.thread_id,
        messageId: row.latest_inbound_message_id,
        threadVersion: row.thread_version,
        kind: "archive_messages",
        payload: {
          messageIds: input.messageIds?.length
            ? [...new Set(input.messageIds)]
            : [row.latest_inbound_message_id],
          reason: input.reason,
        },
        now,
      });
      return {
        alreadyDone: false,
        operationId: operation.operationId,
        jobId: operation.jobId,
      };
    }).immediate();
  } finally {
    db.close();
  }
}

export function syncRollingEmailCard(input: {
  dbPath?: string;
  now?: Date;
} = {}): string {
  const now = (input.now ?? new Date()).toISOString();
  const db = openLocalDatabase(input.dbPath);
  try {
    return db.transaction(() => syncRollingCard(db, now)).immediate();
  } finally {
    db.close();
  }
}
