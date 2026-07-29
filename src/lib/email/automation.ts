import type Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createCRMBackend } from "../crm";
import type { Contact, ContactActivity } from "../data/types";
import { coveEnv } from "../env";
import { openLocalDatabase } from "../local/database";
import { recordFailure, resolveFailure } from "../reliability/failures";
import {
  recordReceipt,
  recordReceiptInDatabase,
  type Receipt,
} from "../reliability/receipts";

const execFileAsync = promisify(execFile);
const GMAIL_LIST_LABELS_TOOL = "GMAIL_LIST_LABELS";
const GMAIL_CREATE_LABEL_TOOL = "GMAIL_CREATE_LABEL";
const GMAIL_MODIFY_LABELS_TOOL = "GMAIL_MODIFY_THREAD_LABELS";
const ARCHIVE_CLAIM_TIMEOUT_MS = 5 * 60 * 1_000;

type EmailItemRow = {
  id: string;
  thread_id: string | null;
  status: string;
  sender_name: string | null;
  sender_email: string | null;
  subject: string | null;
  source_payload: string | null;
};

type EmailConfig = {
  accountEmail: string;
  labels: Record<string, string>;
  file: string;
  raw: Record<string, unknown>;
};

export type GmailThreadObservation = {
  emailItemId: string;
  threadId: string;
  inInbox: boolean;
  userReplied: boolean;
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

export type GmailLabelExecutor = (
  tool:
    | typeof GMAIL_LIST_LABELS_TOOL
    | typeof GMAIL_CREATE_LABEL_TOOL
    | typeof GMAIL_MODIFY_LABELS_TOOL,
  parameters: Record<string, unknown>,
) => Promise<unknown>;

function nowIso(now: Date | (() => Date) | undefined): string {
  const date = typeof now === "function" ? now() : now ?? new Date();
  return date.toISOString();
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

function emailConfigPath(dataDir: string): string {
  const current = path.join(dataDir, "cove-email.json");
  if (existsSync(current)) return current;
  return path.join(dataDir, "forge-email.json");
}

function readEmailConfig(dataDir?: string): EmailConfig {
  const resolvedDataDir = dataDir ??
    coveEnv("DATA_DIR") ??
    path.join(process.cwd(), "data");
  const file = emailConfigPath(resolvedDataDir);
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Email config must be a JSON object.");
  }
  const row = parsed as Record<string, unknown>;
  if (typeof row.account_email !== "string" || !row.account_email.trim()) {
    throw new Error("Email config is missing account_email.");
  }
  const labels = objectValue(row.labels);
  return {
    accountEmail: row.account_email.trim(),
    labels: Object.fromEntries(
      Object.entries(labels).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && Boolean(entry[1]),
      ),
    ),
    file,
    raw: row,
  };
}

function arrayAt(value: unknown, pathParts: string[]): unknown[] | undefined {
  let current = value;
  for (const part of pathParts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return Array.isArray(current) ? current : undefined;
}

function labelIdFromCreateResult(value: unknown): string | undefined {
  const row = objectValue(value);
  const data = objectValue(row.data);
  return [
    row.id,
    objectValue(row.label).id,
    data.id,
    objectValue(data.label).id,
  ].find(
    (candidate): candidate is string =>
      typeof candidate === "string" && Boolean(candidate),
  );
}

function persistMergedLabels(
  config: EmailConfig,
  labels: Record<string, string>,
): void {
  const tempFile = `${config.file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(
    tempFile,
    `${JSON.stringify({ ...config.raw, labels }, null, 2)}\n`,
    { mode: 0o600 },
  );
  renameSync(tempFile, config.file);
  config.labels = labels;
  config.raw = { ...config.raw, labels };
}

async function ensureCoveLabelIds(
  config: EmailConfig,
  names: string[],
  execute: GmailLabelExecutor,
): Promise<Record<string, string>> {
  const required = [...new Set(names.filter((name) => name.startsWith("Cove/")))];
  const labels = { ...config.labels };
  let changed = false;
  if (required.some((name) => !labels[name])) {
    const listed = await execute(GMAIL_LIST_LABELS_TOOL, {
      user_id: config.accountEmail,
    });
    const rows = arrayAt(listed, ["labels"]) ??
      arrayAt(listed, ["data", "labels"]) ??
      (Array.isArray(listed) ? listed : []);
    for (const value of rows) {
      const row = objectValue(value);
      if (
        typeof row.name === "string" &&
        typeof row.id === "string" &&
        required.includes(row.name) &&
        !labels[row.name]
      ) {
        labels[row.name] = row.id;
        changed = true;
      }
    }
  }
  for (const name of required) {
    if (labels[name]) continue;
    const created = await execute(GMAIL_CREATE_LABEL_TOOL, {
      user_id: config.accountEmail,
      label_name: name,
    });
    const id = labelIdFromCreateResult(created);
    if (!id) throw new Error(`Could not resolve Gmail label id for ${name}.`);
    labels[name] = id;
    changed = true;
  }
  if (changed) persistMergedLabels(config, labels);
  return labels;
}

function emailRow(db: Database.Database, id: string): EmailItemRow | undefined {
  return db.prepare(
    `SELECT id, thread_id, status, sender_name, sender_email, subject,
            source_payload
     FROM email_items WHERE id = ?`,
  ).get(id) as EmailItemRow | undefined;
}

export async function reconcileGmailToCard(input: {
  observations: GmailThreadObservation[];
  dbPath?: string;
  dataDir?: string;
  now?: Date | (() => Date);
  execute?: GmailLabelExecutor;
}): Promise<{
  autoChecked: number;
  changedIds: string[];
  recoveredArchiveIds: string[];
  labelFailures: string[];
  receipt: Receipt;
}> {
  const startedAt = nowIso(input.now);
  const finishedAt = nowIso(input.now);
  const db = openLocalDatabase(input.dbPath);
  const changedIds: string[] = [];
  const recoveredArchiveIds: string[] = [];
  const changedReasons: Record<string, string> = {};
  const changedReplies: Array<{ id: string; threadId: string }> = [];
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
         SET status = 'actioned', actioned_at = ?, updated_at = ?,
             source_payload = ?
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
        const replyBucket = metadata.bucket === "reply";
        const reason = !observation.inInbox
          ? "not_in_inbox"
          : observation.userReplied && replyBucket
            ? "user_replied"
            : undefined;
        if (!reason) continue;
        const reconciledMetadata = {
          ...metadata,
          reconciled_from_gmail: reason,
          reconciled_at: finishedAt,
        };
        if (
          update.run(
            finishedAt,
            finishedAt,
            JSON.stringify(reconciledMetadata),
            id,
          ).changes === 1
        ) {
          changedIds.push(id);
          changedReasons[id] = reason;
          if (replyBucket) changedReplies.push({ id, threadId });
        }
      }
    }).immediate();
  } finally {
    db.close();
  }
  const labelFailures: string[] = [];
  if (changedReplies.length > 0) {
    try {
      const config = readEmailConfig(input.dataDir);
      const execute = input.execute ?? createGmailLabelExecutor();
      const labels = await ensureCoveLabelIds(
        config,
        ["Cove/Reply", "Cove/Done"],
        execute,
      );
      for (const row of changedReplies) {
        try {
          await execute(GMAIL_MODIFY_LABELS_TOOL, {
            user_id: config.accountEmail,
            thread_id: row.threadId,
            add_label_ids: [labels["Cove/Done"]],
            remove_label_ids: [labels["Cove/Reply"]],
          });
        } catch (error) {
          labelFailures.push(
            `${row.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } catch (error) {
      labelFailures.push(
        `label setup: ${error instanceof Error ? error.message : String(error)}`,
      );
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
      labelFailures,
    },
    outcome: labelFailures.length === 0 ? "success" : "partial",
    failureKey: "reply-label-cleanup",
    failureMessage: labelFailures.length > 0
      ? "Some handled reply threads could not be moved from Cove/Reply to Cove/Done."
      : undefined,
  });
  return {
    autoChecked: changedIds.length,
    changedIds,
    recoveredArchiveIds,
    labelFailures,
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
         VALUES (?, ?, ?, NULL, ?, ?, 'detector', ?, ?, ?, NULL, 'high', 1,
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

export function createGmailLabelExecutor(options: {
  cwd?: string;
  composioPath?: string;
  timeoutMs?: number;
} = {}): GmailLabelExecutor {
  return async (tool, parameters) => {
    const result = await execFileAsync(
      // The Composio CLI installs to ~/.composio, which is not on the PATH
      // launchd gives its agents, so a bare "composio" is ENOENT in every
      // scheduled lane. COVE_COMPOSIO_BIN carries the absolute path.
      options.composioPath ?? coveEnv("COMPOSIO_BIN") ?? "composio",
      ["execute", tool, "-d", JSON.stringify(parameters)],
      {
        cwd: options.cwd ?? process.cwd(),
        env: process.env,
        maxBuffer: 4 * 1024 * 1024,
        timeout: options.timeoutMs ?? 60_000,
      },
    );
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    if (parsed.successful === false || parsed.success === false) {
      throw new Error(`Gmail label change failed: ${JSON.stringify(parsed.error ?? parsed)}`);
    }
    return parsed;
  };
}

export async function archiveEmailItemFromCard(input: {
  emailItemId: string;
  dbPath?: string;
  dataDir?: string;
  now?: Date | (() => Date);
  execute?: GmailLabelExecutor;
}): Promise<{ archived: boolean; alreadyDone: boolean; receipt?: Receipt }> {
  const startedAt = nowIso(input.now);
  const db = openLocalDatabase(input.dbPath);
  let row: EmailItemRow | undefined;
  try {
    row = db.transaction(() => {
      const id = requireText(input.emailItemId, "Email item id", 200);
      const current = emailRow(db, id);
      if (!current) throw new Error("Email item was not found.");
      if (current.status !== "pending") return current;
      if (!current.thread_id) throw new Error("Email item has no Gmail thread id.");
      const claim = {
        ...objectValue(current.source_payload),
        archive_claimed_at: startedAt,
      };
      const claimed = db.prepare(
        `UPDATE email_items
         SET status = 'archiving', updated_at = ?, source_payload = ?
         WHERE id = ? AND status = 'pending'`,
      ).run(startedAt, JSON.stringify(claim), current.id);
      return claimed.changes === 1
        ? { ...current, status: "archiving" }
        : emailRow(db, id);
    }).immediate();
  } finally {
    db.close();
  }
  if (!row) throw new Error("Email item was not found.");
  if (row.status !== "archiving") {
    return { archived: false, alreadyDone: true };
  }
  if (!row.thread_id) throw new Error("Email item has no Gmail thread id.");

  const metadata = objectValue(row.source_payload);
  const bucket = typeof metadata.bucket === "string" ? metadata.bucket : "";
  const bucketName = bucket
    ? `Cove/${bucket[0].toUpperCase()}${bucket.slice(1)}`
    : undefined;
  let addLabelIds: string[] = [];
  let removeLabelIds: string[] = [];
  try {
    const config = readEmailConfig(input.dataDir);
    const execute = input.execute ?? createGmailLabelExecutor();
    const labels = await ensureCoveLabelIds(
      config,
      ["Cove/Done", ...(bucketName ? [bucketName] : [])],
      execute,
    );
    addLabelIds = [labels["Cove/Done"]];
    removeLabelIds = [
      "INBOX",
      ...(bucketName ? [labels[bucketName]] : []),
    ];
    await execute(
      GMAIL_MODIFY_LABELS_TOOL,
      {
        user_id: config.accountEmail,
        thread_id: row.thread_id,
        add_label_ids: addLabelIds,
        remove_label_ids: removeLabelIds,
      },
    );
  } catch (error) {
    const finishedAt = nowIso(input.now);
    const rollback = openLocalDatabase(input.dbPath);
    try {
      rollback.transaction(() => {
        rollback.prepare(
          `UPDATE email_items
           SET status = 'pending', updated_at = ?, source_payload = ?
           WHERE id = ? AND status = 'archiving'`,
        ).run(finishedAt, row!.source_payload, row!.id);
      }).immediate();
    } finally {
      rollback.close();
    }
    recordReceipt({
      dbPath: input.dbPath,
      source: "email-card-to-gmail",
      startedAt,
      finishedAt,
      summary: "Email card checkbox could not archive its Gmail thread.",
      actions: {
        emailItemId: row.id,
        threadId: row.thread_id,
        labelOperationOnly: true,
        error: error instanceof Error ? error.message : String(error),
      },
      outcome: "failed",
      failureKey: row.id,
      failureMessage: "Gmail archive failed. The email card item remains open.",
    });
    throw error;
  }

  const finishedAt = nowIso(input.now);
  const finalize = openLocalDatabase(input.dbPath);
  try {
    return finalize.transaction(() => {
      const current = emailRow(finalize, row!.id);
      if (!current || current.status !== "archiving") {
        return { archived: true, alreadyDone: true };
      }
      const sourcePayload: Record<string, unknown> = {
        ...objectValue(current.source_payload),
        completed_via: "card",
        gmail_archived_at: finishedAt,
      };
      delete sourcePayload.archive_claimed_at;
      finalize.prepare(
        `UPDATE email_items
         SET status = 'actioned', actioned_at = ?, updated_at = ?,
             source_payload = ?
         WHERE id = ? AND status = 'archiving'`,
      ).run(
        finishedAt,
        finishedAt,
        JSON.stringify(sourcePayload),
        current.id,
      );
      const receipt = recordReceiptInDatabase(finalize, {
        source: "email-card-to-gmail",
        startedAt,
        finishedAt,
        summary: "Email card checkbox archived its Gmail thread.",
        actions: {
          emailItemId: current.id,
          threadId: current.thread_id,
          addLabelIds,
          removeLabelIds,
          labelOperationOnly: true,
        },
        outcome: "success",
      });
      return { archived: true, alreadyDone: false, receipt };
    }).immediate();
  } finally {
    finalize.close();
  }
}
