import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { minimalChildEnvironment, signalProcessGroup } from "../claude-execution/worker";
import type { ClaudeCommand } from "../claude-execution/commands";
import {
  parseBuddyDataToolOutput,
  type ReceiptChange,
  type SpawnedSessionReceipt,
} from "./receipts";
import {
  BUDDY_COMMAND_TERMINATION_GRACE_MS,
  BUDDY_COMMAND_TIMEOUT_MS,
} from "./timing";
import type { BuddyStore } from "./store";

type ActiveBuddyTurn = {
  store: Pick<BuddyStore, "finishTurn">;
  turnId: string;
  child?: ChildProcessWithoutNullStreams;
};

type BuddyProcessGlobal = {
  __forgeActiveBuddyTurn?: ActiveBuddyTurn;
  __forgeBuddyShutdownHandlersRegistered?: boolean;
};

function buddyProcessGlobal(): BuddyProcessGlobal {
  return globalThis as unknown as BuddyProcessGlobal;
}

function stopActiveBuddyTurn(): void {
  const active = buddyProcessGlobal().__forgeActiveBuddyTurn;
  if (!active) return;
  if (active.child) signalProcessGroup(active.child, "SIGTERM");
  try {
    active.store.finishTurn(active.turnId, {
      state: "failed",
      assistant_text: "",
      error_code: "server_restart",
    });
  } catch {
    // Process shutdown is best-effort; never prevent the server from exiting.
  }
  buddyProcessGlobal().__forgeActiveBuddyTurn = undefined;
}

function ensureBuddyShutdownHandlers(): void {
  const global = buddyProcessGlobal();
  if (global.__forgeBuddyShutdownHandlersRegistered) return;
  global.__forgeBuddyShutdownHandlersRegistered = true;
  process.once("SIGTERM", () => {
    stopActiveBuddyTurn();
    process.exit(143);
  });
  process.once("SIGINT", () => {
    stopActiveBuddyTurn();
    process.exit(130);
  });
  process.once("exit", stopActiveBuddyTurn);
}

export function registerActiveBuddyTurn(
  store: Pick<BuddyStore, "finishTurn">,
  turnId: string,
): () => void {
  ensureBuddyShutdownHandlers();
  const active = { store, turnId };
  buddyProcessGlobal().__forgeActiveBuddyTurn = active;
  return () => {
    if (buddyProcessGlobal().__forgeActiveBuddyTurn === active) {
      buddyProcessGlobal().__forgeActiveBuddyTurn = undefined;
    }
  };
}

function registerActiveBuddyChild(child: ChildProcessWithoutNullStreams): () => void {
  const active = buddyProcessGlobal().__forgeActiveBuddyTurn;
  if (!active) return () => {};
  active.child = child;
  return () => {
    if (active.child === child) active.child = undefined;
  };
}

export type BuddyStreamEvent =
  | { kind: "started"; sessionId: string }
  | { kind: "delta"; text: string }
  | { kind: "thinking" }
  | { kind: "tool"; name: string; inputSummary: string }
  | {
      kind: "data-result";
      changes: ReceiptChange[];
      sessions: SpawnedSessionReceipt[];
      errors: string[];
    }
  | {
      kind: "done";
      resultText: string;
      sessionId: string;
      costUsd: number;
      isError: boolean;
      errorSubtype?: string;
    };

export function isBuddyContextOverflow(
  done: BuddyStreamEvent & { kind: "done" },
): boolean {
  if (!done.isError) return false;
  const subtype = done.errorSubtype?.toLowerCase().replace(/[^a-z0-9]+/g, "_") ?? "";
  if ([
    "context_length_exceeded",
    "context_window_exceeded",
    "max_context_length",
    "prompt_too_long",
  ].some((value) => subtype.includes(value))) return true;
  return /context (?:length|window|limit)|maximum context|prompt (?:is )?too long|too many (?:input )?tokens|input length/i
    .test(done.resultText);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function summarizeInput(value: unknown): string {
  const input = record(value);
  if (!input) return "";
  const preferred = ["command", "file_path", "path", "pattern", "query"]
    .map((key) => input[key])
    .find((candidate) => typeof candidate === "string") as string | undefined;
  if (preferred) return preferred.replace(/\s+/g, " ").slice(0, 100);
  return JSON.stringify(input).replace(/\s+/g, " ").slice(0, 100);
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    const block = record(item);
    return block?.type === "text" && typeof block.text === "string" ? block.text : "";
  }).filter(Boolean).join("\n");
}

export function createBuddyEventParser() {
  const seenTools = new Set<string>();
  const buddyDataTools = new Set<string>();
  const seenToolResults = new Set<string>();
  return (line: string): BuddyStreamEvent[] => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return [];
    }
    const event = record(value);
    if (!event || typeof event.type !== "string") return [];

    if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
      return [{ kind: "started", sessionId: event.session_id }];
    }
    if (event.type === "stream_event") {
      const inner = record(event.event);
      const delta = inner?.type === "content_block_delta" ? record(inner.delta) : undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        return [{ kind: "delta", text: delta.text }];
      }
      if (delta?.type === "thinking_delta") return [{ kind: "thinking" }];
      return [];
    }
    if (event.type === "assistant") {
      const message = record(event.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      const tools: BuddyStreamEvent[] = [];
      for (const rawBlock of content) {
        const block = record(rawBlock);
        if (block?.type !== "tool_use" || typeof block.name !== "string") continue;
        const key = typeof block.id === "string" ? block.id : `${block.name}:${JSON.stringify(block.input)}`;
        const input = record(block.input);
        if (block.name === "Bash" && typeof input?.command === "string" &&
          input.command.includes("forge-buddy-data.ts") && typeof block.id === "string") {
          buddyDataTools.add(block.id);
        }
        if (seenTools.has(key)) continue;
        seenTools.add(key);
        tools.push({ kind: "tool", name: block.name, inputSummary: summarizeInput(block.input) });
      }
      return tools;
    }
    if (event.type === "user") {
      const message = record(event.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      const results: BuddyStreamEvent[] = [];
      for (const rawBlock of content) {
        const block = record(rawBlock);
        if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string" ||
          !buddyDataTools.has(block.tool_use_id) || seenToolResults.has(block.tool_use_id)) continue;
        seenToolResults.add(block.tool_use_id);
        const parsed = parseBuddyDataToolOutput(resultText(block.content));
        if (parsed.changes.length || parsed.sessions.length || parsed.errors.length) {
          results.push({ kind: "data-result", ...parsed });
        }
      }
      return results;
    }
    if (event.type === "result" && typeof event.session_id === "string") {
      return [{
        kind: "done",
        resultText: typeof event.result === "string" ? event.result : "",
        sessionId: event.session_id,
        costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : 0,
        isError: event.is_error === true,
        ...(typeof event.subtype === "string" && event.subtype !== "success"
          ? { errorSubtype: event.subtype }
          : {}),
      }];
    }
    return [];
  };
}

export async function runBuddyCommand(
  command: ClaudeCommand,
  onEvent: (event: BuddyStreamEvent) => void,
  options: { timeoutMs?: number; terminationGraceMs?: number; env?: Record<string, string | undefined> } = {},
): Promise<BuddyStreamEvent & { kind: "done" }> {
  const timeoutMs = options.timeoutMs ?? BUDDY_COMMAND_TIMEOUT_MS;
  const graceMs = options.terminationGraceMs ?? BUDDY_COMMAND_TERMINATION_GRACE_MS;
  const parse = createBuddyEventParser();

  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command.executable, command.args, {
        cwd: command.cwd,
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...minimalChildEnvironment(), ...options.env },
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      reject(error);
      return;
    }
    const clearActiveChild = registerActiveBuddyChild(child);
    let buffer = "";
    const stdoutDecoder = new StringDecoder("utf8");
    let stderr = "";
    let done: BuddyStreamEvent & { kind: "done" } | undefined;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      signalProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => signalProcessGroup(child, "SIGKILL"), graceMs);
      killTimer.unref();
    }, timeoutMs);
    timeout.unref();

    const consume = (line: string) => {
      if (!line.trim()) return;
      for (const mapped of parse(line)) {
        onEvent(mapped);
        if (mapped.kind === "done") done = mapped;
      }
    };
    child.stdout.on("data", (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : stdoutDecoder.write(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      lines.forEach(consume);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 16_000) stderr += chunk.toString().slice(0, 16_000 - stderr.length);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      clearActiveChild();
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      clearActiveChild();
      buffer += stdoutDecoder.end();
      consume(buffer);
      if (done) resolve(done);
      else reject(new Error(timedOut ? "timeout" : `missing_result:${code ?? "unknown"}:${stderr.trim()}`));
    });
    child.stdin.end(command.stdin);
  });
}
