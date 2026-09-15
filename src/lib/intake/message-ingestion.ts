import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { openLocalDatabase } from "../local/database";
import {
  recordFailureInDatabase,
} from "../reliability/failures";
import {
  recordReceiptInDatabase,
  type ReceiptOutcome,
} from "../reliability/receipts";

export type IngestionDoor = "watcher" | "triage";
export type IngestionStatus = "processing" | "retry" | "processed" | "failed";

export type MessageIngestionRow = {
  messageId: string;
  threadId: string;
  sourceDoor: IngestionDoor;
  detectedTool: string;
  status: IngestionStatus;
  leaseToken: string | null;
  leaseUntil: string | null;
  attempts: number;
  processedAt: string | null;
  outcome: string | null;
  receiptId: string | null;
  lastError: string | null;
};

type MessageIngestionDatabaseRow = {
  message_id: string;
  thread_id: string;
  source_door: IngestionDoor;
  detected_tool: string;
  status: IngestionStatus;
  lease_token: string | null;
  lease_until: string | null;
  attempts: number;
  processed_at: string | null;
  outcome: string | null;
  receipt_id: string | null;
  last_error: string | null;
};

export type MessageIngestionClaim =
  | {
      claimed: true;
      leaseToken: string;
      attempts: number;
      recovered: boolean;
    }
  | {
      claimed: false;
      reason: "already-processed" | "already-failed" | "lease-active";
      row: MessageIngestionRow;
    };

function decodeRow(row: MessageIngestionDatabaseRow): MessageIngestionRow {
  return {
    messageId: row.message_id,
    threadId: row.thread_id,
    sourceDoor: row.source_door,
    detectedTool: row.detected_tool,
    status: row.status,
    leaseToken: row.lease_token,
    leaseUntil: row.lease_until,
    attempts: row.attempts,
    processedAt: row.processed_at,
    outcome: row.outcome,
    receiptId: row.receipt_id,
    lastError: row.last_error,
  };
}

function rowForMessage(
  db: Database.Database,
  messageId: string,
): MessageIngestionDatabaseRow {
  const row = db.prepare(
    "SELECT * FROM cove_message_ingestion WHERE message_id = ?",
  ).get(messageId) as MessageIngestionDatabaseRow | undefined;
  if (!row) throw new Error("Message ingestion claim disappeared.");
  return row;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000) || "Meeting notes processing failed.";
}

export function claimMessageIngestion(input: {
  messageId: string;
  threadId: string;
  sourceDoor: IngestionDoor;
  detectedTool: string;
  dbPath?: string;
  now?: Date;
  leaseMs?: number;
}): MessageIngestionClaim {
  const messageId = input.messageId.trim();
  const threadId = input.threadId.trim();
  const detectedTool = input.detectedTool.trim().toLowerCase();
  if (!messageId || !threadId || !detectedTool) {
    throw new Error("Message id, thread id, and detected tool are required.");
  }
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const leaseUntil = new Date(
    now.getTime() + Math.max(10_000, input.leaseMs ?? 5 * 60_000),
  ).toISOString();
  const leaseToken = randomUUID();
  const db = openLocalDatabase(input.dbPath);
  try {
    return db.transaction(() => {
      const inserted = db.prepare(
        `INSERT OR IGNORE INTO cove_message_ingestion
           (message_id, thread_id, source_door, detected_tool, status,
            lease_token, lease_until, attempts, processed_at, outcome,
            receipt_id, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'processing', ?, ?, 1, NULL, NULL, NULL, NULL, ?, ?)`,
      ).run(
        messageId,
        threadId,
        input.sourceDoor,
        detectedTool,
        leaseToken,
        leaseUntil,
        nowIso,
        nowIso,
      );
      if (inserted.changes === 1) {
        return {
          claimed: true as const,
          leaseToken,
          attempts: 1,
          recovered: false,
        };
      }

      const existing = rowForMessage(db, messageId);
      if (existing.status === "processed") {
        return {
          claimed: false as const,
          reason: "already-processed" as const,
          row: decodeRow(existing),
        };
      }
      if (existing.status === "failed") {
        return {
          claimed: false as const,
          reason: "already-failed" as const,
          row: decodeRow(existing),
        };
      }
      if (
        existing.status === "processing" &&
        existing.lease_until &&
        existing.lease_until > nowIso
      ) {
        return {
          claimed: false as const,
          reason: "lease-active" as const,
          row: decodeRow(existing),
        };
      }

      const recovered = db.prepare(
        `UPDATE cove_message_ingestion
         SET status = 'processing',
             lease_token = ?,
             lease_until = ?,
             attempts = attempts + 1,
             last_error = NULL,
             updated_at = ?
         WHERE message_id = ?
           AND (
             status = 'retry'
             OR (status = 'processing' AND (lease_until IS NULL OR lease_until <= ?))
           )`,
      ).run(leaseToken, leaseUntil, nowIso, messageId, nowIso);
      if (recovered.changes !== 1) {
        const current = rowForMessage(db, messageId);
        return {
          claimed: false as const,
          reason: "lease-active" as const,
          row: decodeRow(current),
        };
      }
      const current = rowForMessage(db, messageId);
      return {
        claimed: true as const,
        leaseToken,
        attempts: current.attempts,
        recovered: true,
      };
    }).immediate();
  } finally {
    db.close();
  }
}

/** Persist the first validated extraction before side effects and reuse it on
 * retries. A lost claimant cannot replace the next claimant's snapshot. */
export function messageIngestionExtraction(input: {
  messageId: string;
  leaseToken: string;
  extraction?: unknown[];
  dbPath?: string;
}): unknown {
  const db = openLocalDatabase(input.dbPath);
  try {
    return db.transaction(() => {
      const current = rowForMessage(db, input.messageId);
      if (current.status !== "processing" || current.lease_token !== input.leaseToken) {
        throw new Error("Message ingestion lease is no longer owned.");
      }
      const saved = db.prepare("SELECT followups_json FROM cove_message_ingestion WHERE message_id = ?")
        .get(input.messageId) as { followups_json: string | null };
      if (saved.followups_json !== null) return JSON.parse(saved.followups_json) as unknown;
      if (input.extraction === undefined) return undefined;
      const serialized = JSON.stringify(input.extraction);
      db.prepare("UPDATE cove_message_ingestion SET followups_json = ? WHERE message_id = ? AND lease_token = ? AND followups_json IS NULL")
        .run(serialized, input.messageId, input.leaseToken);
      return JSON.parse(serialized) as unknown;
    }).immediate();
  } finally { db.close(); }
}

export function completeMessageIngestion(input: {
  messageId: string;
  leaseToken: string;
  startedAt: string;
  summary: string;
  actions: unknown;
  outcome: Extract<ReceiptOutcome, "success" | "partial">;
  attempts: number;
  dbPath?: string;
  now?: Date;
}): MessageIngestionRow {
  const finishedAt = (input.now ?? new Date()).toISOString();
  const db = openLocalDatabase(input.dbPath);
  try {
    return db.transaction(() => {
      const current = rowForMessage(db, input.messageId);
      if (
        current.status !== "processing" ||
        current.lease_token !== input.leaseToken
      ) {
        throw new Error("Message ingestion lease is no longer owned.");
      }
      const receipt = recordReceiptInDatabase(db, {
        source: "meeting-intake",
        startedAt: input.startedAt,
        finishedAt,
        summary: input.summary,
        actions: input.actions,
        retryCount: Math.max(0, input.attempts - 1),
        outcome: input.outcome,
        failureKey: input.messageId,
        surfaceFailure: false,
      });
      db.prepare(
        `UPDATE cove_message_ingestion
         SET status = 'processed',
             lease_token = NULL,
             lease_until = NULL,
             processed_at = ?,
             outcome = ?,
             receipt_id = ?,
             last_error = NULL,
             updated_at = ?
         WHERE message_id = ? AND lease_token = ?`,
      ).run(
        finishedAt,
        input.outcome,
        receipt.id,
        finishedAt,
        input.messageId,
        input.leaseToken,
      );
      db.prepare(
        `UPDATE cove_failure_inbox
         SET dismissed_at = ?
         WHERE source = 'meeting-intake'
           AND source_id = ?
           AND dismissed_at IS NULL`,
      ).run(finishedAt, input.messageId);
      return decodeRow(rowForMessage(db, input.messageId));
    }).immediate();
  } finally {
    db.close();
  }
}

export function renewMessageIngestionLease(input: {
  messageId: string;
  leaseToken: string;
  dbPath?: string;
  now?: Date;
  leaseMs?: number;
}): boolean {
  const now = input.now ?? new Date();
  const leaseUntil = new Date(
    now.getTime() + Math.max(10_000, input.leaseMs ?? 5 * 60_000),
  ).toISOString();
  const db = openLocalDatabase(input.dbPath);
  try {
    return db.prepare(
      `UPDATE cove_message_ingestion
       SET lease_until = ?, updated_at = ?
       WHERE message_id = ?
         AND lease_token = ?
         AND status = 'processing'`,
    ).run(
      leaseUntil,
      now.toISOString(),
      input.messageId,
      input.leaseToken,
    ).changes === 1;
  } finally {
    db.close();
  }
}

export function failMessageIngestion(input: {
  messageId: string;
  leaseToken: string;
  startedAt: string;
  attempts: number;
  error: unknown;
  maxAttempts?: number;
  dbPath?: string;
  now?: Date;
}): MessageIngestionRow {
  const failedAt = (input.now ?? new Date()).toISOString();
  const message = boundedError(input.error);
  const terminal = input.attempts >= Math.max(1, input.maxAttempts ?? 5);
  const db = openLocalDatabase(input.dbPath);
  try {
    return db.transaction(() => {
      const current = rowForMessage(db, input.messageId);
      if (
        current.status !== "processing" ||
        current.lease_token !== input.leaseToken
      ) {
        return decodeRow(current);
      }
      let receiptId: string | null = null;
      if (terminal) {
        receiptId = recordReceiptInDatabase(db, {
          source: "meeting-intake",
          startedAt: input.startedAt,
          finishedAt: failedAt,
          summary: `Meeting notes could not be processed after ${input.attempts} attempts.`,
          actions: { messageId: input.messageId, error: message },
          retryCount: Math.max(0, input.attempts - 1),
          outcome: "failed",
          failureKey: input.messageId,
          failureMessage: message,
        }).id;
        db.prepare(
          `UPDATE cove_failure_inbox
           SET dismissed_at = ?
           WHERE source = 'meeting-intake'
             AND source_id = ?
             AND dismissed_at IS NULL`,
        ).run(failedAt, input.messageId);
      } else {
        recordFailureInDatabase(db, {
          source: "meeting-intake",
          sourceId: input.messageId,
          message: `Meeting notes will retry: ${message}`,
          details: {
            messageId: input.messageId,
            attempts: input.attempts,
            error: message,
          },
          occurredAt: failedAt,
        });
      }
      db.prepare(
        `UPDATE cove_message_ingestion
         SET status = ?,
             lease_token = NULL,
             lease_until = NULL,
             processed_at = ?,
             outcome = ?,
             receipt_id = ?,
             last_error = ?,
             updated_at = ?
         WHERE message_id = ? AND lease_token = ?`,
      ).run(
        terminal ? "failed" : "retry",
        terminal ? failedAt : null,
        terminal ? "failed" : "retry",
        receiptId,
        message,
        failedAt,
        input.messageId,
        input.leaseToken,
      );
      return decodeRow(rowForMessage(db, input.messageId));
    }).immediate();
  } finally {
    db.close();
  }
}

export function getMessageIngestion(
  messageId: string,
  options: { dbPath?: string } = {},
): MessageIngestionRow | undefined {
  const db = openLocalDatabase(options.dbPath);
  try {
    const row = db.prepare(
      "SELECT * FROM cove_message_ingestion WHERE message_id = ?",
    ).get(messageId) as MessageIngestionDatabaseRow | undefined;
    return row ? decodeRow(row) : undefined;
  } finally {
    db.close();
  }
}
