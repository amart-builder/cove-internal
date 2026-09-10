/**
 * Visible failure inbox for work that needs attention.
 *
 * Failures are deduplicated by source identity and resolved explicitly when the
 * underlying condition clears. This store is not a generic log. Record only a
 * safe message and bounded diagnostic details that help an operator recover.
 */
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { openLocalDatabase } from "../local/database";
import { jobFailureDetail } from "./job-failure-copy";
import { reconcileRecoveredFailures } from "./recoveries";

export type FailureInboxItem = {
  id: string;
  source: string;
  sourceId: string;
  message: string;
  details: unknown;
  occurredAt: string;
  dismissedAt: string | null;
};

type FailureRow = {
  id: string;
  source: string;
  source_id: string;
  message: string;
  details_json: string;
  occurred_at: string;
  dismissed_at: string | null;
};

function decodeFailure(row: FailureRow): FailureInboxItem {
  let details: unknown = {};
  try {
    details = JSON.parse(row.details_json);
  } catch {
    details = { raw: row.details_json };
  }
  // Older scheduler records retain their diagnostics for investigation, while
  // the product view explains the affected work with a cause and recovery step.
  const job = row.source === "job" && details && typeof details === "object" && "type" in details && typeof details.type === "string"
    ? details as { type: string; retrying?: boolean; error?: unknown }
    : undefined;
  const delivery = row.source === "reminder-delivery" && details && typeof details === "object"
    ? details as { title?: string; channel?: string; error?: string } : undefined;
  return {
    id: row.id,
    source: row.source,
    sourceId: row.source_id,
    message: job ? jobFailureDetail(job.type, typeof job.error === "string" ? job.error : row.message, job.retrying ?? row.message.includes("job will retry:"))
      : row.source === "receipt" && /^Meeting analysis jobs failed=\d+ dead=\d+\.$/.test(row.message)
        ? "Some meeting reviews did not finish. Cove will retry eligible reviews automatically; older stopped reviews need recovery."
      : row.source === "meeting-analysis-degraded"
        ? "A meeting review stopped before the deeper analysis finished. Any work already extracted is preserved."
      : delivery
        ? `${delivery.channel === "native" ? "Mac" : "Text"} reminder ${/\b(?:ETIMEDOUT|timeout)\b|timed? out/i.test(delivery.error ?? "") ? "delivery could not be confirmed" : "delivery failed"}${delivery.title ? ` for “${delivery.title}”` : ""}. Check the item in Cove. ${delivery.channel === "imessage" ? "The Mini connection and Messages must be available for text delivery. " : ""}Check the item before requesting another reminder.`
      : row.message,
    details,
    occurredAt: row.occurred_at,
    dismissedAt: row.dismissed_at,
  };
}

export function recordFailureInDatabase(
  db: Database.Database,
  input: {
    source: string;
    sourceId: string;
    message: string;
    details?: unknown;
    occurredAt?: string;
  },
): FailureInboxItem {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const detailsJson = JSON.stringify(input.details ?? {});
  if (detailsJson.length > 100_000) {
    throw new Error("Failure details exceed 100000 characters.");
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO cove_failure_inbox
       (id, source, source_id, message, details_json, occurred_at, dismissed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(source, source_id) DO UPDATE SET
       message = excluded.message,
       details_json = excluded.details_json,
       occurred_at = excluded.occurred_at,
       dismissed_at = NULL`,
  ).run(
    id,
    input.source.slice(0, 120),
    input.sourceId.slice(0, 240),
    input.message.trim().slice(0, 1000),
    detailsJson,
    occurredAt,
    occurredAt,
  );
  const row = db.prepare(
    "SELECT * FROM cove_failure_inbox WHERE source = ? AND source_id = ?",
  ).get(input.source.slice(0, 120), input.sourceId.slice(0, 240)) as FailureRow;
  return decodeFailure(row);
}

export function recordFailure(
  input: Parameters<typeof recordFailureInDatabase>[1] & { dbPath?: string },
): FailureInboxItem {
  const db = openLocalDatabase(input.dbPath);
  try {
    return recordFailureInDatabase(db, input);
  } finally {
    db.close();
  }
}

export function dismissFailure(
  id: string,
  options: { dbPath?: string; dismissedAt?: string } = {},
): boolean {
  const db = openLocalDatabase(options.dbPath);
  try {
    const result = db.prepare(
      `UPDATE cove_failure_inbox
       SET dismissed_at = ?
       WHERE id = ? AND dismissed_at IS NULL`,
    ).run(options.dismissedAt ?? new Date().toISOString(), id);
    return result.changes === 1;
  } finally {
    db.close();
  }
}

export function resolveFailure(
  source: string,
  sourceId: string,
  options: { dbPath?: string; resolvedAt?: string } = {},
): void {
  const db = openLocalDatabase(options.dbPath);
  try {
    db.prepare(
      `UPDATE cove_failure_inbox
       SET dismissed_at = ?
       WHERE source = ? AND source_id = ? AND dismissed_at IS NULL`,
    ).run(options.resolvedAt ?? new Date().toISOString(), source, sourceId);
  } finally {
    db.close();
  }
}

export function listFailures(
  options: { dbPath?: string; limit?: number; includeDismissed?: boolean } = {},
): FailureInboxItem[] {
  const db = openLocalDatabase(options.dbPath);
  try {
    reconcileRecoveredFailures(db);
    const limit = Math.min(200, Math.max(1, options.limit ?? 50));
    const where = options.includeDismissed ? "" : "WHERE dismissed_at IS NULL";
    const rows = db.prepare(
      `SELECT * FROM cove_failure_inbox
       ${where}
       ORDER BY occurred_at DESC
       LIMIT ?`,
    ).all(limit) as FailureRow[];
    return rows.map(decodeFailure);
  } finally {
    db.close();
  }
}
