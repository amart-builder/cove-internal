import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalCRMBackend } from "../crm/local";
import {
  isOpenPipelineStage,
  validatePipelinePatch,
  validatePipelineStage,
  type PipelineStage,
} from "../crm/pipeline";
import { LocalPipelineStore } from "../crm/pipeline-store";
import { coveEnvTrimmed } from "../env";
import { openLocalDatabase } from "../local/database";
import { validateTaskTiming } from "../local/db";
import { createWorkSuggestion } from "../quiet-current/store";
import { syncRecurringOccurrenceForTask } from "../tasks/recurrence";
import { taskColumnKeyForName } from "../tasks/columns";
import type { JobHandlerResult, ScheduledJob } from "../reliability/jobs";
import {
  appendChiefOfStaffJournal,
  ensureChiefOfStaffCodexHome,
  ensureChiefOfStaffHome,
  resetChiefOfStaffSession,
  writeChiefOfStaffSession,
} from "./storage";
import { buildChiefOfStaffSnapshot, writeChiefOfStaffSnapshot } from "./snapshot";
import {
  CHIEF_OF_STAFF_REASONS,
  optionalActionText,
  requiredActionText,
  scrubChiefOfStaffAction,
  scrubModelText,
  validateChiefOfStaffOutput,
  type ChiefOfStaffAction,
  type ChiefOfStaffOutput,
  type ChiefOfStaffWakePayload,
} from "./types";

const WAKE_TIMEOUT_MS = 15 * 60_000;
const MAX_PROCESS_OUTPUT = 4 * 1024 * 1024;

type CodexAttempt = {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  output?: ChiefOfStaffOutput;
  sessionId?: string;
};

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
    allowed.flatMap((key) => env[key] === undefined ? [] : [[key, env[key]]]),
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
  return attempt.exitCode !== null && attempt.exitCode !== 0 &&
    /thread\/resume failed|no rollout found for thread id/i.test(attempt.stderr);
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

function exactKeys(
  action: ChiefOfStaffAction,
  required: string[],
  optional: string[] = [],
): void {
  const allowed = new Set(["action_id", "kind", "why", ...required, ...optional]);
  for (const field of required) {
    if (!Object.hasOwn(action, field)) throw new Error(`${field} is required.`);
  }
  for (const field of Object.keys(action)) {
    if (!allowed.has(field) && action[field] !== null) {
      throw new Error(`Unknown ${action.kind} field: ${field}.`);
    }
  }
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

function validateDueAt(value: string | null | undefined, field: string): void {
  if (value === undefined || value === null || value === "") return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isNaN(Date.parse(value))) {
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

const ACTION_HASH_FIELDS: Record<string, string[]> = {
  task_create: ["title", "details", "due_at", "remind_at", "priority", "project", "status"],
  task_update: ["task_id", "title", "details", "due_at", "remind_at", "priority", "status"],
  pipeline_add: ["contact_id", "stage", "next_action", "next_follow_up_at", "notes"],
  pipeline_log_touch: ["contact_id", "channel", "summary", "next_action", "next_follow_up_at"],
  pipeline_update: ["contact_id", "next_action", "next_follow_up_at", "notes"],
  pipeline_move: ["contact_id", "stage"],
  crm_note: ["contact_id", "title", "content"],
  suggest: ["suggestion_kind", "title", "description", "reason", "priority", "due_date", "claim_key"],
};

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
  const fields = ACTION_HASH_FIELDS[action.kind] ?? Object.keys(action)
    .filter((field) => field !== "action_id" && field !== "why" && field !== "kind");
  const payload = Object.fromEntries(fields.map((field) => [field, action[field] ?? null]));
  return createHash("sha256").update(`${action.kind}\n${canonicalJson(payload)}`).digest("hex");
}

function applyDatabaseAction(input: {
  db: Database.Database;
  pipeline: LocalPipelineStore;
  crm: LocalCRMBackend;
  action: ChiefOfStaffAction;
  wakeJobId: string;
  now: Date;
}): void {
  const { action } = input;
  if (action.kind === "task_create") {
    exactKeys(action, ["title"], ["details", "due_at", "remind_at", "priority", "project", "status"]);
    if (action.status !== null && action.status !== undefined && action.status !== "open") {
      throw new Error("task_create status must be open.");
    }
    const title = requiredActionText(action, "title", 500);
    const details = optionalActionText(action, "details", 5_000) ?? "";
    const dueAt = action.due_at === null ? undefined : nullableText(action, "due_at", 40);
    const remindAt = action.remind_at === null ? undefined : nullableText(action, "remind_at", 40);
    validateDueAt(dueAt, "due_at");
    const taskPriority = priority(action.priority);
    const project = optionalActionText(action, "project", 200) ?? "Atlas";
    const timing = { remind_at: remindAt ?? null };
    validateTaskTiming(timing);
    const now = input.now.toISOString();
    const todayColumn = (input.db.prepare(
      "SELECT id, name FROM task_columns ORDER BY position ASC",
    ).all() as Array<{ id: string; name: string }>).find(
      (column) => taskColumnKeyForName(column.name) === "today",
    );
    if (!todayColumn) throw new Error("Cove needs a Today list to add work.");
    const position = input.db.prepare(
      "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM tasks WHERE column_id = ? AND status = 'open'",
    ).pluck().get(todayColumn.id) as number;
    input.db.prepare(
      `INSERT INTO tasks
         (id, column_id, title, description, priority, due_at, due_date, tags, project,
          position, status, source_type, remind_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, 'open', 'chief-of-staff', ?, ?, ?)`,
    ).run(
      randomUUID(), todayColumn.id, title, details, taskPriority, dueAt ?? null,
      dueAt ?? null, project, position, remindAt ?? null, now, now,
    );
    return;
  }
  if (action.kind === "pipeline_add") {
    exactKeys(
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
    exactKeys(action, ["task_id"], ["title", "details", "due_at", "remind_at", "priority", "status"]);
    const taskId = requiredActionText(action, "task_id", 200);
    const existing = input.db.prepare("SELECT id FROM tasks WHERE id = ?").get(taskId);
    if (!existing) throw new Error("Task was not found.");
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
      validateDueAt(dueAt, "due_at");
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
    exactKeys(action, ["contact_id", "channel", "summary"], ["next_action", "next_follow_up_at"]);
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
    exactKeys(action, ["contact_id"], ["next_action", "next_follow_up_at", "notes"]);
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
    exactKeys(action, ["contact_id", "stage"]);
    const stage = validatePipelineStage(action.stage);
    if (stage === "lost" || stage === "parked") {
      throw new Error("Lost and parked require Alex's judgment. Use suggest instead.");
    }
    input.pipeline.move(requiredActionText(action, "contact_id", 200), stage);
    return;
  }
  if (action.kind === "crm_note") {
    exactKeys(action, ["contact_id", "title", "content"]);
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

type ChiefOfStaffActionCounts = { applied: number; rejected: number; skipped: number };

type ChiefOfStaffActionRejection = { kind: string; reason: string };

function applyChiefOfStaffActionsWithDetails(input: {
  dbPath: string;
  dataDir: string;
  wakeJobId: string;
  actions: ChiefOfStaffAction[];
  now?: Date;
}): { counts: ChiefOfStaffActionCounts; rejections: ChiefOfStaffActionRejection[] } {
  const now = input.now ?? new Date();
  const db = openLocalDatabase(input.dbPath);
  const pipeline = new LocalPipelineStore({ database: db, now: () => now });
  const crm = new LocalCRMBackend({ database: db, now: () => now });
  const result = { applied: 0, rejected: 0, skipped: 0 };
  const rejections: ChiefOfStaffActionRejection[] = [];
  try {
    for (const proposedAction of input.actions) {
      const action = scrubChiefOfStaffAction(proposedAction);
      const contentHash = chiefOfStaffActionContentHash(action);
      const existing = db.prepare(
        `SELECT status FROM chief_of_staff_actions WHERE wake_job_id = ? AND content_hash = ?`,
      ).get(input.wakeJobId, contentHash) as { status: string } | undefined;
      if (existing?.status === "applied") {
        result.skipped += 1;
        continue;
      }
      try {
        if (action.kind === "suggest") {
          exactKeys(
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
            applyDatabaseAction({ db, pipeline, crm, action, wakeJobId: input.wakeJobId, now });
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
    return { counts: result, rejections };
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
}): ChiefOfStaffActionCounts {
  return applyChiefOfStaffActionsWithDetails(input).counts;
}

function actionOutcomeJournalLine(
  counts: ChiefOfStaffActionCounts,
  rejections: ChiefOfStaffActionRejection[],
): string {
  const base = `outcome: applied ${counts.applied}, rejected ${counts.rejected}`;
  if (counts.rejected === 0) return base;
  const details = rejections.map(({ kind, reason }) => `${kind}: ${reason}`).join("; ");
  return scrubModelText(`${base} (${details})`, 400);
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
    timeoutMs?: number;
    spawnImpl?: typeof spawn;
    afterActionsApplied?: () => void;
  },
): Promise<JobHandlerResult> {
  const now = options.now?.() ?? new Date();
  const wake = parseWake(job.payload);
  const parentEnv = options.env ?? process.env;
  let home = ensureChiefOfStaffHome({ repoDir: options.repoDir, dataDir: options.dataDir, now });
  ensureChiefOfStaffCodexHome({ dataDir: options.dataDir, env: parentEnv });
  const snapshot = await buildChiefOfStaffSnapshot({
    jobId: job.id,
    wake,
    session: home.session,
    dataDir: options.dataDir,
    dbPath: options.dbPath,
    now,
  });
  writeChiefOfStaffSnapshot({ dataDir: options.dataDir, jobId: job.id, snapshot });
  const temporary = mkdtempSync(path.join(os.tmpdir(), "cove-chief-of-staff-"));
  const invoke = async (sessionId: string | null): Promise<CodexAttempt> => {
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
    if (!attempt.ok && home.session.sessionId && resumeUnavailable(attempt)) {
      resetChiefOfStaffSession({
        dataDir: options.dataDir,
        why: "Codex could not resume the stored session, so Cove started a fresh one.",
        now,
      });
      home = ensureChiefOfStaffHome({ repoDir: options.repoDir, dataDir: options.dataDir, now });
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
    });
    options.afterActionsApplied?.();
    appendChiefOfStaffJournal({
      dataDir: options.dataDir,
      reason: wake.reason,
      lines: [
        ...attempt.output.journal,
        actionOutcomeJournalLine(actionResult.counts, actionResult.rejections),
      ],
      now,
      maxCharsPerLine: 400,
      maxTotalCharsPerLine: 400,
    });
    const sessionId = home.session.sessionId ?? attempt.sessionId ?? null;
    if (!sessionId) {
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
