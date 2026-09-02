/**
 * Executes the durable Gmail operation outbox.
 *
 * Every retry first re-observes the exact thread or message so an uncertain
 * draft or archive is reconciled instead of duplicated. Provider success is
 * finalized in SQLite only after the observed Gmail state satisfies the claimed
 * operation. The gateway type intentionally exposes no send operation.
 */
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import path from "node:path";
import { openLocalDatabase } from "../local/database";
import type { ScheduledJob } from "../reliability/jobs";
import { recordReceiptInDatabase } from "../reliability/receipts";
import type { RestrictedMailGateway } from "../workspace";
import { WorkspaceGatewayError } from "../workspace";
import {
  draftBodyToHtml,
  normalizeDraftBody,
  signatureHtmlToText,
  stripTrailingSignature,
} from "./draft-format";
import { loadSignature } from "./signature";
import { ensureRollingEmailCardInDatabase } from "./state-machine";

type OperationRow = {
  id: string;
  email_item_id: string;
  thread_id: string;
  expected_message_id: string;
  expected_thread_version: number;
  kind: "upsert_draft" | "archive_messages";
  operation_key: string;
  payload_json: string;
  status: "pending" | "uncertain" | "succeeded" | "superseded" | "dead";
  remote_id: string | null;
  expected_internal_date: string | null;
};

function operation(db: Database.Database, id: string): OperationRow | undefined {
  return db.prepare(
    `SELECT operation.*, message.internal_date AS expected_internal_date
     FROM cove_gmail_operations operation
     JOIN cove_email_messages message
       ON message.message_id = operation.expected_message_id
     WHERE operation.id = ?`,
  ).get(id) as OperationRow | undefined;
}

function numericDate(value: string | null | undefined): bigint {
  try {
    return BigInt(value || "0");
  } catch {
    return BigInt(0);
  }
}

function jobOperationId(job: ScheduledJob): string {
  if (!job.payload || typeof job.payload !== "object" || Array.isArray(job.payload)) {
    throw new Error("Gmail operation job payload is invalid.");
  }
  const value = (job.payload as Record<string, unknown>).operationId;
  if (typeof value !== "string" || !value) {
    throw new Error("Gmail operation id is missing.");
  }
  return value;
}

function currentVersion(db: Database.Database, row: OperationRow): boolean {
  const current = db.prepare(
    `SELECT 1 FROM email_items
     WHERE id = ? AND thread_id = ? AND thread_version = ?
       AND latest_inbound_message_id = ?`,
  ).get(
    row.email_item_id,
    row.thread_id,
    row.expected_thread_version,
    row.expected_message_id,
  );
  return Boolean(current);
}

function parsedPayload(row: OperationRow): Record<string, unknown> {
  try {
    const value = JSON.parse(row.payload_json) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function headerValue(
  message: Awaited<ReturnType<RestrictedMailGateway["getMessage"]>>,
  name: string,
): string {
  return message.headers.find(
    (header) => header.name.toLowerCase() === name.toLowerCase(),
  )?.value ?? "";
}

async function findOperationDraft(
  gateway: RestrictedMailGateway,
  row: OperationRow,
  existingDraftId?: string,
): Promise<{
  draft: { id: string; messageId: string; threadId: string };
  exactOperation: boolean;
} | undefined> {
  let pageToken: string | undefined;
  const seenPageTokens = new Set<string>();
  let sameThreadDraft: { id: string; messageId: string; threadId: string } | undefined;
  let requestedDraft: { id: string; messageId: string; threadId: string } | undefined;
  do {
    const page = await gateway.listDrafts({ pageToken, maxResults: 500 });
    for (const draft of page.drafts) {
      if (draft.threadId !== row.thread_id) continue;
      sameThreadDraft ??= draft;
      if (draft.id === existingDraftId) requestedDraft = draft;
      const message = await gateway.getMessage({
        messageId: draft.messageId,
        format: "metadata",
      });
      if (headerValue(message, "X-Cove-Operation-Id") === row.operation_key) {
        return { draft, exactOperation: true };
      }
    }
    pageToken = page.nextPageToken;
    if (pageToken && seenPageTokens.has(pageToken)) {
      throw new WorkspaceGatewayError({
        code: "provider_contract",
        operation: "gmail_list_drafts",
        safeMessage: "Google returned a repeated drafts page.",
      });
    }
    if (pageToken) seenPageTokens.add(pageToken);
  } while (pageToken);
  if (requestedDraft) return { draft: requestedDraft, exactOperation: false };
  return sameThreadDraft
    ? { draft: sameThreadDraft, exactOperation: false }
    : undefined;
}

export function createGmailOperationHandler(input: {
  gateway: RestrictedMailGateway;
  dbPath?: string;
  dataDir?: string;
  cachedSignature?: ReturnType<typeof loadSignature>;
  now?: () => Date;
  warn?: (message: string) => void;
}) {
  let signatureLoaded = Object.prototype.hasOwnProperty.call(input, "cachedSignature");
  let signature: ReturnType<typeof loadSignature> = input.cachedSignature ?? null;
  let missingSignatureWarned = false;
  const getCachedSignature = () => {
    if (!signatureLoaded) {
      signatureLoaded = true;
      signature = loadSignature(
        input.dataDir ?? (input.dbPath ? path.dirname(input.dbPath) : undefined),
        input.gateway.accountEmail,
      );
    }
    if (!signature && !missingSignatureWarned) {
      missingSignatureWarned = true;
      (input.warn ?? console.warn)(
        "Cove email signature cache is missing. Run `npm run email:signature-sync` to refresh it.",
      );
    }
    return signature;
  };
  return async (job: ScheduledJob): Promise<{
    summary: string;
    actions: unknown;
  }> => {
    const now = (input.now ?? (() => new Date()))().toISOString();
    const operationId = jobOperationId(job);
    let row: OperationRow;
    const inspect = openLocalDatabase(input.dbPath);
    try {
      const found = operation(inspect, operationId);
      if (!found) throw new Error("Gmail operation was not found.");
      if (found.status === "succeeded" || found.status === "superseded") {
        return {
          summary: "Gmail operation was already complete.",
          actions: { operationId, status: found.status },
        };
      }
      if (!currentVersion(inspect, found)) {
        inspect.prepare(
          `UPDATE cove_gmail_operations
           SET status = 'superseded', updated_at = ?, completed_at = ?
           WHERE id = ? AND status IN ('pending','uncertain')`,
        ).run(now, now, found.id);
        return {
          summary: "A newer email superseded the pending Gmail operation.",
          actions: { operationId, status: "superseded" },
        };
      }
      row = found;
    } finally {
      inspect.close();
    }

    const payload = parsedPayload(row);
    let remoteId: string | null = row.remote_id;
    let draftBodyVerified = false;
    let preservedExistingDraft = false;
    try {
      if (row.kind === "archive_messages") {
        const requestedMessageIds = Array.isArray(payload.messageIds)
          ? payload.messageIds.filter((value): value is string => typeof value === "string")
          : [];
        if (requestedMessageIds.length === 0) {
          throw new Error("Archive operation has no messages.");
        }
        const thread = await input.gateway.getThread({
          threadId: row.thread_id,
          format: "metadata",
        });
        const cutoff = numericDate(row.expected_internal_date);
        const requested = new Set(requestedMessageIds);
        const messageIds = thread.messages
          .filter((message) =>
            message.labelIds.includes("INBOX") &&
            (cutoff > BigInt(0)
              ? numericDate(message.internalDate) <= cutoff
              : requested.has(message.id))
          )
          .map((message) => message.id);
        for (let index = 0; index < messageIds.length; index += 100) {
          await input.gateway.archiveMessages({
            messageIds: messageIds.slice(index, index + 100),
          });
        }
      } else {
        const existing = await findOperationDraft(
          input.gateway,
          row,
          typeof payload.existingDraftId === "string" ? payload.existingDraftId : undefined,
        );
        if (existing) {
          remoteId = existing.draft.id;
          if (existing.exactOperation) {
            draftBodyVerified = true;
          } else if (
            payload.existingDraftId === existing.draft.id &&
            typeof payload.existingDraftBodyHash === "string"
          ) {
            const storedSignature = getCachedSignature();
            const prior = await input.gateway.getMessage({
              messageId: existing.draft.messageId,
              format: "full",
            });
            const signatureText = storedSignature
              ? signatureHtmlToText(storedSignature.html)
              : "";
            const priorBody = normalizeDraftBody(
              stripTrailingSignature(prior.text, signatureText),
            );
            const priorHash = createHash("sha256").update(priorBody).digest("hex");
            if (priorHash === payload.existingDraftBodyHash) {
              if (typeof payload.body !== "string" || !payload.body.trim()) {
                throw new Error("Draft operation has no body.");
              }
              const updated = await input.gateway.createReplyDraft({
                threadId: row.thread_id,
                sourceMessageId: row.expected_message_id,
                body: signatureText ? `${payload.body}\n\n${signatureText}` : payload.body,
                htmlBody: draftBodyToHtml(payload.body, storedSignature?.html),
                idempotencyKey: row.operation_key,
                existingDraftId: existing.draft.id,
              });
              remoteId = updated.id;
              draftBodyVerified = true;
            } else {
              preservedExistingDraft = true;
            }
          } else {
            preservedExistingDraft = true;
          }
        } else if (row.status === "uncertain") {
          throw new WorkspaceGatewayError({
            code: "unknown_write_outcome",
            operation: "gmail_create_reply_draft",
            safeMessage: "Cove could not prove whether Google received the draft, so it will not create another.",
          });
        } else {
          if (typeof payload.body !== "string" || !payload.body.trim()) {
            throw new Error("Draft operation has no body.");
          }
          const storedSignature = getCachedSignature();
          const signatureText = storedSignature
            ? signatureHtmlToText(storedSignature.html)
            : "";
          const created = await input.gateway.createReplyDraft({
            threadId: row.thread_id,
            sourceMessageId: row.expected_message_id,
            body: signatureText ? `${payload.body}\n\n${signatureText}` : payload.body,
            htmlBody: draftBodyToHtml(payload.body, storedSignature?.html),
            idempotencyKey: row.operation_key,
          });
          remoteId = created.id;
          draftBodyVerified = true;
        }
      }
    } catch (error) {
      if (error instanceof WorkspaceGatewayError && error.code === "unknown_write_outcome") {
        const db = openLocalDatabase(input.dbPath);
        try {
          db.prepare(
            `UPDATE cove_gmail_operations
             SET status = 'uncertain', last_error = ?, updated_at = ?
             WHERE id = ? AND status IN ('pending','uncertain')`,
          ).run(error.message.slice(0, 2_000), now, row.id);
        } finally {
          db.close();
        }
      }
      throw error;
    }

    const finalize = openLocalDatabase(input.dbPath);
    try {
      return finalize.transaction(() => {
        const current = operation(finalize, row.id);
        if (!current || !currentVersion(finalize, current)) {
          if (current) {
            finalize.prepare(
              `UPDATE cove_gmail_operations
               SET status = 'superseded', updated_at = ?, completed_at = ?
               WHERE id = ?`,
            ).run(now, now, current.id);
          }
          return {
            summary: "A newer email superseded the completed Gmail operation.",
            actions: { operationId, status: "superseded" },
          };
        }
        finalize.prepare(
          `UPDATE cove_gmail_operations
           SET status = 'succeeded', remote_id = ?, result_json = ?,
               last_error = NULL, updated_at = ?, completed_at = ?
           WHERE id = ?`,
        ).run(
          remoteId,
          JSON.stringify({
            remoteId,
            draftBodyVerified,
            preservedExistingDraft,
          }),
          now,
          now,
          current.id,
        );
        if (current.kind === "archive_messages") {
          finalize.prepare(
            `UPDATE email_items
             SET workflow_state = 'terminal', status = 'actioned',
                 actioned_at = ?, updated_at = ?
             WHERE id = ? AND thread_version = ?`,
          ).run(now, now, current.email_item_id, current.expected_thread_version);
          recordReceiptInDatabase(finalize, {
            source: "email-archive",
            startedAt: now,
            finishedAt: now,
            summary: "Handled email was archived after Gmail confirmed the change.",
            actions: {
              emailItemId: current.email_item_id,
              threadId: current.thread_id,
              operationId: current.id,
            },
            outcome: "success",
          });
        } else {
          const body = typeof payload.body === "string" ? payload.body : "";
          const draftBodyHash = createHash("sha256").update(body).digest("hex");
          finalize.prepare(
            `UPDATE email_items
             SET workflow_state = 'open', status = 'pending',
                 gmail_draft_id = ?, draft_body_hash = ?,
                 recommended_action = CASE WHEN ? = 1
                   THEN 'Review the existing Gmail draft against the latest message'
                   ELSE recommended_action END,
                 surfaced_message_id = ?, surfaced_at = ?, updated_at = ?
             WHERE id = ? AND thread_version = ?`,
          ).run(
            remoteId,
            // Deliberately hash only the normalized model body. The appended
            // signature can refresh independently without changing draft identity.
            draftBodyVerified
              ? draftBodyHash
              : null,
            preservedExistingDraft ? 1 : 0,
            current.expected_message_id,
            now,
            now,
            current.email_item_id,
            current.expected_thread_version,
          );
          if (draftBodyVerified) {
            try {
              const judgeScore = Number.isInteger(payload.voiceJudgeScore) &&
                  Number(payload.voiceJudgeScore) >= 0 &&
                  Number(payload.voiceJudgeScore) <= 100
                ? Number(payload.voiceJudgeScore)
                : null;
              const judgeVerdict = typeof payload.voiceJudgeVerdict === "string"
                ? payload.voiceJudgeVerdict.trim().slice(0, 300) || null
                : null;
              finalize.prepare(
                `INSERT INTO email_draft_outcomes
                   (email_item_id, thread_id, gmail_draft_id, draft_body,
                    draft_body_hash, drafted_at, judge_score, judge_verdict)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              ).run(
                current.email_item_id,
                current.thread_id,
                remoteId,
                body,
                draftBodyHash,
                now,
                judgeScore,
                judgeVerdict,
              );
            } catch (error) {
              (input.warn ?? console.warn)(
                `Cove could not record the email draft outcome: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }
          const receipt = recordReceiptInDatabase(finalize, {
            source: "email-surfaced",
            startedAt: now,
            finishedAt: now,
            summary: preservedExistingDraft
              ? "An existing Gmail draft was preserved and needs review against the latest message."
              : "A reply draft is ready in Gmail and appears on the rolling Email card.",
            actions: {
              emailItemId: current.email_item_id,
              threadId: current.thread_id,
              operationId: current.id,
              draftId: remoteId,
              draftBodyVerified,
              preservedExistingDraft,
            },
            outcome: "success",
          });
          finalize.prepare(
            "UPDATE email_items SET surface_receipt_id = ? WHERE id = ?",
          ).run(receipt.id, current.email_item_id);
        }
        const open = Boolean(finalize.prepare(
          "SELECT 1 FROM email_items WHERE status = 'pending' LIMIT 1",
        ).get());
        ensureRollingEmailCardInDatabase(finalize, { now, open });
        finalize.prepare(
          `UPDATE cove_failure_inbox
           SET dismissed_at = ?
           WHERE source = 'job' AND source_id = ? AND dismissed_at IS NULL`,
        ).run(now, job.id);
        return {
          summary: current.kind === "archive_messages"
            ? "Archived handled email."
            : preservedExistingDraft
              ? "Preserved the existing thread draft and flagged it for review."
              : "Prepared reply draft without creating a duplicate.",
          actions: {
            operationId: current.id,
            kind: current.kind,
            remoteId,
            draftBodyVerified,
            preservedExistingDraft,
          },
        };
      }).immediate();
    } finally {
      finalize.close();
    }
  };
}

export function reconcileDeadEmailJobs(input: {
  dbPath?: string;
  now?: Date;
} = {}): { operations: number; classifications: number } {
  const now = (input.now ?? new Date()).toISOString();
  const db = openLocalDatabase(input.dbPath);
  try {
    return db.transaction(() => {
      const deadOperations = db.prepare(
        `SELECT operation.id, operation.email_item_id
         FROM cove_gmail_operations operation
         JOIN cove_jobs job ON job.id = operation.job_id
         WHERE job.status = 'dead'
           AND operation.status IN ('pending','uncertain')`,
      ).all() as Array<{ id: string; email_item_id: string }>;
      for (const operation of deadOperations) {
        db.prepare(
          `UPDATE cove_gmail_operations
           SET status = 'dead', updated_at = ?, completed_at = ? WHERE id = ?`,
        ).run(now, now, operation.id);
        db.prepare(
          `UPDATE email_items
           SET workflow_state = 'failed', status = 'pending', updated_at = ?
           WHERE id = ? AND workflow_state != 'terminal'`,
        ).run(now, operation.email_item_id);
      }
      const deadClassifications = db.prepare(
        `SELECT DISTINCT message.message_id, message.email_item_id
         FROM cove_email_messages message
         JOIN cove_jobs job
           ON job.type = 'email-classify'
          AND (
            job.idempotency_key = 'email-classify:' || message.message_id
            OR (
              job.idempotency_key LIKE 'email-draft-refresh:' || message.email_item_id || ':%'
              AND json_extract(job.payload, '$.messageId') = message.message_id
            )
          )
         WHERE job.status = 'dead'
           AND message.state IN ('observed','classifying','failed')`,
      ).all() as Array<{ message_id: string; email_item_id: string }>;
      for (const message of deadClassifications) {
        db.prepare(
          `UPDATE cove_email_messages
           SET state = 'failed', updated_at = ? WHERE message_id = ?`,
        ).run(now, message.message_id);
        db.prepare(
          `UPDATE email_items
           SET workflow_state = 'failed', status = 'pending', updated_at = ?
           WHERE id = ? AND workflow_state != 'terminal'`,
        ).run(now, message.email_item_id);
      }
      return {
        operations: deadOperations.length,
        classifications: deadClassifications.length,
      };
    }).immediate();
  } finally {
    db.close();
  }
}
