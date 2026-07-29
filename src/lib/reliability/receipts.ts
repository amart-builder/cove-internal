import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { openLocalDatabase } from "../local/database";
import { recordFailureInDatabase } from "./failures";

export type ReceiptOutcome = "success" | "partial" | "failed" | "skipped";

export type Receipt = {
  id: string;
  source: string;
  startedAt: string;
  finishedAt: string;
  summary: string;
  actions: unknown;
  retryCount: number;
  outcome: ReceiptOutcome;
};

type ReceiptRow = {
  id: string;
  source: string;
  started_at: string;
  finished_at: string;
  summary: string;
  actions_json: string;
  retry_count: number;
  outcome: ReceiptOutcome;
};

function decodeReceipt(row: ReceiptRow): Receipt {
  let actions: unknown = {};
  try {
    actions = JSON.parse(row.actions_json);
  } catch {
    actions = { raw: row.actions_json };
  }
  return {
    id: row.id,
    source: row.source,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    summary: row.summary,
    actions,
    retryCount: row.retry_count,
    outcome: row.outcome,
  };
}

export function recordReceiptInDatabase(
  db: Database.Database,
  input: {
    source: string;
    startedAt: string;
    finishedAt?: string;
    summary: string;
    actions?: unknown;
    retryCount?: number;
    outcome: ReceiptOutcome;
    failureMessage?: string;
    failureKey?: string;
    surfaceFailure?: boolean;
  },
): Receipt {
  const id = randomUUID();
  const source = input.source.trim().slice(0, 120);
  const finishedAt = input.finishedAt ?? new Date().toISOString();
  const actionsJson = JSON.stringify(input.actions ?? {});
  if (actionsJson.length > 100_000) {
    throw new Error("Receipt actions exceed 100000 characters.");
  }
  const retryCount = Math.max(0, Math.trunc(input.retryCount ?? 0));
  db.prepare(
    `INSERT INTO forge_receipts
       (id, source, started_at, finished_at, summary, actions_json,
        retry_count, outcome, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    source,
    input.startedAt,
    finishedAt,
    input.summary.trim().slice(0, 2000),
    actionsJson,
    retryCount,
    input.outcome,
    finishedAt,
  );
  if (
    input.surfaceFailure !== false &&
    (input.outcome === "failed" || input.outcome === "partial")
  ) {
    const failureKey = input.failureKey?.trim() || source;
    recordFailureInDatabase(db, {
      source: "receipt",
      sourceId: `${source}:${failureKey}`.slice(0, 240),
      message: input.failureMessage ?? input.summary,
      details: {
        receiptId: id,
        receiptSource: source,
        failureKey,
        outcome: input.outcome,
        actions: input.actions ?? {},
      },
      occurredAt: finishedAt,
    });
  }
  const row = db.prepare(
    "SELECT * FROM forge_receipts WHERE id = ?",
  ).get(id) as ReceiptRow;
  return decodeReceipt(row);
}

export function recordReceipt(
  input: Parameters<typeof recordReceiptInDatabase>[1] & { dbPath?: string },
): Receipt {
  const db = openLocalDatabase(input.dbPath);
  try {
    return db.transaction(() => recordReceiptInDatabase(db, input))();
  } finally {
    db.close();
  }
}

export function listRecentReceipts(
  options: { dbPath?: string; limit?: number; source?: string } = {},
): Receipt[] {
  const db = openLocalDatabase(options.dbPath);
  try {
    const limit = Math.min(200, Math.max(1, options.limit ?? 30));
    const rows = options.source
      ? db.prepare(
          `SELECT * FROM forge_receipts
           WHERE source = ?
           ORDER BY finished_at DESC
           LIMIT ?`,
        ).all(options.source, limit)
      : db.prepare(
          `SELECT * FROM forge_receipts
           ORDER BY finished_at DESC
           LIMIT ?`,
        ).all(limit);
    return (rows as ReceiptRow[]).map(decodeReceipt);
  } finally {
    db.close();
  }
}

export function hasReceiptForSourceStartedAt(input: {
  source: string;
  startedAt: string;
  dbPath?: string;
}): boolean {
  const db = openLocalDatabase(input.dbPath);
  try {
    return Boolean(db.prepare(
      `SELECT 1 FROM forge_receipts
       WHERE source = ? AND started_at = ?
       LIMIT 1`,
    ).get(input.source, input.startedAt));
  } finally {
    db.close();
  }
}
