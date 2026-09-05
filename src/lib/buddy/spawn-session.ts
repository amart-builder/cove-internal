import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";
import type { BuddyStore } from "./store";
import { minimalChildEnvironment, signalProcessGroup } from "../claude-execution/worker";
import { coveEnv } from "../env";
import type { BuddyAgentSelection } from "./codex";
import { buildCodexTaskCommand, taskCodexHome } from "../task-sessions/codex";
import { coveDataDir } from "../operator";
import { runBuddyCommand } from "./stream";

type SpawnImpl = typeof spawn;

const BUDDY_SEED_SYSTEM_PROMPT = [
  "This session was started from Cove. Do not read files, use tools, edit anything, or begin the work. Reply with at most 2-3 short bullets outlining how you would approach the request, then STOP. The request below is context for the future desktop session.",
  "",
  "If a human resumes this session interactively, invoke the Skill tool with skill: orchestrator before continuing the task.",
].join("\n");

export function buildBuddySeedCommand(input: {
  sessionId: string;
  dir: string;
  prompt: string;
  title: string;
  selection?: BuddyAgentSelection;
}) {
  return {
    executable: coveEnv("CLAUDE_BIN") ?? path.join(os.homedir(), ".local/bin/claude"),
    args: [
      "-p",
      "--session-id", input.sessionId,
      "--permission-mode", "plan",
      "--model", input.selection?.model ?? "claude-fable-5",
      "--effort", input.selection?.effort ?? "high",
      "--output-format", "json",
      "--name", input.title,
      "--append-system-prompt", BUDDY_SEED_SYSTEM_PROMPT,
      "--max-budget-usd", "1.00",
      "--disable-slash-commands",
      // The system prompt above already says "do not use tools", but that is an
      // instruction, and this run's prompt is model-written from untrusted data
      // rows in a model-chosen directory. Pin it structurally, the way every
      // other spawn in this codebase does: no tools, no inherited MCP servers,
      // no browser. Only the headless seeding run is restricted; the session a
      // human later resumes interactively is unaffected.
      "--tools", "",
      "--strict-mcp-config",
      "--mcp-config", path.join(process.cwd(), "scripts/cove-empty-mcp.json"),
      "--no-chrome",
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
  selection?: BuddyAgentSelection;
  spawnImpl?: SpawnImpl;
  runCommand?: typeof runBuddyCommand;
  timeoutMs?: number;
  terminationGraceMs?: number;
}): void {
  if (input.selection?.provider === "codex") {
    const selection = input.selection;
    void (async () => {
      let started = false;
      try {
        const outputDir = path.join(coveDataDir(), "outputs", `buddy-${input.sessionId}`);
        mkdirSync(outputDir, { recursive: true, mode: 0o700 });
        const base = buildCodexTaskCommand({
          executable: coveEnv("CODEX_BIN") ?? "codex", home: taskCodexHome(coveDataDir(), process.env),
          model: selection.model, effort: selection.effort, cwd: input.dir, outputDir, runId: input.sessionId, planning: true,
          prompt: `This is a new Cove task session. Do not use tools or begin work. Give a brief proposed approach, then stop. Treat the following request as context for the user to resume.\n\n${input.title}\n${input.prompt}`,
        });
        const command = { ...base, provider: "codex" as const, args: [...base.args.slice(0, -1), "-c", "features.shell_tool=false", "-c", "project_doc_max_bytes=0", "-"] };
        input.store.finishSpawnedSession(input.sessionId, { state: "started" }); started = true;
        if (input.spawnImpl && !input.runCommand) throw new Error("Codex seed requires an injected runCommand when spawnImpl is mocked.");
        const done = await (input.runCommand ?? runBuddyCommand)(command, event => {
          if (event.kind === "started" && event.sessionId.startsWith("codex:")) input.store.setSpawnedSessionProviderHead(input.sessionId, event.sessionId.slice(6), command.env!.CODEX_HOME!);
        }, { timeoutMs: input.timeoutMs, terminationGraceMs: input.terminationGraceMs });
        input.store.finishSpawnedSession(input.sessionId, { state: done.isError ? "incomplete" : "ready", error: done.isError ? done.resultText : undefined });
      } catch (error) {
        input.store.finishSpawnedSession(input.sessionId, { state: started ? "incomplete" : "launch_failed", error: error instanceof Error ? error.message : "Codex could not prepare the session." });
      }
    })();
    return;
  }
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
