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

export type ReceiptActivity = {
  id: string;
  title: string;
  detail: string;
  occurredAt: string;
  needsAttention: boolean;
};

export type ReceiptActivityCursor = {
  finishedAt: string;
  id: string;
};

export type ReceiptDigest = {
  since: string | null;
  inboxChecks: number;
  meetingsProcessed: number;
  backupOk: boolean;
  content: string;
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
  options: {
    dbPath?: string;
    limit?: number;
    offset?: number;
    source?: string;
  } = {},
): Receipt[] {
  const db = openLocalDatabase(options.dbPath);
  try {
    const limit = Math.min(200, Math.max(1, options.limit ?? 30));
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    const rows = options.source
      ? db.prepare(
          `SELECT * FROM forge_receipts
           WHERE source = ?
           ORDER BY finished_at DESC
           LIMIT ? OFFSET ?`,
        ).all(options.source, limit, offset)
      : db.prepare(
          `SELECT * FROM forge_receipts
           ORDER BY finished_at DESC
           LIMIT ? OFFSET ?`,
        ).all(limit, offset);
    return (rows as ReceiptRow[]).map(decodeReceipt);
  } finally {
    db.close();
  }
}

const ACTIVITY_SOURCES = [
  "email-triage",
  "meeting-intake",
  "meeting-watch",
  "backup",
  "morning-brief",
  "buddy-feedback",
  "email-gmail-to-card",
  "email-card-to-gmail",
] as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function plural(value: number, singular: string, pluralWord = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : pluralWord}`;
}

export function receiptActivity(receipt: Receipt): ReceiptActivity {
  const actions = record(receipt.actions);
  if (receipt.source === "email-triage") {
    const counts = { ...record(actions.counts), ...actions };
    const needYou = count(counts.needYou ?? counts.need_you ?? counts.needYouCount);
    const action = count(counts.action ?? counts.actionCount);
    const fyi = count(counts.fyi ?? counts.fyiCount);
    const total = Math.max(
      needYou + action + fyi,
      count(counts.reviewed ?? counts.processed ?? counts.total ?? counts.threadCount),
    );
    const drafts = count(counts.drafts ?? counts.drafted ?? counts.draftCount);
    const details = [
      total > 0 ? `${plural(total, "message")} checked` : "Inbox check finished",
      drafts > 0 ? `${plural(drafts, "draft")} prepared` : "",
      needYou > 0 ? `${plural(needYou, "item")} need you` : "",
    ].filter(Boolean).join(", ");
    return {
      id: receipt.id,
      title: "Inbox check",
      detail: `${details}.`,
      occurredAt: receipt.finishedAt,
      needsAttention: receipt.outcome === "partial" || receipt.outcome === "failed",
    };
  }
  if (receipt.source === "meeting-intake" || receipt.source === "meeting-watch") {
    const processed = Math.max(
      count(actions.processed),
      receipt.source === "meeting-intake" && receipt.outcome !== "failed" ? 1 : 0,
    );
    const tasks = count(actions.tasks ?? actions.task_count ?? actions.createdTasks);
    const waiting = count(actions.waiting_on ?? actions.waitingOn);
    const details = [
      processed > 0 ? `${plural(processed, "meeting")} processed` : "Meeting notes checked",
      tasks > 0 ? plural(tasks, "task") : "",
      waiting > 0 ? `${plural(waiting, "follow-up")} still open` : "",
    ].filter(Boolean).join(", ");
    return {
      id: receipt.id,
      title: "Meeting notes",
      detail: `${details}.`,
      occurredAt: receipt.finishedAt,
      needsAttention: receipt.outcome === "partial" || receipt.outcome === "failed",
    };
  }
  if (receipt.source === "backup") {
    return {
      id: receipt.id,
      title: "Backup",
      detail: receipt.outcome === "success"
        ? "Your Cove data was backed up."
        : "The backup needs attention.",
      occurredAt: receipt.finishedAt,
      needsAttention: receipt.outcome !== "success",
    };
  }
  if (receipt.source === "morning-brief") {
    return {
      id: receipt.id,
      title: "Morning brief",
      detail: receipt.outcome === "success"
        ? "Your morning brief was prepared."
        : "Your morning brief needs attention.",
      occurredAt: receipt.finishedAt,
      needsAttention: receipt.outcome !== "success",
    };
  }
  if (receipt.source === "buddy-feedback") {
    return {
      id: receipt.id,
      title: "Feedback",
      detail: actions.delivery === "gmail_draft"
        ? "A Gmail draft was prepared for you."
        : "A message was prepared for you to copy.",
      occurredAt: receipt.finishedAt,
      needsAttention: false,
    };
  }
  const gmailToCard = receipt.source === "email-gmail-to-card";
  return {
    id: receipt.id,
    title: "Email and Cove sync",
    detail: gmailToCard
      ? `${plural(count(actions.changedIds && Array.isArray(actions.changedIds) ? actions.changedIds.length : 0), "item")} checked off from Gmail.`
      : "Your email card and Gmail were brought up to date.",
    occurredAt: receipt.finishedAt,
    needsAttention: receipt.outcome === "partial" || receipt.outcome === "failed",
  };
}

export function listRecentReceiptActivity(
  options: {
    dbPath?: string;
    limit?: number;
    cursor?: ReceiptActivityCursor;
  } = {},
): {
  activities: ReceiptActivity[];
  hasMore: boolean;
  nextCursor?: ReceiptActivityCursor;
} {
  const pageSize = Math.min(50, Math.max(1, options.limit ?? 15));
  const db = openLocalDatabase(options.dbPath);
  try {
    const placeholders = ACTIVITY_SOURCES.map(() => "?").join(", ");
    const cursorClause = options.cursor
      ? "AND (finished_at < ? OR (finished_at = ? AND id < ?))"
      : "";
    const parameters: Array<string | number> = [...ACTIVITY_SOURCES];
    if (options.cursor) {
      parameters.push(
        options.cursor.finishedAt,
        options.cursor.finishedAt,
        options.cursor.id,
      );
    }
    parameters.push(pageSize + 1);
    const rows = db.prepare(
      `SELECT * FROM forge_receipts
       WHERE source IN (${placeholders})
       ${cursorClause}
       ORDER BY finished_at DESC, id DESC
       LIMIT ?`,
    ).all(...parameters) as ReceiptRow[];
    const page = rows.slice(0, pageSize);
    const last = page.at(-1);
    return {
      activities: page.map(decodeReceipt).map(receiptActivity),
      hasMore: rows.length > pageSize,
      ...(last
        ? { nextCursor: { finishedAt: last.finished_at, id: last.id } }
        : {}),
    };
  } finally {
    db.close();
  }
}

export function buildReceiptDigest(
  options: { dbPath?: string } = {},
): ReceiptDigest {
  const db = openLocalDatabase(options.dbPath);
  try {
    const sinceValue = db.prepare(
      `SELECT finished_at FROM forge_receipts
       WHERE source = 'morning-brief' AND outcome = 'success'
       ORDER BY finished_at DESC LIMIT 1`,
    ).pluck().get();
    const since = typeof sinceValue === "string" ? sinceValue : null;
    if (!since) {
      return {
        since: null,
        inboxChecks: 0,
        meetingsProcessed: 0,
        backupOk: false,
        content: "No earlier brief receipt is available yet.",
      };
    }
    const rows = db.prepare(
      `SELECT source, outcome, COUNT(*) AS count
       FROM forge_receipts
       WHERE finished_at > ?
         AND source IN ('email-triage', 'meeting-intake', 'backup')
       GROUP BY source, outcome`,
    ).all(since) as Array<{
      source: string;
      outcome: ReceiptOutcome;
      count: number;
    }>;
    const successful = (source: string) => rows
      .filter((row) =>
        row.source === source &&
        (row.outcome === "success" || row.outcome === "partial")
      )
      .reduce((total, row) => total + row.count, 0);
    const inboxChecks = successful("email-triage");
    const meetingsProcessed = successful("meeting-intake");
    const backupOk = rows.some((row) =>
      row.source === "backup" && row.outcome === "success" && row.count > 0
    );
    const parts = [
      plural(inboxChecks, "inbox check"),
      plural(meetingsProcessed, "meeting"),
      backupOk ? "backup ok" : "no new backup receipt",
    ];
    return {
      since,
      inboxChecks,
      meetingsProcessed,
      backupOk,
      content: `Since the last brief: ${parts.join(", ")}.`,
    };
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
