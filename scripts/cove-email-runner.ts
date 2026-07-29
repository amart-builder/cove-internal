import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyEmail, type EmailClassification } from "../src/lib/email/classifier";
import {
  createEmailArtifactHandler,
  createEmailClassificationHandler,
} from "../src/lib/email/classification-job";
import {
  createGmailOperationHandler,
  reconcileDeadEmailJobs,
} from "../src/lib/email/gmail-outbox";
import {
  observeInboundMessage,
  syncRollingEmailCard,
} from "../src/lib/email/state-machine";
import { reconcileGmailToCard, type GmailThreadObservation } from "../src/lib/email/automation";
import { openLocalDatabase } from "../src/lib/local/database";
import { JobScheduler } from "../src/lib/reliability/jobs";
import { recordReceipt } from "../src/lib/reliability/receipts";
import {
  createGoogleWorkspaceGateway,
  readWorkspaceConfig,
  safeWorkspaceFailure,
} from "../src/lib/workspace";
import type { MailMessage, RestrictedMailGateway } from "../src/lib/workspace";

type RunnerOptions = {
  repoDir?: string;
  dataDir?: string;
  dbPath?: string;
  gateway?: RestrictedMailGateway;
  classifier?: (input: {
    accountEmail: string;
    sender: string;
    subject: string;
    text: string;
    voice?: string;
  }) => Promise<EmailClassification>;
  now?: () => Date;
};

function header(message: MailMessage, name: string): string {
  return message.headers.find((item) => item.name.toLowerCase() === name.toLowerCase())
    ?.value ?? "";
}

function address(value: string): string {
  return (/<([^<>]+)>/.exec(value)?.[1] ?? value).trim().toLowerCase();
}

function isFromAccount(message: MailMessage, accountEmail: string): boolean {
  return address(header(message, "From")) === accountEmail.toLowerCase();
}

function voiceGuide(): string {
  const file = path.join(os.homedir(), ".claude", "voice.md");
  return existsSync(file) ? readFileSync(file, "utf8").slice(0, 12_000) : "";
}

function emailRows(dbPath: string): Array<{
  id: string;
  thread_id: string;
}> {
  const db = openLocalDatabase(dbPath);
  try {
    return db.prepare(
      `SELECT id, thread_id FROM email_items
       WHERE status = 'pending' AND thread_id IS NOT NULL
       ORDER BY received_at DESC LIMIT 500`,
    ).all() as Array<{ id: string; thread_id: string }>;
  } finally {
    db.close();
  }
}

async function runEmailTriageUnchecked(options: RunnerOptions = {}): Promise<{
  observed: number;
  classified: number;
  reconciled: number;
  jobsDone: number;
  jobsFailed: number;
  jobsDead: number;
}> {
  const repoDir = options.repoDir ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dataDir = options.dataDir ?? path.join(repoDir, "data");
  const dbPath = options.dbPath ?? path.join(dataDir, "cove.db");
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const config = readWorkspaceConfig(dataDir);
  const gateway = options.gateway ?? createGoogleWorkspaceGateway({ dataDir }).mail;
  const classifier = options.classifier ?? ((input) => classifyEmail({ ...input, repoDir }));
  await gateway.getProfile();
  await gateway.ensureCoveLabel({ name: "Cove/Triaged" });

  let observed = 0;
  let classified = 0;
  const page = await gateway.listMessages({
    query: "in:inbox -label:Cove/Triaged -label:Forge/Triaged",
    maxResults: 100,
  });
  for (const listed of page.messages) {
    const message = await gateway.getMessage({ messageId: listed.id, format: "full" });
    if (isFromAccount(message, config.accountEmail)) continue;
    const observation = observeInboundMessage({
      messageId: message.id,
      threadId: message.threadId,
      gmailHistoryId: message.historyId,
      internalDate: message.internalDate ?? "0",
      accountEmail: config.accountEmail,
      senderName: header(message, "From").slice(0, 500),
      senderEmail: address(header(message, "From")),
      subject: header(message, "Subject").slice(0, 2_000),
      bodyExcerpt: message.text.slice(0, 20_000),
      receivedAt: message.internalDate
        ? new Date(Number(message.internalDate)).toISOString()
        : startedAt,
      dbPath,
      now: now(),
    });
    if (observation.inserted) observed += 1;
  }

  const reconciliation: GmailThreadObservation[] = [];
  for (const row of emailRows(dbPath)) {
    const thread = await gateway.getThread({ threadId: row.thread_id, format: "metadata" });
    const inbound = thread.messages.filter((message) => !isFromAccount(message, config.accountEmail));
    const sent = thread.messages.filter((message) => isFromAccount(message, config.accountEmail));
    const latestInbound = inbound.sort(
      (a, b) => Number(b.internalDate ?? 0) - Number(a.internalDate ?? 0),
    )[0];
    const latestSent = sent.sort(
      (a, b) => Number(b.internalDate ?? 0) - Number(a.internalDate ?? 0),
    )[0];
    const inboxMessageIds = inbound
      .filter((message) => message.labelIds.includes("INBOX"))
      .map((message) => message.id);
    reconciliation.push({
      emailItemId: row.id,
      threadId: row.thread_id,
      inInbox: inboxMessageIds.length > 0,
      inboxMessageIds,
      userReplied: Boolean(
        latestSent &&
        latestInbound &&
        Number(latestSent.internalDate ?? 0) > Number(latestInbound.internalDate ?? 0)
      ),
    });
  }
  const reconciled = await reconcileGmailToCard({
    observations: reconciliation,
    gateway,
    dbPath,
    dataDir,
    now,
  });

  const scheduler = new JobScheduler({ dbPath, now });
  scheduler.register("email-classify", createEmailClassificationHandler({
    gateway,
    accountEmail: config.accountEmail,
    dbPath,
    repoDir,
    voice: voiceGuide,
    classifier,
    now,
  }));
  scheduler.register("gmail-operation", createGmailOperationHandler({
    gateway,
    dbPath,
    now,
  }));
  scheduler.register("email-artifacts", createEmailArtifactHandler({
    dbPath,
    dataDir,
    now,
  }));
  let jobsDone = 0;
  let jobsFailed = 0;
  let jobsDead = 0;
  try {
    const jobs = await scheduler.runAvailable({ concurrency: 1, maxJobs: 200 });
    jobsDone = jobs.done;
    jobsFailed = jobs.failed;
    jobsDead = jobs.dead;
    const db = openLocalDatabase(dbPath);
    try {
      classified = (
        db.prepare(
          `SELECT COUNT(*) AS count FROM cove_email_messages
           WHERE state = 'processed' AND processed_at >= ?`,
        ).get(startedAt) as { count: number }
      ).count;
    } finally {
      db.close();
    }
  } finally {
    scheduler.close();
  }
  reconcileDeadEmailJobs({ dbPath, now: now() });
  syncRollingEmailCard({ dbPath, now: now() });
  recordReceipt({
    dbPath,
    source: "email-triage",
    startedAt,
    finishedAt: now().toISOString(),
    summary: `Email triage observed ${observed}, classified ${classified}, and reconciled ${reconciled.autoChecked}.`,
    actions: {
      observed,
      classified,
      reconciled: reconciled.autoChecked,
      jobsDone,
      jobsFailed,
      jobsDead,
    },
    outcome:
      reconciled.archiveFailures.length > 0 || jobsFailed > 0 || jobsDead > 0
        ? "partial"
        : "success",
    failureKey: "email-triage-run",
    failureMessage:
      reconciled.archiveFailures.length > 0 || jobsFailed > 0 || jobsDead > 0
      ? `${reconciled.archiveFailures.length} archive, ${jobsFailed} retryable job, and ${jobsDead} stopped job failure(s) need attention.`
      : undefined,
  });
  return {
    observed,
    classified,
    reconciled: reconciled.autoChecked,
    jobsDone,
    jobsFailed,
    jobsDead,
  };
}

export async function runEmailTriage(options: RunnerOptions = {}): Promise<{
  observed: number;
  classified: number;
  reconciled: number;
  jobsDone: number;
  jobsFailed: number;
  jobsDead: number;
}> {
  try {
    return await runEmailTriageUnchecked(options);
  } catch (error) {
    const repoDir = options.repoDir ??
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const dataDir = options.dataDir ?? path.join(repoDir, "data");
    const dbPath = options.dbPath ?? path.join(dataDir, "cove.db");
    const occurredAt = (options.now ?? (() => new Date()))().toISOString();
    const failure = safeWorkspaceFailure(error);
    try {
      recordReceipt({
        dbPath,
        source: "email-triage",
        startedAt: occurredAt,
        finishedAt: occurredAt,
        summary: `Email triage failed: ${failure.message}`,
        actions: { failure },
        outcome: "failed",
        failureKey: "email-triage-run",
        failureMessage: failure.message,
      });
    } catch {
      // Preserve the original provider or auth failure if issue recording fails.
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const result = await runEmailTriage();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
