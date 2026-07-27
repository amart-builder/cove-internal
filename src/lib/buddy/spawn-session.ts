import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { BuddyStore } from "./store";
import { minimalChildEnvironment, signalProcessGroup } from "../claude-execution/worker";

type SpawnImpl = typeof spawn;

const BUDDY_SEED_SYSTEM_PROMPT = [
  "This session was started from Forge. Do not read files, use tools, edit anything, or begin the work. Reply with at most 2-3 short bullets outlining how you would approach the request, then STOP. The request below is context for the future desktop session.",
  "",
  "If a human resumes this session interactively, invoke the Skill tool with skill: orchestrator before continuing the task.",
].join("\n");

export function buildBuddySeedCommand(input: {
  sessionId: string;
  dir: string;
  prompt: string;
  title: string;
}) {
  return {
    executable: process.env.FORGE_CLAUDE_BIN ?? path.join(os.homedir(), ".local/bin/claude"),
    args: [
      "-p",
      "--session-id", input.sessionId,
      "--permission-mode", "plan",
      "--model", "claude-fable-5",
      "--effort", "high",
      "--output-format", "json",
      "--name", input.title,
      "--append-system-prompt", BUDDY_SEED_SYSTEM_PROMPT,
      "--max-budget-usd", "1.00",
      "--disable-slash-commands",
    ],
    cwd: input.dir,
    stdin: `# ${input.title.replace(/\s+/g, " ").trim()}\n\n${input.prompt}`,
  };
}

export function seedBuddySession(input: {
  store: BuddyStore;
  sessionId: string;
  dir: string;
  prompt: string;
  title: string;
  spawnImpl?: SpawnImpl;
  timeoutMs?: number;
  terminationGraceMs?: number;
}): void {
  const command = buildBuddySeedCommand(input);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = (input.spawnImpl ?? spawn)(command.executable, command.args, {
      cwd: command.cwd,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: minimalChildEnvironment(),
    }) as ChildProcessWithoutNullStreams;
  } catch (error) {
    input.store.finishSpawnedSession(input.sessionId, {
      state: "launch_failed",
      error: error instanceof Error ? error.message : "Could not start Claude.",
    });
    return;
  }

  const launched = typeof child.pid === "number";
  if (launched) {
    input.store.finishSpawnedSession(input.sessionId, { state: "started" });
  }

  let settled = false;
  let timedOut = false;
  let stderr = "";
  let killTimer: NodeJS.Timeout | undefined;
  const finish = (state: "ready" | "incomplete" | "launch_failed", error?: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (killTimer) clearTimeout(killTimer);
    input.store.finishSpawnedSession(input.sessionId, { state, error });
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    signalProcessGroup(child, "SIGTERM");
    killTimer = setTimeout(
      () => signalProcessGroup(child, "SIGKILL"),
      input.terminationGraceMs ?? 2_000,
    );
    killTimer.unref();
  }, input.timeoutMs ?? 5 * 60_000);
  timeout.unref();

  child.stdout.resume();
  child.stderr.on("data", (chunk: Buffer | string) => {
    if (stderr.length < 2_000) stderr += chunk.toString().slice(0, 2_000 - stderr.length);
  });
  child.once("error", (error) => finish(launched ? "incomplete" : "launch_failed", error.message));
  child.once("close", (code) => {
    if (code === 0 && !timedOut) finish("ready");
    else finish(
      launched ? "incomplete" : "launch_failed",
      timedOut ? "Seed session timed out." : stderr.trim() || `Claude exited ${code ?? "unknown"}.`,
    );
  });
  child.stdin.once("error", (error) => {
    signalProcessGroup(child, "SIGTERM");
    finish(launched ? "incomplete" : "launch_failed", error.message);
  });
  child.stdin.end(command.stdin);
  child.unref();
}
