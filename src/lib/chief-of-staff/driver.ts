import { createDayPlanStore } from "../day-plan/store";
import { morningBriefModelConfig } from "../claude-execution/brief-commands";
import { PLANNING_QUESTIONS } from "./planning-contract";
import { localDateLabel } from "./planning-dates";
import { operatorTimezone } from "../operator";
import { originDate } from "../tasks/origin";
import {
  dailyPlanningSchema,
  dailyPlanningPrompt,
  validateDailyDecision,
  decisionAsBrief,
  type PlanningContext,
} from "./daily-planning";
import type Database from "better-sqlite3";
import { queuePhoneReminder } from "../apple-reminders/queue.mjs";
import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AttentionDeliveryRejected,
  deliverAttentionNudge,
} from "../attention/delivery";
import type { AttentionTransport } from "../attention/transport.mjs";
import {
  surfaceAttentionSuggestion,
  surfaceAttentionSuppression,
} from "../attention/quiet-current";
import { LocalCRMBackend } from "../crm/local";
import {
  isOpenPipelineStage,
  validatePipelinePatch,
  validatePipelineStage,
  type PipelineStage,
} from "../crm/pipeline";
import { LocalPipelineStore } from "../crm/pipeline-store";
import { salesPipelineEnabled } from "../crm/sales-pipeline";
import { coveConfigPath, coveEnvTrimmed } from "../env";
import { openLocalDatabase } from "../local/database";
import { readAgentSettings } from "../agent-settings.mjs";
import { runJob } from "../model-runner";
import { assertSourceVersion, markResponsibilitiesReviewed, updateResponsibility, savePreparation, type PlanPatch, type Responsibility } from "../responsibility/store";
import { validateTaskTiming } from "../local/db";
import { createWorkSuggestion } from "../quiet-current/store";
import { syncRecurringOccurrenceForTask } from "../tasks/recurrence";
import type { JobHandlerResult, ScheduledJob } from "../reliability/jobs";
import {
  appendChiefOfStaffJournal,
  atomicWrite,
  ensureChiefOfStaffCodexHome,
  ensureChiefOfStaffHome,
  resetChiefOfStaffSession,
  writeChiefOfStaffSession,
} from "./storage";
import { buildChiefOfStaffSnapshot, writeChiefOfStaffSnapshot } from "./snapshot";
import {
  CHIEF_OF_STAFF_ACTION_FIELDS,
  CHIEF_OF_STAFF_REASONS,
  optionalActionText,
  requiredActionText,
  scrubChiefOfStaffAction,
  scrubModelText,
  stripStoredText,
  validateChiefOfStaffOutput,
  type ChiefOfStaffAction,
  type ChiefOfStaffOutput,
  type ChiefOfStaffWakePayload,
} from "./types";

const WAKE_TIMEOUT_MS = 15 * 60_000;
/** A task finished this recently still counts as "already exists" for task_create. */
const RECENT_TASK_DAYS = 14;
const MAX_PROCESS_OUTPUT = 4 * 1024 * 1024;
const SALES_PIPELINE_STATUS_PLACEHOLDER = "{{SALES_PIPELINE_STATUS}}";

/**
 * The proposed deadline is read by the person on the suggestion card, so it is
 * written the way every other date Cove shows them is. A bare calendar date is
 * labelled in UTC: read as an instant it would slide to the previous day in a
 * negative-offset timezone and move the deadline the model proposed.
 */
function proposedDeadlineLabel(due: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(due)
    ? originDate(`${due}T12:00:00.000Z`, "UTC")
    : originDate(due, operatorTimezone());
}

type CodexAttempt = {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  output?: ChiefOfStaffOutput;
  sessionId?: string;
};

function renderChiefOfStaffMandateForWake(input: {
  mandatePath: string;
  repoDir: string;
  dataDir: string;
  env: NodeJS.ProcessEnv;
}): void {
  const privateFile = coveConfigPath(input.dataDir, "mandate.md");
  const fallback = path.join(input.repoDir, "prompts", "chief-of-staff-mandate.md");
  const source = readFileSync(existsSync(privateFile) ? privateFile : fallback, "utf8").trim();
  const status = salesPipelineEnabled(input.env)
    ? ""
    : "The sales pipeline is off. Do not propose pipeline actions or deal notifications.";
  const rendered = source.includes(SALES_PIPELINE_STATUS_PLACEHOLDER)
    ? source.replace(SALES_PIPELINE_STATUS_PLACEHOLDER, status).trim()
    : status ? `${source}\n\n${status}` : source;
  const contract = readFileSync(path.join(input.repoDir, "prompts", "responsibility-contract.md"), "utf8");
  const phoneContract = readFileSync(path.join(input.repoDir, "prompts", "phone-reminder-contract.md"), "utf8");
  const expected = `${rendered}\n\n${contract}\n\n${phoneContract}\n\n${PLANNING_QUESTIONS}\nUse replan_day only before the person starts their day. After Start Day, the chosen plan and written brief stay settled until the person explicitly changes tasks. Keep new source information for the next Morning Arrival; do not request a midday plan review or write a competing ranked plan in journal or watching.\n`;
  if (readFileSync(input.mandatePath, "utf8") === expected) return;
  atomicWrite(input.mandatePath, expected, 0o444);
}

export function buildChiefOfStaffCodexArgv(input: {
  workspace: string;
  schemaPath: string;
  outputPath: string;
  sessionId?: string | null;
}): string[] {
  return [
    "exec",
    "-C",
    input.workspace,
    "-c",
    "sandbox_mode=read-only",
    "--skip-git-repo-check",
    "-m",
    "gpt-5.6-sol",
    "-c",
    "model_reasoning_effort=medium",
    "-c",
    "features.shell_tool=false",
    "-c",
    'web_search="disabled"',
    "--output-schema",
    input.schemaPath,
    "--output-last-message",
    input.outputPath,
    "--json",
    ...(input.sessionId ? ["resume", input.sessionId, "-"] : ["-"]),
  ];
}

export function captureCodexSessionId(stdout: string, stderr = ""): string | null {
  for (const line of stdout.split("\n")) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      for (const key of ["thread_id", "session_id", "conversation_id"]) {
        if (typeof event[key] === "string" && event[key]) return event[key] as string;
      }
      if (event.thread && typeof event.thread === "object" && !Array.isArray(event.thread)) {
        const id = (event.thread as Record<string, unknown>).id;
        if (typeof id === "string" && id) return id;
      }
    } catch {
      // Non-JSON diagnostics are checked below.
    }
  }
  const labeled = /(?:session|thread|conversation)(?:\s+id)?\s*[:=]\s*([0-9a-f-]{20,})/i
    .exec(`${stdout}\n${stderr}`);
  return labeled?.[1] ?? null;
}

function safeProcessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "HOME",
    "PATH",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "USER",
    "LOGNAME",
    "SHELL",
    "CODEX_HOME",
    "OPENAI_API_KEY",
  ];
  return Object.fromEntries(
    allowed.flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]])),
  ) as NodeJS.ProcessEnv;
}

function signalChild(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child.
    }
  }
  child.kill(signal);
}

function terminate(child: ChildProcessWithoutNullStreams): void {
  signalChild(child, "SIGTERM");
}

async function runCodexAttempt(input: {
  executable: string;
  argv: string[];
  cwd: string;
  snapshot: string;
  outputPath: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  spawnImpl?: typeof spawn;
}): Promise<CodexAttempt> {
  return await new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = (input.spawnImpl ?? spawn)(input.executable, input.argv, {
        cwd: input.cwd,
        env: safeProcessEnvironment(input.env),
        detached: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        ok: false,
        exitCode: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let timedOut = false;
    let settled = false;
    const finish = (attempt: CodexAttempt) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(attempt);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
      setTimeout(() => {
        if (!settled) signalChild(child, "SIGKILL");
      }, 2_000).unref();
    }, input.timeoutMs);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes <= MAX_PROCESS_OUTPUT) stdout += chunk;
      else terminate(child);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-64_000);
    });
    child.once("error", (error) => finish({
      ok: false,
      exitCode: null,
      stdout,
      stderr: error.message,
      timedOut,
    }));
    child.once("close", (code, signal) => {
      if (timedOut) {
        finish({ ok: false, exitCode: code, stdout, stderr: "Chief-of-staff wake timed out.", timedOut: true });
        return;
      }
      if (bytes > MAX_PROCESS_OUTPUT) {
        finish({ ok: false, exitCode: code, stdout, stderr: "Codex event output exceeded 4 MB.", timedOut: false });
        return;
      }
      if (code !== 0 || signal) {
        finish({ ok: false, exitCode: code, stdout, stderr: stderr || `Codex exited ${code ?? signal}.`, timedOut: false });
        return;
      }
      try {
        if (!existsSync(input.outputPath)) throw new Error("Codex did not write its final message.");
        const raw = readFileSync(input.outputPath, "utf8");
        const output = validateChiefOfStaffOutput(JSON.parse(raw) as unknown);
        finish({
          ok: true,
          exitCode: 0,
          stdout,
          stderr,
          timedOut: false,
          output,
          sessionId: captureCodexSessionId(stdout, stderr) ?? undefined,
        });
      } catch (error) {
        finish({
          ok: false,
          exitCode: 0,
          stdout,
          stderr: error instanceof Error ? error.message : String(error),
          timedOut: false,
        });
      }
    });
    child.stdin.once("error", () => terminate(child));
    child.stdin.end(input.snapshot);
  });
}

export function resumeUnavailable(attempt: Pick<CodexAttempt, "exitCode" | "stderr">): boolean {
  return (
    attempt.exitCode !== null && attempt.exitCode !== 0 &&
    /thread\/resume failed|no rollout found for thread id/i.test(attempt.stderr)
  );
}

function parseWake(value: unknown): ChiefOfStaffWakePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Chief-of-staff wake payload is invalid.");
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.reason !== "string" ||
    !(CHIEF_OF_STAFF_REASONS as readonly string[]).includes(row.reason)
  ) {
    throw new Error("Chief-of-staff wake reason is invalid.");
  }
  if (!row.payload || typeof row.payload !== "object" || Array.isArray(row.payload)) {
    throw new Error("Chief-of-staff wake data is invalid.");
  }
  if (row.note !== undefined && typeof row.note !== "string") {
    throw new Error("Chief-of-staff wake note is invalid.");
  }
  return {
    reason: row.reason as ChiefOfStaffWakePayload["reason"],
    payload: row.payload as Record<string, unknown>,
    ...(typeof row.note === "string" ? { note: row.note } : {}),
  };
}

function prepareActionFields(
  action: ChiefOfStaffAction,
  required: string[],
  optional: string[] = [],
  conflicts: string[] = [],
): void {
  const allowed = new Set([
    "action_id",
    "kind",
    "why",
    ...required,
    ...optional,
  ]);
  const conflictFields = new Set(conflicts);
  for (const field of required) {
    if (!Object.hasOwn(action, field)) throw new Error(`${field} is required.`);
  }
  const ignoredFields: string[] = [];
  for (const field of Object.keys(action)) {
    if (allowed.has(field)) continue;
    if (conflictFields.has(field) && action[field] !== null && action[field] !== undefined) {
      continue;
    }
    if (action[field] !== null && action[field] !== undefined) ignoredFields.push(field);
    delete action[field];
  }
  if (ignoredFields.length > 0) action.ignored_fields = ignoredFields.sort();
}

function nullableText(
  action: ChiefOfStaffAction,
  field: string,
  maximum: number,
): string | null | undefined {
  if (!Object.hasOwn(action, field)) return undefined;
  if (action[field] === null) return null;
  return optionalActionText(action, field, maximum) ?? "";
}

function priority(value: unknown): "low" | "medium" | "high" {
  if (value === undefined || value === null) return "medium";
  if (value !== "low" && value !== "medium" && value !== "high") {
    throw new Error("priority must be low, medium, or high.");
  }
  return value;
}

// The two halves of the old check were joined by OR, so anything shaped like
// YYYY-MM-DD got in without ever being parsed: "2026-13-45" and "9999-99-99"
// were accepted and stored, and "Dec 25" passed the other half as the year
// 2001. These are deadlines written onto the person's real tasks, so they have
// to be dates the rest of Cove can read. localDateLabel is the same oracle the
// planning contract already uses (daily-planning.ts:213); it answers "Invalid"
// for a day the calendar does not have and "Unlabelled" for a format Cove does
// not support.
export function validateChiefOfStaffDueAt(
  value: string | null | undefined,
  field: string,
): void {
  if (value === undefined || value === null || value === "") return;
  const label = localDateLabel(value, "UTC") ?? "";
  if (!label || /^(Invalid|Unlabelled)/.test(label)) {
    throw new Error(`${field} must be a calendar date or timestamp.`);
  }
}

function insertLedger(
  db: Database.Database,
  input: {
    wakeJobId: string;
    contentHash: string;
    action: ChiefOfStaffAction;
    status: "applied" | "rejected" | "skipped";
    error?: string;
    now: string;
  },
): void {
  db.prepare(
    `INSERT INTO chief_of_staff_actions
       (wake_job_id, content_hash, action_id, kind, payload_json, status, error, applied_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(wake_job_id, content_hash) DO UPDATE SET
       action_id = excluded.action_id,
       kind = excluded.kind,
       payload_json = excluded.payload_json,
       status = excluded.status,
       error = excluded.error,
       applied_at = excluded.applied_at
     WHERE chief_of_staff_actions.status <> 'applied'`,
  ).run(
    input.wakeJobId,
    input.contentHash,
    input.action.action_id,
    input.action.kind,
    JSON.stringify(input.action),
    input.status,
    input.error?.slice(0, 1_000) ?? null,
    input.now,
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null) ?? "null";
}

export function chiefOfStaffActionContentHash(action: ChiefOfStaffAction): string {
  const fields = CHIEF_OF_STAFF_ACTION_FIELDS[action.kind] ?? Object.keys(action)
    .filter((field) => field !== "action_id" && field !== "why" && field !== "kind");
  const payload = Object.fromEntries(fields.map((field) => [field, action[field] ?? null]));
  return createHash("sha256").update(`${action.kind}\n${canonicalJson(payload)}`).digest("hex");
}

function normalizedTaskTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/[.!?:;,]+$/, "").toLowerCase();
}

function existingTaskWithTitle(db: Database.Database, title: string, now: Date): string | undefined {
  const cutoff = new Date(now.getTime() - RECENT_TASK_DAYS * 86_400_000).toISOString();
  const wanted = normalizedTaskTitle(title);
  const rows = db.prepare(
    `SELECT id, title FROM tasks
     WHERE status = 'open' OR (status IN ('done', 'archived') AND updated_at >= ?)`,
  ).all(cutoff) as Array<{ id: string; title: string }>;
  return rows.find((row) => normalizedTaskTitle(row.title) === wanted)?.id;
}

function applyDatabaseAction(input: {
  db: Database.Database;
  pipeline: LocalPipelineStore;
  crm: LocalCRMBackend;
  action: ChiefOfStaffAction;
  wakeJobId: string;
  now: Date;
  salesPipelineEnabled: boolean;
}): void {
  const { action } = input;
  if (action.kind.startsWith("pipeline_") && !input.salesPipelineEnabled) {
    throw new Error("sales_pipeline_disabled");
  }
  if (action.kind === "replan_day") return;
  if (action.kind === "plan_update") {
    prepareActionFields(action, ["ref_kind", "ref_id", "expected_version", "expected_revision", "next_action", "owner", "plan_state", "next_check_at"], ["planned_for", "estimate_minutes", "blocker", "goal", "completion_criterion"]);
    if (action.ref_kind !== "task" && action.ref_kind !== "commitment") throw new Error("Invalid plan source.");
    updateResponsibility(input.db, { ...action, state: action.plan_state } as unknown as PlanPatch, input.now);
    return;
  }
  if (action.kind === "prepare") {
    prepareActionFields(action,["ref_kind", "ref_id", "expected_version", "title", "content"]);
    if (action.ref_kind !== "task" && action.ref_kind !== "commitment") throw new Error("Invalid preparation source.");
    action.preparation_id = savePreparation(input.db, {
      ref_kind: action.ref_kind, ref_id: requiredActionText(action,"ref_id",200),
      expected_version: requiredActionText(action,"expected_version",40),
      title: requiredActionText(action,"title",160), content: requiredActionText(action,"content",5000),
    },input.now);
    return;
  }
  if (action.kind === "pipeline_add") {
    prepareActionFields(
      action,
      ["contact_id", "stage", "next_action"],
      ["next_follow_up_at", "notes"],
    );
    const contactId = requiredActionText(action, "contact_id", 200);
    const stage = validatePipelineStage(action.stage);
    if (!isOpenPipelineStage(stage)) {
      throw new Error("Client, lost, and parked cannot be added by the chief of staff. Use suggest instead.");
    }
    if (input.pipeline.get(contactId)) {
      throw new Error("This contact already has a pipeline deal. Use pipeline_update or pipeline_move.");
    }
    const patch = validatePipelinePatch({
      next_action: requiredActionText(action, "next_action", 500),
      ...(action.next_follow_up_at !== null && Object.hasOwn(action, "next_follow_up_at")
        ? { next_follow_up_at: nullableText(action, "next_follow_up_at", 10) }
        : {}),
      ...(action.notes !== null && Object.hasOwn(action, "notes")
        ? { notes: optionalActionText(action, "notes", 5_000) ?? "" }
        : {}),
    });
    input.pipeline.create({ contactId, stage, ...patch });
    return;
  }
  if (action.kind === "task_update") {
    prepareActionFields(action, ["task_id", "expected_version"], ["title", "details", "due_at", "remind_at", "priority", "status"]);
    const taskId = requiredActionText(action, "task_id", 200);
    const existing = assertSourceVersion(input.db,"task",taskId,action.expected_version);
    if (action.status != null && action.status !== existing.status) {
      throw new Error("Completion or reopening requires the person's confirmation or the existing verified completion flow. Propose it with suggest.");
    }
    if (action.due_at != null && action.due_at !== existing.due_at) {
      throw new Error("Keep the recorded deadline. Use plan_update.planned_for for proposed work time; suggest a deadline change for confirmation.");
    }
    const fields: string[] = [];
    const values: unknown[] = [];
    const add = (field: string, value: unknown) => {
      fields.push(`${field} = ?`);
      values.push(value);
    };
    if (action.title !== null && Object.hasOwn(action, "title")) add("title", requiredActionText(action, "title", 500));
    if (action.details !== null && Object.hasOwn(action, "details")) add("description", optionalActionText(action, "details", 5_000) ?? "");
    const dueAt = action.due_at === null ? undefined : nullableText(action, "due_at", 40);
    if (dueAt !== undefined) {
      validateChiefOfStaffDueAt(dueAt, "due_at");
      add("due_at", dueAt);
      add("due_date", dueAt);
    }
    const remindAt = action.remind_at === null ? undefined : nullableText(action, "remind_at", 40);
    if (remindAt !== undefined) {
      validateTaskTiming({ remind_at: remindAt });
      add("remind_at", remindAt);
    }
    if (action.priority !== null && Object.hasOwn(action, "priority")) add("priority", priority(action.priority));
    let status: "open" | "done" | undefined;
    if (action.status !== null && Object.hasOwn(action, "status")) {
      if (action.status !== "open" && action.status !== "done") {
        throw new Error("status must be open or done.");
      }
      status = action.status;
      add("status", status);
    }
    if (fields.length === 0) throw new Error("Task update has no fields to change.");
    const now = input.now.toISOString();
    add("updated_at", now);
    input.db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values, taskId);
    if (status) syncRecurringOccurrenceForTask(input.db, taskId, status, now);
    return;
  }
  if (action.kind === "pipeline_log_touch") {
    prepareActionFields(action, ["contact_id", "channel", "summary"], ["next_action", "next_follow_up_at"]);
    const channel = requiredActionText(action, "channel", 20);
    if (!["call", "email", "text", "meeting", "note"].includes(channel)) {
      throw new Error("Pipeline channel is invalid.");
    }
    const summary = requiredActionText(action, "summary", 5_000);
    input.pipeline.logTouch(requiredActionText(action, "contact_id", 200), {
      activityType: channel,
      title: summary.slice(0, 500),
      content: summary,
      direction: "internal",
      ...(action.next_action !== null && Object.hasOwn(action, "next_action")
        ? { nextAction: optionalActionText(action, "next_action", 500) ?? "" }
        : {}),
      ...(action.next_follow_up_at !== null && Object.hasOwn(action, "next_follow_up_at")
        ? { nextFollowUpAt: nullableText(action, "next_follow_up_at", 10) }
        : {}),
    });
    return;
  }
  if (action.kind === "pipeline_update") {
    prepareActionFields(
      action,
      ["contact_id"],
      ["next_action", "next_follow_up_at", "notes"],
      ["stage"],
    );
    if (action.stage !== null && action.stage !== undefined) {
      throw new Error("pipeline_update cannot change stage. Use pipeline_move.");
    }
    const patch = validatePipelinePatch({
      ...(action.next_action !== null && Object.hasOwn(action, "next_action")
        ? { next_action: optionalActionText(action, "next_action", 500) ?? "" }
        : {}),
      ...(action.next_follow_up_at !== null && Object.hasOwn(action, "next_follow_up_at")
        ? { next_follow_up_at: nullableText(action, "next_follow_up_at", 10) }
        : {}),
      ...(action.notes !== null && Object.hasOwn(action, "notes")
        ? { notes: optionalActionText(action, "notes", 5_000) ?? "" }
        : {}),
    });
    if (Object.keys(patch).length === 0) throw new Error("Pipeline update has no fields to change.");
    input.pipeline.update(requiredActionText(action, "contact_id", 200), patch);
    return;
  }
  if (action.kind === "pipeline_move") {
    prepareActionFields(action, ["contact_id", "stage"]);
    const stage = validatePipelineStage(action.stage);
    if (stage === "lost" || stage === "parked") {
      throw new Error("Lost and parked need the operator's judgment. Use suggest instead.");
    }
    input.pipeline.move(requiredActionText(action, "contact_id", 200), stage);
    return;
  }
  if (action.kind === "crm_note") {
    prepareActionFields(action, ["contact_id", "title", "content"]);
    input.crm.appendActivity({
      contactId: requiredActionText(action, "contact_id", 200),
      sourceRef: `chief-of-staff:${input.wakeJobId}:${action.action_id}`,
      activityType: "note",
      title: requiredActionText(action, "title", 500),
      content: requiredActionText(action, "content", 5_000),
      direction: "internal",
      source: "manual",
      occurredAt: input.now.toISOString(),
      metadata: { chiefOfStaffWakeJobId: input.wakeJobId, actionId: action.action_id },
      updateRecency: false,
    });
    return;
  }
  throw new Error(`Unknown action kind: ${action.kind}.`);
}

type ChiefOfStaffActionCounts = { applied: number; rejected: number; skipped: number;
};

type ChiefOfStaffActionRejection = { kind: string; reason: string };
type ChiefOfStaffActionDowngrade = { kind: string; reason: string };

type ChiefOfStaffAttentionDependencies = {
  shadow?: boolean;
  transport?: AttentionTransport;
  surface?: typeof surfaceAttentionSuggestion;
  surfaceSuppression?: typeof surfaceAttentionSuppression;
};

function applyChiefOfStaffActionsWithDetails(input: {
  dbPath: string;
  dataDir: string;
  wakeJobId: string;
  actions: ChiefOfStaffAction[];
  now?: Date;
  repoDir?: string;
  env?: NodeJS.ProcessEnv;
  attention?: ChiefOfStaffAttentionDependencies;
}): {
  counts: ChiefOfStaffActionCounts;
  rejections: ChiefOfStaffActionRejection[];
  downgrades: ChiefOfStaffActionDowngrade[];
} {
  const now = input.now ?? new Date();
  const db = openLocalDatabase(input.dbPath);
  const pipeline = new LocalPipelineStore({ database: db, now: () => now });
  const crm = new LocalCRMBackend({ database: db, now: () => now });
  const result = { applied: 0, rejected: 0, skipped: 0 };
  const rejections: ChiefOfStaffActionRejection[] = [];
  const downgrades: ChiefOfStaffActionDowngrade[] = [];
  const pipelineEnabled = salesPipelineEnabled(input.env);
  let textAttemptedThisWake = false;
  try {
    for (const proposedAction of input.actions) {
      const action = scrubChiefOfStaffAction(proposedAction);
      if (action.kind === "notify" && typeof action.reason === "string") {
        action.reason = stripStoredText(action.reason, 200);
      }
      const contentHash = chiefOfStaffActionContentHash(action);
      const existing = db.prepare(
        `SELECT status, payload_json
         FROM chief_of_staff_actions WHERE wake_job_id = ? AND content_hash = ?`,
      ).get(input.wakeJobId, contentHash) as
        | {
        status: string;
        payload_json: string;
      } | undefined;
      if (existing?.status === "applied") {
        try {
          const prior = JSON.parse(existing.payload_json) as Record<string, unknown>;
          textAttemptedThisWake ||= prior.kind === "notify" && prior.text_attempted === true;
        } catch {
          // A valid applied row still remains replay-safe if old audit JSON is malformed.
        }
        result.skipped += 1;
        continue;
      }
      try {
        if (action.kind === "phone_reminder") {
          prepareActionFields(action, ["task_id", "expected_version", "remind_at", "level", "reason", "next_action"]);
          const taskId = requiredActionText(action, "task_id", 200);
          assertSourceVersion(db, "task", taskId, action.expected_version);
          const task = db.prepare("SELECT * FROM tasks WHERE id = ? AND status = 'open'").get(taskId);
          const queued = queuePhoneReminder({ dataDir: input.dataDir, task, action, intentKey: `${input.wakeJobId}:${contentHash}` });
          action.phone_reminder_queued = queued.queued;
          action.phone_reminder_delivered = false;
          db.transaction(() => insertLedger(db, { wakeJobId: input.wakeJobId, contentHash, action, status: "applied", now: now.toISOString() }))();
        } else if (action.kind === "notify") {
          // The flat schema carries both a generic `why` and a notify `reason`.
          // Models often fill only `why`; treat it as the reason when `reason`
          // is empty so a real interruption is not lost to a field name.
          if (typeof action.reason !== "string" || !action.reason.trim()) {
            action.reason = typeof action.why === "string" ? action.why : null;
          }
          prepareActionFields(action, ["ref_kind", "ref_id", "level", "reason"]);
          const refKind = requiredActionText(action, "ref_kind", 20);
          if (refKind !== "task" && refKind !== "commitment" && refKind !== "deal") {
            throw new Error("notify ref_kind must be task, commitment, or deal.");
          }
          const level = requiredActionText(action, "level", 20);
          if (level !== "banner" && level !== "text") {
            throw new Error("notify level must be banner or text.");
          }
          const reason = stripStoredText(requiredActionText(action, "reason", 200), 200);
          if (!reason) throw new Error("notify reason must contain visible text.");
          const perWakeDowngrade = level === "text" && textAttemptedThisWake;
          if (perWakeDowngrade) {
            action.downgrade_reason = "one_text_per_wake";
            downgrades.push({ kind: "notify", reason: "one_text_per_wake" });
          }
          const outcome = deliverAttentionNudge({
            ...input.attention,
            db,
            dataDir: input.dataDir,
            repoDir: input.repoDir,
            refKind,
            refId: requiredActionText(action, "ref_id", 200),
            level,
            reason,
            includeReasonInBanner: true,
            now,
            allowText: !perWakeDowngrade,
            env: input.env,
          });
          textAttemptedThisWake ||= outcome.textAttempted;
          action.text_attempted = outcome.textAttempted;
          action.attention_ledger_id = outcome.row.id;
          action.delivered_level = outcome.finalLevel;
          db.transaction(() => insertLedger(db, {
            wakeJobId: input.wakeJobId,
            contentHash,
            action,
            status: "applied",
            now: now.toISOString(),
          }))();
        } else if (action.kind === "task_create") {
          // Compatibility for older mandates and queued outputs: model inference
          // is a proposal, never proof that the person accepted a new obligation.
          prepareActionFields(action,["title"],["details","due_at","remind_at","priority","project","status"]);
          if(action.status!=null && action.status!=="open")throw new Error("task_create status must be open.");
          const title=requiredActionText(action,"title",500);
          if(existingTaskWithTitle(db,title,now))throw new Error("A task with this title already exists. Read the current task.");
          const due=optionalActionText(action,"due_at",40);validateChiefOfStaffDueAt(due,"due_at");
          const description=[optionalActionText(action,"details",5000),due?`Proposed deadline, not yet confirmed: ${proposedDeadlineLabel(due)}`:null].filter(Boolean).join("\n");
          createWorkSuggestion({kind:"create_task",title,description,reason:requiredActionText(action,"why",200),source:"chief-of-staff",priority:priority(action.priority),
            claimKey:`cos:proposed:${createHash("sha256").update(normalizedTaskTitle(title)).digest("hex").slice(0,24)}`,dataDir:input.dataDir});
          action.downgraded_to="suggest";
          downgrades.push({kind:"task_create",reason:"new_work_requires_confirmation"});
          db.transaction(()=>insertLedger(db,{wakeJobId:input.wakeJobId,contentHash,action,status:"applied",now:now.toISOString()}))();
        } else if (action.kind === "suggest") {
          prepareActionFields(
            action,
            ["title", "description", "reason", "claim_key"],
            ["suggestion_kind", "priority", "due_date"],
          );
          const suggestionKind = action.suggestion_kind ?? "create_task";
          if (suggestionKind !== "create_task" && suggestionKind !== "attention_nudge") {
            throw new Error("Suggestion kind is invalid.");
          }
          const dueDate = optionalActionText(action, "due_date", 10);
          if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
            throw new Error("due_date must use YYYY-MM-DD.");
          }
          createWorkSuggestion({
            kind: suggestionKind,
            title: requiredActionText(action, "title", 500),
            description: requiredActionText(action, "description", 5_000),
            reason: requiredActionText(action, "reason", 2_000),
            source: "chief-of-staff",
            priority: priority(action.priority),
            dueDate,
            claimKey: requiredActionText(action, "claim_key", 300),
            dataDir: input.dataDir,
          });
          db.transaction(() => insertLedger(db, {
            wakeJobId: input.wakeJobId,
            contentHash,
            action,
            status: "applied",
            now: now.toISOString(),
          }))();
        } else {
          db.transaction(() => {
            applyDatabaseAction({
              db,
              pipeline,
              crm,
              action,
              wakeJobId: input.wakeJobId,
              now,
              salesPipelineEnabled: pipelineEnabled,
            });
            insertLedger(db, {
              wakeJobId: input.wakeJobId,
              contentHash,
              action,
              status: "applied",
              now: now.toISOString(),
            });
          }).immediate();
        }
        result.applied += 1;
      } catch (error) {
        if (error instanceof AttentionDeliveryRejected) {
          if (error.ledgerRowId) action.attention_ledger_id = error.ledgerRowId;
          if (error.deliveredLevel) action.delivered_level = error.deliveredLevel;
          action.text_attempted = error.textAttempted;
          textAttemptedThisWake ||= error.textAttempted;
        }
        const message = (error instanceof Error ? error.message : String(error))
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 1_000);
        db.transaction(() => insertLedger(db, {
          wakeJobId: input.wakeJobId,
          contentHash,
          action,
          status: "rejected",
          error: message,
          now: now.toISOString(),
        }))();
        result.rejected += 1;
        rejections.push({
          kind: scrubModelText(action.kind, 80),
          reason: scrubModelText(message, 300),
        });
      }
    }
    return { counts: result, rejections, downgrades };
  } finally {
    crm.close();
    pipeline.close();
    db.close();
  }
}

export function applyChiefOfStaffActions(input: {
  dbPath: string;
  dataDir: string;
  wakeJobId: string;
  actions: ChiefOfStaffAction[];
  now?: Date;
  repoDir?: string;
  env?: NodeJS.ProcessEnv;
  attention?: ChiefOfStaffAttentionDependencies;
}): ChiefOfStaffActionCounts {
  return applyChiefOfStaffActionsWithDetails(input).counts;
}

function actionOutcomeJournalLine(
  counts: ChiefOfStaffActionCounts,
  rejections: ChiefOfStaffActionRejection[],
  downgrades: ChiefOfStaffActionDowngrade[],
): string {
  const base = `outcome: applied ${counts.applied}, rejected ${counts.rejected}`;
  const rejectionText = counts.rejected > 0
    ? ` (${rejections.map(({ kind, reason }) => `${kind}: ${reason}`).join("; ")})`
    : "";
  const downgradeText = downgrades.length > 0
    ? `, downgraded ${downgrades.length} (${downgrades.map(({ kind, reason }) =>
      `${kind}: ${reason}`).join("; ")})`
    : "";
  return scrubModelText(`${base}${rejectionText}${downgradeText}`, 400);
}

export async function runWake(
  job: ScheduledJob,
  options: {
    repoDir: string;
    dataDir: string;
    dbPath: string;
    now?: () => Date;
    env?: NodeJS.ProcessEnv;
    codexPath?: string;
    claudePath?: string;
    timeoutMs?: number;
    spawnImpl?: typeof spawn;
    afterActionsApplied?: () => void;
    attention?: ChiefOfStaffAttentionDependencies;
  },
): Promise<JobHandlerResult> {
  const now = options.now?.() ?? new Date();
  const wake = parseWake(job.payload);
  const parentEnv = { ...(options.env ?? process.env), COVE_DATA_DIR: options.dataDir, COVE_DB_PATH: options.dbPath };
  const selection = readAgentSettings(parentEnv);
  let home = ensureChiefOfStaffHome({
    repoDir: options.repoDir,
    dataDir: options.dataDir,
    now,
  });
  renderChiefOfStaffMandateForWake({
    mandatePath: home.paths.mandate,
    repoDir: options.repoDir,
    dataDir: options.dataDir,
    env: parentEnv,
  });
  if (!selection || selection.provider === "codex") ensureChiefOfStaffCodexHome({ dataDir: options.dataDir, env: parentEnv });
  let reviewed: Responsibility[] = [];
  const snapshot = await buildChiefOfStaffSnapshot({
    jobId: job.id,
    wake,
    session: home.session,
    onResponsibilities: (seen) => { reviewed=seen; },
    dataDir: options.dataDir,
    dbPath: options.dbPath,
    now,
    env: parentEnv,
  });
  writeChiefOfStaffSnapshot({ dataDir: options.dataDir, jobId: job.id, snapshot });
  const temporary = mkdtempSync(path.join(os.tmpdir(), "cove-chief-of-staff-"));
  const invoke = async (sessionId: string | null): Promise<CodexAttempt> => {
    if (selection) {
      // Durable desk/journal state supplies continuity without an ever-growing
      // provider transcript. Never pass a previous provider's session ID.
      const result = await runJob<ChiefOfStaffOutput>({
        lane: "chief-of-staff",
        agentSettings: selection,
        kind: "structured",
        prompt: `${readFileSync(home.paths.mandate, "utf8")}\n\nCURRENT_DESK\n${snapshot}`,
        schema: JSON.parse(readFileSync(path.join(options.repoDir, "prompts", "chief-of-staff-output.schema.json"), "utf8")),
        env: selection.provider === "codex" ? { ...parentEnv, CODEX_HOME: home.paths.codexHome } : parentEnv,
        cwd: home.paths.workspace,
        codexPath: options.codexPath,
        claudePath: options.claudePath,
        claudeMcpConfigPath: path.join(options.repoDir, "scripts", "cove-empty-mcp.json"),
        claudeNoChrome: true,
        claudeDisableSlashCommands: true,
        timeoutMs: options.timeoutMs ?? WAKE_TIMEOUT_MS,
        spawnImpl: options.spawnImpl,
        validate: (_text, value) => validateChiefOfStaffOutput(value),
      });
      return result.ok
        ? { ok: true, exitCode: 0, stdout: "", stderr: "", timedOut: false, output: result.value }
        : { ok: false, exitCode: null, stdout: "", stderr: result.error.message, timedOut: result.error.code.endsWith("timeout") };
    }
    const outputPath = path.join(temporary, sessionId ? "resumed-output.json" : "fresh-output.json");
    const argv = buildChiefOfStaffCodexArgv({
      workspace: home.paths.workspace,
      schemaPath: path.join(options.repoDir, "prompts", "chief-of-staff-output.schema.json"),
      outputPath,
      sessionId,
    });
    return await runCodexAttempt({
      executable: options.codexPath ?? coveEnvTrimmed("CODEX_BIN", parentEnv) ?? "codex",
      argv,
      cwd: home.paths.workspace,
      snapshot,
      outputPath,
      env: { ...parentEnv, CODEX_HOME: home.paths.codexHome },
      timeoutMs: options.timeoutMs ?? WAKE_TIMEOUT_MS,
      spawnImpl: options.spawnImpl,
    });
  };
  try {
    let attempt = await invoke(home.session.sessionId);
    if (!selection && !attempt.ok && home.session.sessionId && resumeUnavailable(attempt)) {
      resetChiefOfStaffSession({
        dataDir: options.dataDir,
        why: "Codex could not resume the stored session, so Cove started a fresh one.",
        now,
      });
      home = ensureChiefOfStaffHome({
        repoDir: options.repoDir,
        dataDir: options.dataDir,
        now,
      });
      renderChiefOfStaffMandateForWake({
        mandatePath: home.paths.mandate,
        repoDir: options.repoDir,
        dataDir: options.dataDir,
        env: parentEnv,
      });
      ensureChiefOfStaffCodexHome({ dataDir: options.dataDir, env: parentEnv });
      attempt = await invoke(null);
    }
    if (!attempt.ok || !attempt.output) {
      appendChiefOfStaffJournal({
        dataDir: options.dataDir,
        reason: wake.reason,
        lines: [attempt.timedOut ? "Wake timed out and will retry." : `Wake failed and will retry: ${attempt.stderr}`],
        now,
      });
      throw new Error(attempt.timedOut ? "Chief-of-staff wake timed out." : attempt.stderr);
    }
    const actionResult = applyChiefOfStaffActionsWithDetails({
      dbPath: options.dbPath,
      dataDir: options.dataDir,
      wakeJobId: job.id,
      actions: attempt.output.actions,
      now,
      repoDir: options.repoDir,
      env: parentEnv,
      attention: options.attention,
    });
    const markDb=openLocalDatabase(options.dbPath);
    try { if (actionResult.counts.rejected === 0) {
        markResponsibilitiesReviewed(markDb,reviewed,now);
        // Only defer questions actually delivered in this bounded snapshot.
        const seenQuestions = markDb
          .prepare(
            "SELECT id,revision FROM cove_planning_questions WHERE state='open' AND next_check_at<=?",
          )
          .all(now.toISOString()) as { id: string; revision: number }[];
        for (const question of seenQuestions) {
          if (
            !snapshot
              .split("\n")
              .some(
                (line) =>
                  line.includes(`"id":"${question.id}"`) &&
                  line.includes(`"revision":${question.revision}`),
              )
          )
            continue;
          markDb
            .prepare(
              "UPDATE cove_planning_questions SET next_check_at=MIN(expires_at,?),revision=revision+1,updated_at=? WHERE id=? AND revision=?",
            )
            .run(
              new Date(+now + 3 * 3600000).toISOString(),
              now.toISOString(),
              question.id,
              question.revision,
            );
        }
      }
    }
    finally { markDb.close();
    }
    if (
      wake.reason !== "brief" &&
      attempt.output.actions.some((a) => a.kind === "replan_day") &&
      actionResult.counts.rejected === 0
    ) {
      const plans = createDayPlanStore({
        dbPath: options.dbPath,
        now: () => now,
      });
      try {
        const current = plans.getReadModel().currentPlan;
        if (current && ["draft", "proposed"].includes(current.state) &&
            !current.arrivalInteractedAt)
          plans.enqueueMorningBrief(current.localDate, morningBriefModelConfig());
      } finally {
        plans.close();
      }
    }
    options.afterActionsApplied?.();
    appendChiefOfStaffJournal({
      dataDir: options.dataDir,
      reason: wake.reason,
      lines: [
        ...attempt.output.journal,
        actionOutcomeJournalLine(
          actionResult.counts,
          actionResult.rejections,
          actionResult.downgrades,
        ),
      ],
      now,
      maxCharsPerLine: 400,
      maxTotalCharsPerLine: 400,
    });
    const sessionId = selection ? null : (home.session.sessionId ?? attempt.sessionId ?? null);
    if (!sessionId && !selection) {
      appendChiefOfStaffJournal({
        dataDir: options.dataDir,
        reason: wake.reason,
        lines: [`Codex completed without a session id. The next wake will start fresh. Stdout: ${scrubModelText(attempt.stdout.slice(0, 2_000), 2_000)}`],
        now,
        maxCharsPerLine: 2_200,
      });
    }
    writeChiefOfStaffSession(options.dataDir, {
      ...home.session,
      sessionId,
      wakes: home.session.wakes + 1,
      lastWakeAt: now.toISOString(),
      lastWakeReason: wake.reason,
    });
    return {
      summary: `Chief of staff completed a ${wake.reason} wake.`,
      actions: { ...actionResult.counts, watching: attempt.output.watching },
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export type { PipelineStage };

/** Morning and material-change planning share the chief's decision contract.
 * The morning lane retains its reserved budget and existing durable lease. */
export async function planDay(input: {
  context: PlanningContext;
  sourcePrompt: string;
  run: Omit<
    import("../model-runner").RunJobRuntimeInput,
    "prompt" | "schema" | "kind" | "validate"
  >;
}) {
  return runJob<import("../day-plan/brief").MorningBrief>({
    ...input.run,
    kind: "structured",
    prompt: dailyPlanningPrompt(input.context, input.sourcePrompt),
    schema: dailyPlanningSchema(input.context),
    validate: (_text, value) =>
      decisionAsBrief(validateDailyDecision(value, input.context, { requireNarrative: true, sourcePrompt: input.sourcePrompt })),
  });
}
