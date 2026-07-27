#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { operatorName } from "../src/lib/operator-runtime.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadDotenv(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

loadDotenv(resolve(rootDir, ".env.local"));

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const next = process.argv[i + 1];
  if (!next || next.startsWith("--")) {
    args.set(key, "true");
  } else {
    args.set(key, next);
    i += 1;
  }
}

const inputPath = args.get("input");
if (!inputPath) throw new Error("Usage: node scripts/run-email-triage.mjs --input <json>");

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ownerUserId = process.env.FORGE_OWNER_USER_ID;
const tablePrefix = process.env.FORGE_TABLE_PREFIX ?? process.env.NEXT_PUBLIC_FORGE_TABLE_PREFIX ?? "";

if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL is missing.");
if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing.");
if (!ownerUserId) throw new Error("FORGE_OWNER_USER_ID is missing.");

const input = JSON.parse(readFileSync(resolve(inputPath), "utf8"));
const emails = Array.isArray(input.emails) ? input.emails : [];
const startedAt = new Date().toISOString();
const provider = input.provider ?? "gmail";
const accountEmail = input.account_email ?? process.env.FORGE_OWNER_EMAIL ?? null;

function table(name) {
  return tablePrefix && !name.startsWith(tablePrefix) ? `${tablePrefix}${name}` : name;
}

function restUrl(tableName, query = {}) {
  const url = new URL(`/rest/v1/${table(tableName)}`, supabaseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  }
  return url;
}

async function supabase(tableName, { method = "GET", query = {}, body } = {}) {
  const response = await fetch(restUrl(tableName, query), {
    method,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${method} ${table(tableName)} failed: ${JSON.stringify(data)}`);
  return data;
}

function pick(value, fallback = null) {
  return value === undefined || value === "" ? fallback : value;
}

function normalizeClassification(value) {
  if (["action_item", "tiding", "log_only"].includes(value)) return value;
  return "action_item";
}

function normalizeStatus(value) {
  if (["pending", "reviewed", "actioned", "dismissed", "archived"].includes(value)) return value;
  return "pending";
}

function normalizePriority(value) {
  const priority = Number(value ?? 2);
  if (Number.isNaN(priority)) return 2;
  return Math.min(3, Math.max(1, priority));
}

function normalizeRecommendedAction(email) {
  const value = email.recommended_action ?? email.recommendedAction;
  if (value) return value;
  const classification = normalizeClassification(email.classification);
  if (classification === "action_item") return "reply";
  if (classification === "tiding") return "review";
  return "archive";
}

function normalizeNullableUuid(value) {
  if (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    return value;
  }
  return null;
}

function compactSourcePayload(email) {
  return {
    source: "scripts/run-email-triage.mjs",
    thread_id: pick(email.thread_id ?? email.threadId),
    message_id: pick(email.message_id ?? email.messageId),
    full_body: pick(email.full_body ?? email.fullBody ?? email.body_text ?? email.bodyText ?? email.body),
    meeting_notes_url: pick(
      email.meeting_notes_url ??
        email.meetingNotesUrl ??
        email.google_doc_url ??
        email.googleDocUrl ??
        email.drive_url ??
        email.driveUrl
    ),
    attio_record_url: pick(email.attio_record_url ?? email.attioRecordUrl),
    follow_up_tasks: pick(email.follow_up_tasks ?? email.followUpTasks, undefined),
    action_title: pick(email.action_title ?? email.actionTitle ?? email.task_title ?? email.taskTitle),
    action_requirement: pick(
      email.action_requirement ??
        email.actionRequirement ??
        email.task_requirement ??
        email.taskRequirement ??
        email.next_step ??
        email.nextStep
    ),
    input: pick(email.source_payload ?? email.sourcePayload, undefined),
  };
}

async function findExistingEmail(email) {
  const threadId = pick(email.thread_id ?? email.threadId);
  if (threadId) {
    const rows = await supabase("email_items", {
      query: {
        select: "id,status,thread_id,message_id",
        thread_id: `eq.${threadId}`,
        status: "in.(pending,reviewed)",
        limit: "1",
      },
    });
    if (rows[0]) return rows[0];
  }

  const messageId = pick(email.message_id ?? email.messageId);
  if (messageId) {
    const rows = await supabase("email_items", {
      query: {
        select: "id,status,thread_id,message_id",
        message_id: `eq.${messageId}`,
        status: "in.(pending,reviewed)",
        limit: "1",
      },
    });
    if (rows[0]) return rows[0];
  }

  return null;
}

async function resolveContact(email) {
  const senderEmail = pick(email.sender_email ?? email.senderEmail);
  if (!senderEmail) return null;

  const existing = await supabase("contacts", {
    query: { select: "id,company_id", email: `eq.${senderEmail}`, limit: "1" },
  });
  if (existing[0]) return existing[0];

  const [created] = await supabase("contacts", {
    method: "POST",
    body: {
      owner_user_id: ownerUserId,
      name: pick(email.sender_name ?? email.senderName, senderEmail),
      email: senderEmail,
      tier: "C",
      tags: ["email-triage"],
      notes: "",
      source_system: provider,
      source_id: pick(email.thread_id ?? email.threadId),
      source_payload: compactSourcePayload(email),
      last_inbound_at: pick(email.received_at ?? email.receivedAt, startedAt),
      last_interaction_at: pick(email.received_at ?? email.receivedAt, startedAt),
    },
  });
  return created;
}

async function insertRun(status = "running", patch = {}) {
  const [run] = await supabase("email_triage_runs", {
    method: "POST",
    body: {
      owner_user_id: ownerUserId,
      agent_run_id: normalizeNullableUuid(input.agent_run_id ?? input.agentRunId),
      provider,
      account_email: accountEmail,
      status,
      summary: pick(input.summary, "Email triage run started."),
      processed_count: 0,
      action_count: 0,
      tidings_count: 0,
      log_count: 0,
      cursor_before: pick(input.cursor_before ?? input.cursorBefore),
      cursor_after: pick(input.cursor_after ?? input.cursorAfter),
      started_at: startedAt,
      ...patch,
    },
  });
  return run;
}

async function completeRun(runId, patch) {
  const [run] = await supabase("email_triage_runs", {
    method: "PATCH",
    query: { id: `eq.${runId}` },
    body: { ...patch, status: patch.status ?? "succeeded", completed_at: new Date().toISOString() },
  });
  return run;
}

async function main() {
  const run = await insertRun("running");
  const stats = { processed: 0, skipped: 0, action: 0, tidings: 0, log: 0, drafts: 0 };

  try {
    for (const email of emails) {
      const existing = await findExistingEmail(email);
      if (existing) {
        stats.skipped += 1;
        continue;
      }

      const classification = normalizeClassification(email.classification);
      const contact = await resolveContact(email);
      const receivedAt = pick(email.received_at ?? email.receivedAt, startedAt);

      const [item] = await supabase("email_items", {
        method: "POST",
        body: {
          owner_user_id: ownerUserId,
          triage_run_id: run.id,
          contact_id: contact?.id ?? pick(email.contact_id ?? email.contactId),
          company_id: contact?.company_id ?? pick(email.company_id ?? email.companyId),
          provider,
          account_email: pick(email.account_email ?? email.accountEmail, accountEmail),
          message_id: pick(email.message_id ?? email.messageId),
          thread_id: pick(email.thread_id ?? email.threadId),
          sender_name: pick(email.sender_name ?? email.senderName),
          sender_email: pick(email.sender_email ?? email.senderEmail),
          subject: pick(email.subject, "(no subject)"),
          body_excerpt: pick(email.body_excerpt ?? email.bodyExcerpt),
          summary: pick(email.summary),
          context: pick(email.context),
          classification,
          recommended_action: normalizeRecommendedAction(email),
          priority: normalizePriority(email.priority),
          confidence: pick(email.confidence),
          status: normalizeStatus(email.status),
          received_at: receivedAt,
          source_payload: compactSourcePayload(email),
        },
      });

      const draftBody = pick(email.draft_response ?? email.draftResponse ?? email.draft);
      if (classification === "action_item" && draftBody) {
        await supabase("drafts", {
          method: "POST",
          body: {
            owner_user_id: ownerUserId,
            email_item_id: item.id,
            subject: pick(email.draft_subject ?? email.draftSubject ?? email.subject),
            body: draftBody,
            status: "needs_review",
            voice_version: pick(email.voice_version ?? email.voiceVersion, "FORGE-VOICE.md"),
            humanizer_version: pick(email.humanizer_version ?? email.humanizerVersion, "forge-humanizer-v1"),
            safety_notes: pick(email.safety_notes ?? email.safetyNotes, "Draft only; not sent."),
          },
        });
        stats.drafts += 1;
      }

      await supabase("email_action_log", {
        method: "POST",
        body: {
          owner_user_id: ownerUserId,
          triage_run_id: run.id,
          email_item_id: item.id,
          action_type: "triaged",
          description: `Classified as ${classification}`,
          performed_by: "agent",
          metadata: { provider, thread_id: item.thread_id, message_id: item.message_id },
        },
      });

      await supabase("contact_activities", {
        method: "POST",
        body: {
          owner_user_id: ownerUserId,
          contact_id: item.contact_id,
          company_id: item.company_id,
          email_item_id: item.id,
          activity_type: "email_received",
          title: item.subject,
          content: item.summary ?? item.body_excerpt,
          direction: "inbound",
          metadata: { provider, thread_id: item.thread_id, message_id: item.message_id },
        },
      });

      stats.processed += 1;
      if (classification === "action_item") stats.action += 1;
      if (classification === "tiding") stats.tidings += 1;
      if (classification === "log_only") stats.log += 1;
    }

    const summary = pick(input.summary) ?? `Email triage processed ${stats.processed} new item(s): ${stats.action} need ${operatorName()}, ${stats.tidings} update(s), ${stats.log} log-only.`;
    await completeRun(run.id, {
      status: "succeeded",
      summary,
      processed_count: stats.processed,
      action_count: stats.action,
      tidings_count: stats.tidings,
      log_count: stats.log,
      cursor_after: pick(input.cursor_after ?? input.cursorAfter),
    });

    console.log(JSON.stringify({ ok: true, run_id: run.id, ...stats }, null, 2));
  } catch (error) {
    await completeRun(run.id, {
      status: "failed",
      summary: "Email triage failed.",
      error: error instanceof Error ? error.message : String(error),
      processed_count: stats.processed,
      action_count: stats.action,
      tidings_count: stats.tidings,
      log_count: stats.log,
    });
    throw error;
  }
}

main();
