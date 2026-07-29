import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import type { InboundEvent } from "../data/types";
import path from "node:path";
import type { DayPlanStore } from "../day-plan/store";
import {
  assembleMorningBriefContext,
  localDateInTimezone,
  morningBriefInputHash,
  stripMorningBriefDateClaim,
  validateMorningBrief,
  MORNING_BRIEF_PROMPT_VERSION,
  MORNING_BRIEF_SCHEMA_VERSION,
  type MorningBriefArtifact,
} from "../day-plan/brief";
import { evaluateScheduledBriefGate } from "../day-plan/brief-gate";
import {
  briefCheckpointSources,
  collectMorningBriefSources,
  defaultBriefWebBase,
  fetchRows,
  type CollectedBriefSources,
} from "../day-plan/brief-sources";
import {
  type CheckpointSourceSpec,
  exportBriefArtifact,
  liveRemoteBriefAttempt,
  originHost,
  scanAndImportBriefRelay,
  sweepBriefRelayOutbox,
  verifySourceCheckpoint,
  writeBriefAttemptStatus,
  writeDayClosureRelay,
  writeDumpRelay,
  writeSettlementRelay,
  writeSourceCheckpoint,
} from "../day-plan/brief-relay";
import {
  buildExecutionCommand,
  countExecutionToolUseEvents,
  isPlanExecutionResultDegenerate,
  parseExecutionResultSummary,
  type ClaudeCommand,
} from "./commands";
import {
  buildMorningBriefCommand,
  buildMorningBriefPrompt,
  morningBriefModelConfig,
  parseMorningBriefOutput,
} from "./brief-commands";
import {
  configuredMorningBriefWriter,
  createCodexMorningBriefAttempt,
  createCodexStructuredAttempt,
  readCodexMorningBriefOutput,
  readCodexStructuredOutput,
  type MorningBriefWriter,
} from "./morning-brief-writer";
import {
  buildDayDumpCommand,
  buildDayDumpPrompt,
  parseDayDumpOutput,
  validateDayDump,
  type DumpExistingCommitment,
  type DumpResolution,
} from "./dump-commands";
import { markForgeOrchestratorSession } from "./orchestrator-session";
import {
  notifyExecutionRun,
  rememberNotificationTransition,
  type ExecutionNotificationInput,
} from "./notify";
import {
  drainSpoolFiles,
  getEvent,
  listUnresolved,
  resolveEvent,
} from "../intake/inbox";
import {
  createFallbackInboundTask,
} from "../intake/task-writer";
import { coveEnv } from "../env";
import { recordReceipt, type ReceiptOutcome } from "../reliability/receipts";

export { fallbackInboundDueAt } from "../intake/task-writer";

type SpawnImpl = typeof spawn;
type ExecutionNotifier = (input: ExecutionNotificationInput) => void | Promise<void>;
const WORKER_PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1_000);
const workerNotifiedTransitions = new Set<string>();

export type ClaudeWorkerOptions = {
  store: DayPlanStore;
  claudePath: string;
  emptyMcpConfigPath: string;
  logDir: string;
  fallbackCwd: string;
  spawnImpl?: SpawnImpl;
  now?: () => Date;
  workerPid?: number;
  heartbeatIntervalMs?: number;
  timeoutMs?: number;
  terminationGraceMs?: number;
  abortSignal?: AbortSignal;
  markSession?: (sessionId: string) => void;
  openSession?: (sessionId: string) => void;
  notifyExecution?: ExecutionNotifier;
  processStartedAt?: Date;
  notifiedTransitions?: Set<string>;
};

type ChildResult = {
  exitCode: number | undefined;
  signal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
  overflowed: boolean;
  terminatedBy?: "timeout" | "cancelled" | "shutdown";
};

export function emitExecutionTransitionNotification(input: {
  run: ReturnType<DayPlanStore["getExecutionRun"]>;
  previousStatus: ExecutionNotificationInput["state"];
  processStartedAt?: Date;
  notify?: ExecutionNotifier;
  notifiedTransitions?: Set<string>;
}): void {
  const run = input.run;
  if (!run || run.status === input.previousStatus) return;
  if (!["plan_ready", "ready_to_join", "awaiting_review", "failed"].includes(run.status)) return;
  const processStartedAt = input.processStartedAt ?? WORKER_PROCESS_STARTED_AT;
  if (new Date(run.updatedAt).getTime() < processStartedAt.getTime()) return;
  const notifiedTransitions = input.notifiedTransitions ?? workerNotifiedTransitions;
  const transitionKey = `${run.id}:${run.status}`;
  if (!rememberNotificationTransition(notifiedTransitions, transitionKey)) return;
  try {
    void Promise.resolve((input.notify ?? notifyExecutionRun)({
      runId: run.id,
      state: run.status,
      itemTitle: run.promptSnapshot.title,
      claudeSessionId: run.claudeSessionId,
      transitionedAt: run.updatedAt,
    })).catch(() => undefined);
  } catch {
    // Notifications never participate in the durable run lifecycle.
  }
}

export function openClaudeSessionInBackground(
  sessionId: string,
  spawnImpl: SpawnImpl = spawn,
): void {
  if (process.platform !== "darwin" || coveEnv("BUDDY_DEEPLINKS") === "0") return;
  try {
    const child = spawnImpl(
      "/usr/bin/open",
      ["-g", `claude://resume?session=${encodeURIComponent(sessionId)}`],
      { detached: true, stdio: "ignore" },
    );
    child.once("error", (error) => {
      console.error("Could not open Cove session in Claude Code.", error);
    });
    child.unref();
  } catch (error) {
    console.error("Could not open Cove session in Claude Code.", error);
  }
}

export function minimalChildEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL",
    "NODE_ENV", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ];
  return Object.fromEntries(
    allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]!]]),
  ) as NodeJS.ProcessEnv;
}

export function signalProcessGroup(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if the process group is already gone.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The child may have exited between the status check and signal.
  }
}

function spawnCommand(
  command: ClaudeCommand,
  options: {
    spawnImpl: SpawnImpl;
    timeoutMs: number;
    maxStdoutBytes: number;
    maxStderrBytes: number;
    onSpawn?: (child: ChildProcessWithoutNullStreams) => void;
    onChunk?: (stream: "stdout" | "stderr", chunk: Buffer) => void;
    onPulse?: () => boolean;
    pulseIntervalMs?: number;
    terminationGraceMs: number;
    abortSignal?: AbortSignal;
  },
): Promise<ChildResult> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = options.spawnImpl(command.executable, command.args, {
        cwd: command.cwd,
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: minimalChildEnvironment(),
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      resolve({
        exitCode: undefined,
        stdout: "",
        stderr: error instanceof Error ? error.message : "spawn_failed",
        overflowed: false,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflowed = false;
    let settled = false;
    let terminatedBy: ChildResult["terminatedBy"];
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = (reason: NonNullable<ChildResult["terminatedBy"]>) => {
      if (terminatedBy) return;
      terminatedBy = reason;
      signalProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(
        () => signalProcessGroup(child, "SIGKILL"),
        options.terminationGraceMs,
      );
      killTimer.unref();
    };
    const timer = setTimeout(() => terminate("timeout"), options.timeoutMs);
    timer.unref();
    const pulse = options.onPulse
      ? setInterval(() => {
          if (!options.onPulse?.()) terminate("cancelled");
        }, options.pulseIntervalMs ?? 15_000)
      : undefined;
    pulse?.unref();
    const onAbort = () => terminate("shutdown");
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      options.onSpawn?.(child);
    } catch (error) {
      stderr = error instanceof Error ? error.message : "spawn_registration_failed";
      terminate("cancelled");
    }

    child.stdout.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      options.onChunk?.("stdout", chunk);
      if (stdoutBytes + chunk.length <= options.maxStdoutBytes) {
        stdout += chunk.toString("utf8");
        stdoutBytes += chunk.length;
      } else {
        overflowed = true;
      }
    });
    child.stderr.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      options.onChunk?.("stderr", chunk);
      if (stderrBytes + chunk.length <= options.maxStderrBytes) {
        stderr += chunk.toString("utf8");
        stderrBytes += chunk.length;
      } else {
        overflowed = true;
      }
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (pulse) clearInterval(pulse);
      options.abortSignal?.removeEventListener("abort", onAbort);
      resolve({ exitCode: undefined, stdout, stderr: error.message, overflowed, terminatedBy });
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (pulse) clearInterval(pulse);
      options.abortSignal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: code ?? undefined,
        signal: signal ?? undefined,
        stdout,
        stderr,
        overflowed,
        terminatedBy,
      });
    });
    // A stream 'error' with no listener is an uncaught exception, not a
    // rejected promise. `claude` exiting before the prompt finishes writing
    // makes this EPIPE, and it exits immediately when nobody is signed in, so
    // the unguarded version takes the process down on a routine failure. The
    // child's own close handler still settles the result.
    child.stdin.once("error", () => signalProcessGroup(child, "SIGTERM"));
    child.stdin.end(command.stdin);
  });
}

function cutoff(now: Date, ageMs: number): string {
  return new Date(now.getTime() - ageMs).toISOString();
}

export function isExpectedClaudeProcess(
  command: string,
  claudePath: string,
  sessionId: string,
): boolean {
  return command.includes(claudePath) &&
    command.includes("--session-id") &&
    command.includes(sessionId);
}

function processCommand(pid: number): string | undefined {
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 64 * 1024,
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function terminateVerifiedOrphan(
  pid: number,
  graceMs: number,
): Promise<void> {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The expected process exited after TERM.
  }
}

export async function recoverStaleOrphanGroups(
  options: ClaudeWorkerOptions,
  staleBefore: string,
): Promise<number> {
  const stale = options.store.recoverStaleExecutionRuns(staleBefore);
  for (const run of stale) {
    if (!run.pid) continue;
    const command = processCommand(run.pid);
    if (!command || !isExpectedClaudeProcess(command, options.claudePath, run.claudeSessionId)) {
      continue;
    }
    await terminateVerifiedOrphan(run.pid, options.terminationGraceMs ?? 2000);
  }
  return stale.length;
}

function createBoundedLog(logDir: string, runId: string, maximumBytes: number) {
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  chmodSync(logDir, 0o700);
  const logPath = path.join(logDir, `${runId}.jsonl`);
  const fd = openSync(logPath, "wx", 0o600);
  let written = 0;
  let truncated = false;
  return {
    path: logPath,
    write(stream: "stdout" | "stderr", chunk: Buffer) {
      if (truncated) return;
      const line = Buffer.from(`${JSON.stringify({ stream, data: chunk.toString("utf8") })}\n`);
      if (written + line.length > maximumBytes) {
        truncated = true;
        const marker = Buffer.from(`${JSON.stringify({ event: "log_truncated" })}\n`);
        if (written + marker.length <= maximumBytes) {
          writeSync(fd, marker);
          written += marker.length;
        }
        return;
      }
      writeSync(fd, line);
      written += line.length;
    },
    close() {
      closeSync(fd);
      chmodSync(logPath, 0o600);
    },
  };
}

export async function runOneExecution(options: ClaudeWorkerOptions): Promise<boolean> {
  const clock = options.now ?? (() => new Date());
  const workerPid = options.workerPid ?? process.pid;
  await recoverStaleOrphanGroups(options, cutoff(clock(), 10 * 60 * 1000));
  const run = options.store.claimNextExecutionRun(workerPid);
  if (!run) return false;

  let log: ReturnType<typeof createBoundedLog> | undefined;
  try {
    log = createBoundedLog(options.logDir, run.id, 2 * 1024 * 1024);
    options.store.setExecutionRunLogPath(run.id, log.path);
    const command = buildExecutionCommand({
      claudePath: options.claudePath,
      emptyMcpConfigPath: options.emptyMcpConfigPath,
      run,
      fallbackCwd: options.fallbackCwd,
    });
    let childPid: number | undefined;
    const result = await spawnCommand(command, {
      spawnImpl: options.spawnImpl ?? spawn,
      timeoutMs: options.timeoutMs ?? 30 * 60 * 1000,
      maxStdoutBytes: 1024 * 1024,
      maxStderrBytes: 64 * 1024,
      terminationGraceMs: options.terminationGraceMs ?? 2000,
      abortSignal: options.abortSignal,
      onSpawn: (child) => {
        childPid = child.pid;
        if (!childPid) return;
        try {
          (options.markSession ?? markForgeOrchestratorSession)(run.claudeSessionId);
        } catch (error) {
          console.error("Could not mark Cove orchestrator session.", error);
        }
        options.store.markExecutionRunRunning(run.id, childPid);
      },
      onPulse: () => childPid
        ? options.store.heartbeatExecutionRun(run.id, childPid)
        : true,
      pulseIntervalMs: options.heartbeatIntervalMs ?? 15_000,
      onChunk: (stream, chunk) => log?.write(stream, chunk),
    });
    let resultSummary;
    let resultError: string | undefined;
    if (result.exitCode === 0 && !result.terminatedBy && !result.overflowed) {
      try {
        const parsedSummary = parseExecutionResultSummary(result.stdout, run.mode);
        if (
          run.mode === "plan_review" &&
          isPlanExecutionResultDegenerate(
            parsedSummary.text,
            countExecutionToolUseEvents(result.stdout),
          )
        ) {
          resultError = "plan_degenerate";
        } else {
          resultSummary = parsedSummary;
        }
      } catch (error) {
        const errorCode = error instanceof Error ? error.message : "execution_result_missing";
        resultError = run.mode === "plan_review" && errorCode === "execution_result_missing"
          ? "plan_degenerate"
          : errorCode;
      }
    }
    const interrupted = result.terminatedBy === "shutdown" || result.terminatedBy === "timeout";
    const finished = options.store.finishExecutionRun({
      runId: run.id,
      exitCode: resultSummary || resultError === "plan_degenerate"
        ? result.exitCode
        : undefined,
      interrupted,
      resultSummary,
      errorCode: result.terminatedBy === "cancelled"
        ? "user_cancelled"
        : interrupted || result.signal
          ? result.terminatedBy === "timeout" ? "execution_timeout" : "worker_interrupted"
          : result.overflowed
            ? "execution_output_too_large"
            : resultSummary
              // A successful run (exit 0 with a parsed result) carries no error code.
              ? undefined
              : resultError ?? (childPid ? "claude_failed" : "spawn_failed"),
    });
    emitExecutionTransitionNotification({
      run: finished,
      previousStatus: run.status,
      processStartedAt: options.processStartedAt,
      notify: options.notifyExecution,
      notifiedTransitions: options.notifiedTransitions,
    });
    if (
      resultSummary &&
      ["plan_ready", "ready_to_join", "awaiting_review"].includes(finished.status)
    ) {
      try {
        (options.openSession ?? openClaudeSessionInBackground)(finished.claudeSessionId);
      } catch (error) {
        console.error("Could not open Cove session in Claude Code.", error);
      }
    }
  } catch (error) {
    const finished = options.store.finishExecutionRun({
      runId: run.id,
      errorCode: error instanceof Error ? error.message : "worker_failed",
    });
    emitExecutionTransitionNotification({
      run: finished,
      previousStatus: run.status,
      processStartedAt: options.processStartedAt,
      notify: options.notifyExecution,
      notifiedTransitions: options.notifiedTransitions,
    });
  } finally {
    log?.close();
  }
  return true;
}

// Cross-machine relay wiring for the brief lane. Presence turns the relay on;
// absence keeps the lane purely local (the default in tests). requireSourceCheckpoint
// marks a non-authoritative generator (the Mini): it gates on the MBP's source
// checkpoint and never publishes the checkpoint or settlement summary itself.
export type BriefRelayOptions = {
  dataDir: string;
  host?: string;
  requireSourceCheckpoint?: boolean;
  goalsPath?: string;
  operatorProfilePath?: string;
  leadupPath?: string;
  sprintMemoPath?: string;
};

export type MorningBriefWorkerOptions = ClaudeWorkerOptions & {
  // Test seam; production uses the real collector (files + loopback task fetch).
  collectBriefSources?: (store: DayPlanStore) => Promise<CollectedBriefSources>;
  briefTimeoutMs?: number;
  briefWriter?: MorningBriefWriter;
  codexPath?: string;
  relay?: BriefRelayOptions;
  receiptDbPath?: string;
};

export type DayDumpWorkerOptions = ClaudeWorkerOptions & {
  dumpTimeoutMs?: number;
  dumpWriter?: MorningBriefWriter;
  codexPath?: string;
  webBaseUrl?: string;
  fetchImpl?: typeof fetch;
  dumpFetchTimeoutMs?: number;
  // The dump lane publishes the dump relay, so it needs the same scoped data
  // directory the brief lane uses. Without it the write falls back to the
  // ambient COVE_DB_PATH/cwd and a test run overwrites the real relay file.
  relay?: BriefRelayOptions;
};

export type InboundWorkerOptions = {
  abortSignal?: AbortSignal;
  dataDir?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  webBaseUrl?: string;
  fetchTimeoutMs?: number;
  triageEvent?: (
    event: InboundEvent,
    input: { taskId: string },
  ) => Promise<boolean | undefined>;
};

export function configuredDayDumpWriter(
  env: NodeJS.ProcessEnv = process.env,
): MorningBriefWriter {
  return coveEnv("DUMP_WRITER", env)?.trim().toLowerCase() === "claude" ? "claude" : "codex";
}

const DUMP_KINDS = new Set([
  "follow_up",
  "promise",
  "waiting_on",
  "open_decision",
  "overnight_request",
  "idea",
]);

function dumpCommitmentRow(value: unknown): DumpExistingCommitment | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    typeof row.title !== "string" ||
    typeof row.kind !== "string" ||
    !DUMP_KINDS.has(row.kind)
  ) {
    return undefined;
  }
  return {
    id: row.id,
    title: row.title,
    kind: row.kind as DumpExistingCommitment["kind"],
    source_quote: typeof row.source_quote === "string" ? row.source_quote : null,
  };
}

function correctionPrompt(prompt: string, error: unknown): string {
  const reason = (error instanceof Error ? error.message : "validation failed")
    .replace(/\s+/g, " ")
    .slice(0, 240);
  return `${prompt}\n\nYour previous output failed validation: ${reason}. Emit ONLY the required JSON object.`;
}

async function forgeCsrfToken(
  fetchImpl: typeof fetch,
  baseUrl: string,
  timeoutMs: number,
): Promise<string> {
  const response = await fetchImpl(`${baseUrl}/api/day-plan`, {
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`day_plan_token_${response.status}`);
  const payload = await response.json() as unknown;
  const token = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).csrfToken
    : undefined;
  if (typeof token !== "string" || !token) throw new Error("day_plan_token_missing");
  return token;
}

function dumpEvidenceObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Preserve legacy free text below.
  }
  return { prior_evidence: value.slice(0, 500) };
}

function dumpResolutionEvidence(
  resolution: DumpResolution,
  dumpId: string,
  timestamp: string,
): Record<string, unknown> {
  if (resolution.confidence !== "high") {
    return {
      proposed_resolution: {
        action: resolution.action,
        quote: resolution.quote,
        note: resolution.note,
        due_at: resolution.due_at,
        confidence: resolution.confidence,
        dump_id: dumpId,
        proposed_at: timestamp,
      },
    };
  }
  if (resolution.action === "done") {
    return {
      resolved_by: "day_dump",
      dump_id: dumpId,
      quote: resolution.quote,
      note: resolution.note,
      resolved_at: timestamp,
    };
  }
  return {
    updated_by: "day_dump",
    dump_id: dumpId,
    quote: resolution.quote,
    note: resolution.note,
    updated_at: timestamp,
  };
}

export async function runOneDayDump(
  options: DayDumpWorkerOptions,
): Promise<boolean> {
  const clock = options.now ?? (() => new Date());
  const model = morningBriefModelConfig();
  const timeoutMs = options.dumpTimeoutMs ?? model.timeoutMs;
  const staleAfterMs = Math.max(20 * 60 * 1000, timeoutMs + 5 * 60 * 1000);
  try {
    options.store.interruptStaleDayDumps(cutoff(clock(), staleAfterMs));
  } catch (error) {
    console.error("Day dump stale sweep failed; continuing.", error);
  }
  const claimed = options.store.claimNextDayDump();
  if (!claimed) return false;
  const failDump = (code: string, receipt?: string) => {
    try {
      options.store.failDayDump(claimed.id, code, receipt);
    } catch (error) {
      console.error("Day dump failure receipt could not be saved.", error);
    }
  };

  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const baseUrl = (options.webBaseUrl ?? defaultBriefWebBase()).replace(/\/$/, "");
    const fetchTimeoutMs = options.dumpFetchTimeoutMs ?? 10_000;
    const commitmentRows = await fetchRows(
      fetchImpl,
      baseUrl,
      "commitments",
      fetchTimeoutMs,
      "select=*&status=eq.open&order=due_at.asc.nullslast",
    );
    const openCommitments = commitmentRows
      .map(dumpCommitmentRow)
      .filter((row): row is DumpExistingCommitment => Boolean(row));
    const plan = options.store.getPlanForDate(claimed.targetLocalDate);
    const planItems = (plan?.items ?? []).map((item) => ({ id: item.id, title: item.title }));
    const originalPrompt = buildDayDumpPrompt({
      rawDump: claimed.rawText,
      targetLocalDate: claimed.targetLocalDate,
      planItems,
      openCommitments,
    });
    const existingCommitmentIds = new Set(openCommitments.map((item) => item.id));
    const validateOutput = (raw: string) => validateDayDump(
      parseDayDumpOutput(raw),
      claimed.rawText,
      { existingCommitmentIds },
    );
    let writer = options.dumpWriter ?? configuredDayDumpWriter();
    let validated: ReturnType<typeof validateDayDump> | undefined;

    if (writer === "codex") {
      let prompt = originalPrompt;
      for (let attemptIndex = 0; attemptIndex < 2 && !validated; attemptIndex += 1) {
        const attempt = createCodexStructuredAttempt({
          prompt,
          executable: options.codexPath,
          tempPrefix: "forge-day-dump-",
        });
        if (!attempt) break;
        try {
          const result = await spawnCommand(attempt.command, {
            spawnImpl: options.spawnImpl ?? spawn,
            timeoutMs,
            maxStdoutBytes: 1024 * 1024,
            maxStderrBytes: 64 * 1024,
            terminationGraceMs: options.terminationGraceMs ?? 2000,
            abortSignal: options.abortSignal,
          });
          if (result.terminatedBy === "shutdown") {
            failDump("worker_interrupted");
            return true;
          }
          if (result.exitCode !== 0 || result.signal || result.terminatedBy || result.overflowed) {
            break;
          }
          try {
            validated = validateOutput(readCodexStructuredOutput(attempt));
          } catch (error) {
            if (attemptIndex === 0) prompt = correctionPrompt(originalPrompt, error);
          }
        } finally {
          attempt.cleanup();
        }
      }
      if (!validated) writer = "claude";
    }

    if (!validated) {
      let prompt = originalPrompt;
      for (let attemptIndex = 0; attemptIndex < 2 && !validated; attemptIndex += 1) {
        const command = buildDayDumpCommand({
          claudePath: options.claudePath,
          emptyMcpConfigPath: options.emptyMcpConfigPath,
          cwd: options.fallbackCwd,
          prompt,
          modelAlias: model.modelAlias,
          effort: model.effort,
          budgetUsd: model.budgetUsd,
        });
        const result = await spawnCommand(command, {
          spawnImpl: options.spawnImpl ?? spawn,
          timeoutMs,
          maxStdoutBytes: 1024 * 1024,
          maxStderrBytes: 64 * 1024,
          terminationGraceMs: options.terminationGraceMs ?? 2000,
          abortSignal: options.abortSignal,
        });
        if (result.terminatedBy || result.signal) {
          failDump(result.terminatedBy === "timeout" ? "dump_timeout" : "worker_interrupted");
          return true;
        }
        if (result.exitCode !== 0 || result.overflowed) {
          failDump(result.overflowed ? "dump_output_too_large" : "claude_failed");
          return true;
        }
        try {
          validated = validateOutput(result.stdout);
        } catch (error) {
          if (attemptIndex === 0) prompt = correctionPrompt(originalPrompt, error);
          else throw error;
        }
      }
    }

    if (!validated) {
      failDump("dump_validation_failed");
      return true;
    }

    const created: Array<{ id: string; title: string }> = [];
    const failed: Array<{ title: string; error: string }> = [];
    const resolved: Array<{ id: string; title: string }> = [];
    const updated: Array<{ id: string; title: string }> = [];
    const needsConfirmation: Array<{ id: string; title: string }> = [];
    const resolutionFailures: Array<{ id: string; error: string }> = [];
    let csrfToken: string | undefined;
    if (validated.items.length > 0 || validated.resolutions.length > 0) {
      try {
        csrfToken = await forgeCsrfToken(fetchImpl, baseUrl, fetchTimeoutMs);
      } catch (error) {
        const reason = (error instanceof Error ? error.message : "day_plan_token_failed")
          .replace(/\s+/g, " ")
          .slice(0, 160);
        failed.push(...validated.items.map((item) => ({ title: item.title, error: reason })));
        resolutionFailures.push(...validated.resolutions.map((item) => ({
          id: item.commitment_id,
          error: reason,
        })));
      }
    }
    if (validated.items.length > 0) {
      // Accepted tradeoff: inserts survive a crash before completeDayDump, then stale sweep fails the unreclaimed row with an under-reported receipt.
      for (const item of csrfToken ? validated.items : []) {
        const id = randomUUID();
        try {
          const response = await fetchImpl(`${baseUrl}/api/forge-rest/commitments`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Forge-CSRF": csrfToken!,
            },
            body: JSON.stringify({
              id,
              ...item,
              contact_id: null,
              source_kind: "brain_dump",
              source_ref: claimed.id,
              confirmed: false,
              evidence: null,
            }),
            signal: AbortSignal.timeout(fetchTimeoutMs),
            cache: "no-store",
          });
          if (!response.ok) throw new Error(`forge-rest commitments ${response.status}`);
          created.push({ id, title: item.title });
        } catch (error) {
          failed.push({
            title: item.title,
            error: (error instanceof Error ? error.message : "commitment_insert_failed")
              .replace(/\s+/g, " ")
              .slice(0, 160),
          });
        }
      }
    }

    const openById = new Map(openCommitments.map((item) => [item.id, item]));
    for (const resolution of csrfToken ? validated.resolutions : []) {
      const id = resolution.commitment_id;
      try {
        const rows = await fetchRows(
          fetchImpl,
          baseUrl,
          "commitments",
          fetchTimeoutMs,
          `select=id,title,evidence,status,due_at&id=eq.${encodeURIComponent(id)}`,
        );
        if (rows.length !== 1 || !rows[0] || typeof rows[0] !== "object" || Array.isArray(rows[0])) {
          throw new Error("commitment_resolution_row_missing");
        }
        const row = rows[0] as Record<string, unknown>;
        if (row.status !== "open") {
          throw new Error("commitment_resolution_not_open");
        }
        const title = typeof row.title === "string"
          ? row.title
          : openById.get(id)?.title ?? id;
        const evidence = {
          ...dumpEvidenceObject(row.evidence),
          ...dumpResolutionEvidence(resolution, claimed.id, clock().toISOString()),
        };
        const patch: Record<string, unknown> = { evidence: JSON.stringify(evidence) };
        if (resolution.confidence === "high" && resolution.action === "done") {
          patch.status = "done";
        } else if (
          resolution.confidence === "high" &&
          resolution.action === "update" &&
          resolution.due_at
        ) {
          patch.due_at = resolution.due_at;
        }
        const response = await fetchImpl(
          `${baseUrl}/api/forge-rest/commitments` +
            `?id=eq.${encodeURIComponent(id)}&status=eq.open&` +
            (row.evidence === null || row.evidence === undefined
              ? "evidence=is.null"
              : `evidence=eq.${encodeURIComponent(String(row.evidence))}`),
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              "X-Forge-CSRF": csrfToken!,
            },
            body: JSON.stringify(patch),
            signal: AbortSignal.timeout(fetchTimeoutMs),
            cache: "no-store",
          },
        );
        if (!response.ok) throw new Error(`forge-rest commitments ${response.status}`);
        const patchedRows = await response.json() as unknown;
        if (
          !Array.isArray(patchedRows) ||
          patchedRows.length !== 1 ||
          !patchedRows[0] ||
          typeof patchedRows[0] !== "object" ||
          Array.isArray(patchedRows[0])
        ) {
          throw new Error("commitment_resolution_no_longer_open");
        }
        if (resolution.confidence !== "high") {
          needsConfirmation.push({ id, title });
        } else if (resolution.action === "done") {
          resolved.push({ id, title });
        } else {
          updated.push({ id, title });
        }
      } catch (error) {
        resolutionFailures.push({
          id,
          error: (error instanceof Error ? error.message : "commitment_resolution_failed")
            .replace(/\s+/g, " ")
            .slice(0, 160),
        });
      }
    }

    const receipt = JSON.stringify({
      created,
      skipped_duplicates: validated.skipped_duplicates,
      failed,
      resolved,
      updated,
      needs_confirmation: needsConfirmation,
      resolution_failures: resolutionFailures,
      counts: {
        extracted: validated.items.length,
        created: created.length,
        skipped_duplicates: validated.skipped_duplicates.length,
        failed: failed.length,
        resolved: resolved.length,
        updated: updated.length,
        needs_confirmation: needsConfirmation.length,
      },
      nothing_found: validated.nothing_found,
      writer,
    });
    if (validated.items.length > 0 && created.length === 0) {
      failDump("commitment_insert_failed", receipt);
    } else {
      options.store.completeDayDump(claimed.id, receipt);
      // day_dumps is machine-private, and the morning brief runs on the Mini.
      // Publish the dump so tomorrow's brief can read what he actually said.
      writeDumpRelay({ store: options.store, now: clock(), dataDir: options.relay?.dataDir });
    }
  } catch (error) {
    failDump(error instanceof Error ? error.message : "dump_failed");
  }
  return true;
}

function isValidTimezone(zone: string | undefined): zone is string {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// The brief lane's target-date timezone. A validated COVE_BRIEF_TIMEZONE wins so
// the Mini (whose local day_plans is stale by design) targets the operator's real
// morning; otherwise the open plan's zone, then the latest settlement's, then
// the machine's, then UTC.
function resolveBriefTimezone(store: DayPlanStore): string {
  const readModel = store.getReadModel();
  const envZone = coveEnv("BRIEF_TIMEZONE");
  return (
    (isValidTimezone(envZone) ? envZone : undefined) ??
    readModel.currentPlan?.timezone ??
    readModel.latestSnapshot?.timezone ??
    Intl.DateTimeFormat().resolvedOptions().timeZone ??
    "UTC"
  );
}

function resolveBriefTargetDate(store: DayPlanStore, now: Date): string {
  try {
    return localDateInTimezone(now, resolveBriefTimezone(store));
  } catch {
    return localDateInTimezone(now, "UTC");
  }
}

export function relayCheckpointSources(
  relay: BriefRelayOptions,
): Record<string, CheckpointSourceSpec> {
  return briefCheckpointSources({
    dataDir: relay.dataDir,
    goalsPath: relay.goalsPath,
    operatorProfilePath: relay.operatorProfilePath,
    leadupPath: relay.leadupPath,
    sprintMemoPath: relay.sprintMemoPath,
  });
}

// The Morning Brief lane. It reuses the same bounded spawn machinery as the
// other lanes but drains through its own loop, so a brief can never starve
// behind a long execution run. Brief output carries contact names and drafts,
// so unlike executions it is never mirrored into an on-disk log.
export async function runOneMorningBrief(
  options: MorningBriefWorkerOptions,
): Promise<boolean> {
  const clock = options.now ?? (() => new Date());
  // The stale sweep must always outlast the configured run timeout, or a
  // long-budget brief could be marked interrupted while still running.
  const staleAfterMs = Math.max(
    20 * 60 * 1000,
    (options.briefTimeoutMs ?? morningBriefModelConfig().timeoutMs) + 5 * 60 * 1000,
  );
  options.store.interruptStaleMorningBriefs(cutoff(clock(), staleAfterMs));
  // Gating the enqueue is not enough on its own. A row queued while the relay
  // still said "closed" (or before any signal existed) can still be sitting in
  // the queue once the day goes unclosed, and draining it would write exactly
  // the blind brief the gate exists to prevent.
  //
  // Only the scheduled lane asks. The ritual machine's queue must always drain:
  // the brief it holds is the one settlement itself just requested, and gating
  // that would deadlock the morning, since closing the day is what would unblock
  // it. Leaving the row queued rather than failing it means the moment he does
  // close the day, this same loop writes the brief he was owed.
  if (options.relay?.requireSourceCheckpoint) {
    const gate = evaluateScheduledBriefGate({
      targetLocalDate: resolveBriefTargetDate(options.store, clock()),
      dataDir: options.relay.dataDir,
      now: clock(),
    });
    if (gate.blocked) return false;
  }
  const claimed = options.store.claimNextMorningBrief();
  if (!claimed) return false;
  const receiptStartedAt = claimed.startedAt ?? clock().toISOString();
  let receiptRecorded = false;
  const recordBriefReceipt = (
    outcome: ReceiptOutcome,
    summary: string,
    actions: Record<string, unknown>,
  ) => {
    if (!options.receiptDbPath || receiptRecorded) return;
    receiptRecorded = true;
    try {
      recordReceipt({
        dbPath: options.receiptDbPath,
        source: "morning-brief",
        startedAt: receiptStartedAt,
        summary,
        actions: { briefId: claimed.id, targetLocalDate: claimed.targetLocalDate, ...actions },
        outcome,
      });
    } catch (error) {
      console.error("Could not record morning brief receipt.", error);
    }
  };
  const targetTimezone = resolveBriefTimezone(options.store);
  const relay = options.relay;
  const relayHost = relay?.host ?? originHost();
  // Fail a brief and, when relaying, publish a failed status so the peer machine
  // stops waiting on this attempt.
  const failBrief = (code: string) => {
    options.store.failMorningBrief(claimed.id, code);
    recordBriefReceipt("failed", `Morning brief failed: ${code}`, { errorCode: code });
    if (relay) {
      writeBriefAttemptStatus(
        {
          targetLocalDate: claimed.targetLocalDate,
          attemptId: claimed.id,
          state: "failed",
          errorCode: code,
        },
        { dataDir: relay.dataDir, host: relayHost, now: clock() },
      );
    }
  };
  // A non-authoritative generator (the Mini) must not brief off synced source
  // copies the MBP has not vouched for. Gate before any expensive work.
  if (relay?.requireSourceCheckpoint) {
    const verdict = verifySourceCheckpoint({
      sources: relayCheckpointSources(relay),
      now: clock(),
      dataDir: relay.dataDir,
    });
    if (!verdict.ok) {
      failBrief(`source_checkpoint_${verdict.reason}`);
      return true;
    }
  }
  if (relay) {
    writeBriefAttemptStatus(
      {
        targetLocalDate: claimed.targetLocalDate,
        attemptId: claimed.id,
        state: "running",
        startedAt: claimed.startedAt ?? clock().toISOString(),
      },
      { dataDir: relay.dataDir, host: relayHost, now: clock() },
    );
  }
  try {
    const collect =
      options.collectBriefSources ??
      ((store: DayPlanStore) =>
        collectMorningBriefSources({
          store,
          targetLocalDate: claimed.targetLocalDate,
          targetTimezone,
          now: clock(),
          // Without this the collector falls back to the forge.db directory,
          // so on a relaying machine it reads a different settlement relay than
          // the one every other call in this function writes to.
          dataDir: relay?.dataDir,
        }));
    const collected = await collect(options.store);
    const context = assembleMorningBriefContext(collected.sources, {
      now: clock(),
    });
    if (context.missingRequired.length > 0) {
      failBrief(`required_source_missing:${context.missingRequired.join(",")}`);
      return true;
    }
    const preferredWriter = options.briefWriter ?? configuredMorningBriefWriter();
    // The hash covers the full generation envelope: the bounded sections
    // exactly as sent, target date and timezone, contract versions, model configuration,
    // and per-source freshness states.
    const inputs = options.store.recordMorningBriefInputs(claimed.id, {
      inputHash: morningBriefInputHash({
        targetLocalDate: claimed.targetLocalDate,
        targetTimezone,
        sections: context.sections,
        sourceFreshness: context.manifest.sources.map((source) => ({
          id: source.id,
          freshness: source.freshness,
        })),
        promptVersion: MORNING_BRIEF_PROMPT_VERSION,
        schemaVersion: MORNING_BRIEF_SCHEMA_VERSION,
        modelAlias: claimed.modelAlias,
        effort: claimed.effort,
        budgetUsd: claimed.budgetUsd,
        writer: preferredWriter,
      }),
      sourceManifest: context.manifest,
      promptVersion: MORNING_BRIEF_PROMPT_VERSION,
      schemaVersion: MORNING_BRIEF_SCHEMA_VERSION,
    });
    // Identical inputs already produced an artifact; nothing new to generate.
    if (inputs.duplicateOfId) {
      recordBriefReceipt("skipped", "Morning brief reused an identical result.", {
        duplicateOfId: inputs.duplicateOfId,
      });
      return true;
    }
    const promptInput = {
      targetLocalDate: claimed.targetLocalDate,
      targetTimezone,
      sections: context.sections,
      manifest: context.manifest,
    };
    const prompt = buildMorningBriefPrompt(promptInput);
    const sourceIds = new Set(
      context.manifest.sources
        .filter((source) => source.freshness !== "missing" && source.chars > 0)
        .map((source) => source.id),
    );
    const validateOutput = (raw: string) => validateMorningBrief(parseMorningBriefOutput(raw), {
      knownTaskIds: collected.knownTaskIds,
      // Bounded grounding: watch items and sales actions must cite sources the
      // model actually received bytes of (missing or fully-trimmed-out sources
      // cannot ground anything; citing them is fabrication by construction).
      sourceIds,
    });
    const timeoutMs = options.briefTimeoutMs ?? morningBriefModelConfig().timeoutMs;
    let writer: MorningBriefWriter = preferredWriter;
    let validated: ReturnType<typeof validateMorningBrief> | undefined;

    if (writer === "codex") {
      let codexPrompt = prompt;
      for (let attemptIndex = 0; attemptIndex < 2 && !validated; attemptIndex += 1) {
        const attempt = createCodexMorningBriefAttempt({
          prompt: codexPrompt,
          executable: options.codexPath,
        });
        if (!attempt) break;
        try {
          const result = await spawnCommand(attempt.command, {
            spawnImpl: options.spawnImpl ?? spawn,
            timeoutMs,
            maxStdoutBytes: 1024 * 1024,
            maxStderrBytes: 64 * 1024,
            terminationGraceMs: options.terminationGraceMs ?? 2000,
            abortSignal: options.abortSignal,
          });
          if (result.terminatedBy === "shutdown") {
            failBrief("worker_interrupted");
            return true;
          }
          if (result.exitCode !== 0 || result.signal || result.terminatedBy || result.overflowed) {
            break;
          }
          try {
            validated = validateOutput(readCodexMorningBriefOutput(attempt));
          } catch (error) {
            if (attemptIndex === 0) {
              const reason = (error instanceof Error ? error.message : "validation failed")
                .replace(/\s+/g, " ")
                .slice(0, 240);
              codexPrompt = `${prompt}\n\nYour previous output failed validation: ${reason}. Emit ONLY the JSON object.`;
            }
          }
        } finally {
          attempt.cleanup();
        }
      }
      if (!validated) writer = "claude";
    }

    if (!validated) {
      const command = buildMorningBriefCommand({
        claudePath: options.claudePath,
        emptyMcpConfigPath: options.emptyMcpConfigPath,
        cwd: options.fallbackCwd,
        ...promptInput,
        modelAlias: claimed.modelAlias,
        effort: claimed.effort,
        budgetUsd: claimed.budgetUsd,
      });
      const result = await spawnCommand(command, {
        spawnImpl: options.spawnImpl ?? spawn,
        timeoutMs,
        maxStdoutBytes: 1024 * 1024,
        maxStderrBytes: 64 * 1024,
        terminationGraceMs: options.terminationGraceMs ?? 2000,
        abortSignal: options.abortSignal,
      });
      if (result.terminatedBy || result.signal) {
        failBrief(result.terminatedBy === "timeout" ? "brief_timeout" : "worker_interrupted");
        return true;
      }
      if (result.exitCode !== 0 || result.overflowed) {
        failBrief(result.overflowed ? "brief_output_too_large" : "claude_failed");
        return true;
      }
      validated = validateOutput(result.stdout);
    }
    const dated = stripMorningBriefDateClaim(
      validated.brief,
      claimed.targetLocalDate,
      targetTimezone,
    );
    if (dated.contradicted) {
      console.warn("Morning brief narrative date contradicted target; corrected before storage.", {
        briefId: claimed.id,
        targetLocalDate: claimed.targetLocalDate,
        targetTimezone,
      });
    }
    const completed = options.store.completeMorningBrief(
      claimed.id,
      JSON.stringify({ ...dated.brief, writer }),
    );
    recordBriefReceipt("success", "Morning brief completed.", { writer });
    console.info("Morning brief generated.", { briefId: claimed.id, writer });
    // Publish the immutable artifact to the relay so the other machine imports
    // it. The authoritative machine (the MBP) also refreshes the settlement
    // summary and source checkpoint from its own state. All fail-open.
    if (relay && completed) {
      exportBriefArtifact(completed, { dataDir: relay.dataDir, host: relayHost });
      if (!relay.requireSourceCheckpoint) {
        writeSettlementRelay({ store: options.store, now: clock(), dataDir: relay.dataDir });
        writeDayClosureRelay({
          store: options.store,
          now: clock(),
          dataDir: relay.dataDir,
          host: relayHost,
        });
        writeSourceCheckpoint({
          sources: relayCheckpointSources(relay),
          now: clock(),
          dataDir: relay.dataDir,
        });
      }
    }
  } catch (error) {
    failBrief(error instanceof Error ? error.message : "brief_failed");
  }
  return true;
}

// Scheduled entry point (the ~7:30 local LaunchAgent run, which may fire late
// on wake). Targets today with a validated COVE_BRIEF_TIMEZONE first (so the
// Mini, whose local day_plans is stale by design, still targets the operator's real
// morning), then the open plan's zone, the latest settlement's, the machine's,
// and UTC. When relaying, it first imports any already-synced artifact and waits
// while another machine has a live generation for this date. Skips cleanly when
// an eligible artifact for today already exists.
export function enqueueDueMorningBrief(
  store: DayPlanStore,
  now: Date = new Date(),
  options: { relay?: BriefRelayOptions } = {},
): MorningBriefArtifact | undefined {
  const target = resolveBriefTargetDate(store, now);
  if (options.relay) {
    scanAndImportBriefRelay({
      store,
      targetLocalDate: target,
      dataDir: options.relay.dataDir,
    });
    const remote = liveRemoteBriefAttempt({
      targetLocalDate: target,
      selfHost: options.relay.host,
      dataDir: options.relay.dataDir,
      now,
    });
    // Backfill waits: a live generation on the other machine will sync its
    // artifact in; a second generation here would only race it.
    if (remote) return undefined;
  }
  if (store.latestEligibleMorningBrief(target)) return undefined;
  // The scheduled 7:30 generation is the one that caused the original bug: it
  // fired off the calendar alone, so on any morning the previous day was never
  // closed it wrote a brief that could not see that day at all and said so
  // nowhere. Now it simply does not run. The arrival already routes an unclosed
  // day into Settlement before it will plan today, and committing that
  // settlement enqueues the brief through the settlement trigger.
  //
  // This deliberately does NOT ask the local store: this lane runs on the Mini,
  // whose day_plans is stale by design, so a local answer would be about the
  // wrong machine. It reads the closure fact the ritual machine publishes, and
  // treats no signal as no opinion.
  const gate = evaluateScheduledBriefGate({
    targetLocalDate: target,
    dataDir: options.relay?.dataDir,
    now,
  });
  if (gate.blocked) {
    // The one place this decision is visible. Without it a missing brief looks
    // identical to a crashed worker.
    console.info("Morning brief held: the previous workday is still open.", {
      targetLocalDate: target,
      unclosedLocalDate: gate.unclosedLocalDate,
    });
    return undefined;
  }
  const enqueued = store.enqueueMorningBrief(target, morningBriefModelConfig());
  // Announce the queued attempt immediately (not first at claim), closing the
  // enqueue→claim window in which the peer could start a duplicate generation.
  if (options.relay && enqueued.created) {
    writeBriefAttemptStatus(
      { targetLocalDate: target, attemptId: enqueued.brief.id, state: "queued" },
      { dataDir: options.relay.dataDir, host: options.relay.host, now },
    );
  }
  return enqueued.brief;
}

export async function watchMorningBriefQueue(
  options: MorningBriefWorkerOptions,
  pollIntervalMs = 2000,
): Promise<void> {
  const clock = options.now ?? (() => new Date());
  const relay = options.relay;
  // Filenames already imported this process lifetime; a cheap readdir skip.
  const importedFiles = new Set<string>();
  // The authoritative machine republishes the checkpoint + settlement relay and
  // sweeps the outbox on this cadence, not every idle cycle: the poll runs every
  // couple of seconds, and rewriting synced files that often would churn
  // Syncthing and the disk for no benefit.
  const MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;
  let lastMaintenanceAt = 0;
  while (!options.abortSignal?.aborted) {
    if (relay) {
      // Pull in any synced artifact before this machine considers generating.
      scanAndImportBriefRelay({
        store: options.store,
        targetLocalDate: resolveBriefTargetDate(options.store, clock()),
        dataDir: relay.dataDir,
        imported: importedFiles,
      });
    }
    const processed = await runOneMorningBrief(options);
    if (!processed) {
      // Idle: on the authoritative machine, keep the relay fresh — re-export any
      // succeeded row whose file went missing, and republish the settlement
      // summary and source checkpoint. Throttled; all fail-open.
      const nowMs = clock().getTime();
      if (
        relay &&
        !relay.requireSourceCheckpoint &&
        nowMs - lastMaintenanceAt >= MAINTENANCE_INTERVAL_MS
      ) {
        lastMaintenanceAt = nowMs;
        sweepBriefRelayOutbox({
          store: options.store,
          now: clock(),
          dataDir: relay.dataDir,
          host: relay.host,
        });
        writeSettlementRelay({ store: options.store, now: clock(), dataDir: relay.dataDir });
        // The closure fact the peer's 7:30 cron gates on. This loop is the only
        // thing that keeps it current, so it publishes on the same cadence.
        writeDayClosureRelay({
          store: options.store,
          now: clock(),
          dataDir: relay.dataDir,
          host: relay.host,
        });
        writeSourceCheckpoint({
          sources: relayCheckpointSources(relay),
          now: clock(),
          dataDir: relay.dataDir,
        });
      }
      await waitForPoll(pollIntervalMs, options.abortSignal);
    }
  }
}

export async function drainDayDumpQueue(options: DayDumpWorkerOptions): Promise<number> {
  let processed = 0;
  while (!options.abortSignal?.aborted && await runOneDayDump(options)) {
    processed += 1;
  }
  return processed;
}

export async function watchDayDumpQueue(
  options: DayDumpWorkerOptions,
  pollIntervalMs = 2000,
): Promise<void> {
  while (!options.abortSignal?.aborted) {
    const processed = await runOneDayDump(options);
    if (!processed) await waitForPoll(pollIntervalMs, options.abortSignal);
  }
}

export async function processOneInboundEvent(
  candidate: InboundEvent,
  options: InboundWorkerOptions = {},
): Promise<boolean> {
  let event: InboundEvent | undefined;
  try {
    event = await getEvent(candidate.id);
    if (!event || !["pending", "failed"].includes(event.state)) return false;
    if (event.task_id) {
      await resolveEvent(event.id, {
        state: "triaged",
        taskId: event.task_id,
      }, { now: options.now });
      return true;
    }
    let smartTriaged = false;
    let smartTriageError: string | undefined;
    if (options.triageEvent) {
      try {
        smartTriaged = Boolean(
          await options.triageEvent(event, { taskId: event.id }),
        );
      } catch (error) {
        smartTriageError = (
          error instanceof Error ? error.message : "inbound_smart_triage_failed"
        ).replace(/\s+/g, " ").slice(0, 500);
        console.error("Inbound smart triage failed; using the fallback task.", error);
      }
    }
    const taskId = smartTriaged
      ? event.id
      : await createFallbackInboundTask(event, options);
    await resolveEvent(
      event.id,
      {
        state: "triaged",
        taskId,
        ...(smartTriageError ? { error: smartTriageError } : {}),
      },
      { now: options.now },
    );
  } catch (error) {
    if (!event) {
      console.error("Inbound event could not be re-read.", error);
      return false;
    }
    const reason = (error instanceof Error ? error.message : "inbound_triage_failed")
      .replace(/\s+/g, " ")
      .slice(0, 500);
    try {
      await resolveEvent(event.id, {
        state: event.attempts + 1 >= 5 ? "failed" : "pending",
        error: reason,
      }, { now: options.now });
    } catch (resolveError) {
      console.error("Inbound event failure could not be saved.", resolveError);
    }
    return false;
  }
  return true;
}

export async function runInboundSweep(
  options: InboundWorkerOptions = {},
): Promise<number> {
  const clock = options.now ?? (() => new Date());
  let processed = 0;
  try {
    const drained = await drainSpoolFiles(options.dataDir, { now: clock() });
    processed += drained.processed;
  } catch (error) {
    console.error("Inbound spool drain failed; continuing.", error);
  }
  let events: InboundEvent[];
  try {
    events = await listUnresolved({
      olderThanMinutes: 30,
      now: clock(),
    });
  } catch (error) {
    console.error("Inbound event sweep failed; continuing.", error);
    return processed;
  }
  for (const event of events) {
    if (options.abortSignal?.aborted) break;
    if (await processOneInboundEvent(event, options)) processed += 1;
  }
  return processed;
}

export async function watchInboundEvents(
  options: InboundWorkerOptions,
  pollIntervalMs = 2000,
): Promise<void> {
  while (!options.abortSignal?.aborted) {
    await runInboundSweep(options);
    await waitForPoll(pollIntervalMs, options.abortSignal);
  }
}

export async function drainClaudeQueues(options: ClaudeWorkerOptions): Promise<number> {
  let processed = 0;
  while (!options.abortSignal?.aborted) {
    const execution = await runOneExecution(options);
    if (execution) processed += 1;
    if (!execution) break;
  }
  return processed;
}

function waitForPoll(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function watchClaudeQueues(
  options: ClaudeWorkerOptions,
  pollIntervalMs = 1000,
): Promise<void> {
  while (!options.abortSignal?.aborted) {
    const processed = await drainClaudeQueues(options);
    if (!processed) await waitForPoll(pollIntervalMs, options.abortSignal);
  }
}
