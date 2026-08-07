/**
 * Audit receipts for effects Cove actually observed.
 *
 * Receipts are user-facing evidence, not a queue or a substitute for provider
 * reconciliation. A partial receipt must name the unfinished remainder. Receipt
 * recording failures surface through the failure inbox rather than changing a
 * successful product effect into a silent one.
 */
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
    `INSERT INTO cove_receipts
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
    "SELECT * FROM cove_receipts WHERE id = ?",
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
          `SELECT * FROM cove_receipts
           WHERE source = ?
           ORDER BY finished_at DESC
           LIMIT ? OFFSET ?`,
        ).all(options.source, limit, offset)
      : db.prepare(
          `SELECT * FROM cove_receipts
           ORDER BY finished_at DESC
           LIMIT ? OFFSET ?`,
        ).all(limit, offset);
    return (rows as ReceiptRow[]).map(decodeReceipt);
  } finally {
    db.close();
  }
}

export const ACTIVITY_SOURCES = [
  "email-triage",
  "meeting-intake",
  "meeting-watch",
  "backup",
  "morning-brief",
  "morning-brief-management",
  "buddy-feedback",
  "email-gmail-to-card",
  "email-gmail-to-card-item",
  "email-card-to-gmail",
  "email-surfaced",
  "email-archive",
  "task-session",
  "email-commitments",
  "email-correspondence",
  "claude-child-reaper",
  "health-collector",
  "recurring-task-spawn",
  "stale-task-watchdog",
  "archived-task-purge",
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

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 240) : "";
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
  if (receipt.source === "morning-brief-management") {
    const applied = count(actions.applied);
    const conflicts = count(actions.skippedConflict);
    const protectedCount = count(actions.skippedOfflimits);
    return {
      id: receipt.id,
      title: "Board organized",
      detail: [
        `${plural(applied, "change")} made`,
        conflicts > 0 ? `${plural(conflicts, "card")} kept after your edit` : "",
        protectedCount > 0 ? `${plural(protectedCount, "protected card")} left alone` : "",
      ].filter(Boolean).join(", ") + ".",
      occurredAt: receipt.finishedAt,
      needsAttention: false,
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
  if (receipt.source === "email-gmail-to-card") {
    return {
      id: receipt.id,
      title: "Email follow-through",
      detail: `${plural(
        count(actions.changedIds && Array.isArray(actions.changedIds)
          ? actions.changedIds.length
          : 0),
        "item",
      )} handled in Gmail.`,
      occurredAt: receipt.finishedAt,
      needsAttention: receipt.outcome === "partial" || receipt.outcome === "failed",
    };
  }
  if (receipt.source === "email-gmail-to-card-item") {
    return {
      id: receipt.id,
      title: "Email checked off",
      detail: "Checked off an email thread handled in Gmail.",
      occurredAt: receipt.finishedAt,
      needsAttention: receipt.outcome !== "success",
    };
  }
  if (receipt.source === "email-card-to-gmail") {
    return {
      id: receipt.id,
      title: "Email archived",
      detail: receipt.outcome === "success"
        ? "The handled email was archived."
        : "Gmail did not confirm the archive, so the email stayed open.",
      occurredAt: receipt.finishedAt,
      needsAttention: receipt.outcome === "partial" || receipt.outcome === "failed",
    };
  }
  if (receipt.source === "email-surfaced") {
    const bucket = text(actions.bucket);
    return {
      id: receipt.id,
      title: bucket === "noise"
        ? "Email auto-archived"
        : bucket === "fyi"
          ? "Email update recorded"
          : "Email needs you",
      detail: receipt.summary,
      occurredAt: receipt.finishedAt,
      needsAttention: receipt.outcome !== "success",
    };
  }
  if (receipt.source === "email-archive") {
    return {
      id: receipt.id,
      title: "Email archived",
      detail: "A handled email was archived after Gmail confirmed it.",
      occurredAt: receipt.finishedAt,
      needsAttention: receipt.outcome !== "success",
    };
  }
  if (receipt.source === "task-session") {
    const taskTitle = text(actions.taskTitle ?? actions.title);
    const subject = taskTitle ? `"${taskTitle}"` : "The task";
    const detail = receipt.outcome === "success"
      ? `${subject} is ready.`
      : receipt.outcome === "partial"
        ? `${subject} stopped before completion.`
        : receipt.outcome === "failed"
          ? `${subject} needs attention.`
          : `${subject} was skipped.`;
    return {
      id: receipt.id,
      title: "Claude session",
      detail,
      occurredAt: receipt.finishedAt,
      needsAttention: receipt.outcome === "partial" || receipt.outcome === "failed",
    };
  }
  if (receipt.source === "email-commitments") {
    const inserted = count(actions.inserted);
    const existing = count(actions.existing);
    const detail = receipt.outcome === "success"
      ? inserted > 0
        ? `${plural(inserted, "promise")} added to Cove${existing > 0 ? `, ${plural(existing, "promise")} already present` : ""}.`
        : existing > 0
          ? `No new promises; ${plural(existing, "promise")} already present.`
          : "No new promises were found."
      : "Email promises need attention.";
    return {
      id: receipt.id,
      title: "Promises captured from email",
      detail,
      occurredAt: receipt.finishedAt,
      needsAttention: receipt.outcome === "partial" || receipt.outcome === "failed",
    };
  }
  if (receipt.source === "email-correspondence") {
    return {
      id: receipt.id,
      title: "People history updated",
      detail: receipt.outcome === "success"
        ? "A meaningful email was added to People."
        : "An email history update needs attention.",
      occurredAt: receipt.finishedAt,
      needsAttention: receipt.outcome === "partial" || receipt.outcome === "failed",
    };
  }
  if (receipt.source === "claude-child-reaper") {
    const lane = text(actions.lane);
    return {
      id: receipt.id,
      title: "Background cleanup",
      detail: lane
        ? `A stalled ${lane === "session" ? "Claude session" : `${lane} process`} was cleaned up.`
        : "A stalled Claude process was cleaned up.",
      occurredAt: receipt.finishedAt,
      needsAttention: receipt.outcome === "partial" || receipt.outcome === "failed",
    };
  }
  if (receipt.source === "health-collector") {
    return {
      id: receipt.id,
      title: "Health check",
      detail: receipt.outcome === "success"
        ? "Cove's system and adoption signals were checked."
        : "Cove's health check needs attention.",
      occurredAt: receipt.finishedAt,
      needsAttention: receipt.outcome === "partial" || receipt.outcome === "failed",
    };
  }
  if (receipt.source === "recurring-task-spawn") {
    return {
      id: receipt.id,
      title: "Recurring tasks",
      detail: `${plural(count(actions.spawned), "task")} added, ${plural(
        count(actions.missed),
        "task",
      )} missed.`,
      occurredAt: receipt.finishedAt,
      needsAttention: receipt.outcome === "partial" || receipt.outcome === "failed",
    };
  }
  if (receipt.source === "stale-task-watchdog") {
    return {
      id: receipt.id,
      title: "Stale-task check",
      detail: `${plural(count(actions.stale), "stale task")} found, ${plural(
        count(actions.suggestionsFiled),
        "quiet check",
      )} filed.`,
      occurredAt: receipt.finishedAt,
      needsAttention: receipt.outcome === "partial" || receipt.outcome === "failed",
    };
  }
  if (receipt.source === "archived-task-purge") {
    return {
      id: receipt.id,
      title: "Old task cleanup",
      detail: `${plural(count(actions.purged), "old task")} permanently removed.`,
      occurredAt: receipt.finishedAt,
      needsAttention: receipt.outcome === "partial" || receipt.outcome === "failed",
    };
  }
  return {
    id: receipt.id,
    title: "Email and Cove sync",
    detail: receipt.summary,
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
      `SELECT * FROM cove_receipts
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
      `SELECT finished_at FROM cove_receipts
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
       FROM cove_receipts
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
      `SELECT 1 FROM cove_receipts
       WHERE source = ? AND started_at = ?
       LIMIT 1`,
    ).get(input.source, input.startedAt));
  } finally {
    db.close();
  }
}
