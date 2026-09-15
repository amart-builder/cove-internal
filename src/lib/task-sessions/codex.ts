import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { StringDecoder } from "node:string_decoder";
import { shellQuote } from "../agent-terminal";

/** Keep sessions in the desktop history, without modifying the personal config. */
export function taskCodexHome(_dataDir: string, env: NodeJS.ProcessEnv): string {
  const home = path.resolve(env.CODEX_HOME ?? path.join(env.HOME ?? os.homedir(), ".codex"));
  if (!existsSync(path.join(home, "auth.json"))) throw new Error("Codex needs you to sign in. Open Buddy and choose Sign in again.");
  return home;
}

export function buildCodexTaskCommand(input: {
  executable: string; home: string; cwd: string; outputDir: string; runId: string; projectDirectory?: string;
  model: string; effort: string; planning: boolean; prompt: string;
}) {
  return {
    executable: input.executable, cwd: input.cwd,
    env: { CODEX_HOME: input.home },
    args: ["exec", "--json", "--skip-git-repo-check", "--ignore-rules", "--ignore-user-config", "-C", input.cwd,
      "--sandbox", input.planning ? "read-only" : "workspace-write",
      "-c", 'approval_policy="on-request"',
      "-c", 'web_search="disabled"', "-c", "features.apps=false",
      "-c", "features.multi_agent=false", "-c", "sandbox_workspace_write.network_access=false",
      ...(input.planning || input.outputDir === input.cwd ? [] : ["--add-dir", input.outputDir]),
      ...(!input.planning && input.projectDirectory && input.projectDirectory !== input.cwd
        ? ["--add-dir", input.projectDirectory] : []),
      "-m", input.model, "-c", `model_reasoning_effort=${JSON.stringify(input.effort)}`,
      "--output-last-message", path.join(input.outputDir, `result-${input.runId}.txt`), "-"],
    stdin: input.prompt,
  };
}

export function codexTaskResumeCommand(input: {
  executable: string; home: string; cwd: string; sessionId: string;
  model: string; effort: string; planning: boolean; outputDir?: string; projectDirectory?: string;
}): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,120}$/.test(input.sessionId)) throw new Error("Invalid Codex session identifier.");
  const args = [input.executable, "resume", input.sessionId, "-C", input.cwd,
    "--sandbox", input.planning ? "read-only" : "workspace-write", "--ask-for-approval", "on-request", "-m", input.model,
    "-c", `model_reasoning_effort=${JSON.stringify(input.effort)}`,
    ...(!input.planning && input.outputDir && input.outputDir !== input.cwd ? ["--add-dir", input.outputDir] : []),
    ...(!input.planning && input.projectDirectory && input.projectDirectory !== input.cwd
      ? ["--add-dir", input.projectDirectory] : [])];
  return `CODEX_HOME=${shellQuote(input.home)} ${args.map(shellQuote).join(" ")}`;
}

/** Parse incrementally so a long run cannot push its final/session events out of a tail buffer. */
export function createCodexTaskParser(onSession: (id: string) => void) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let sessionId: string | undefined;
  let text: string | undefined;
  let completed = false;
  let error: string | undefined;
  function consume(line: string) {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (!event || typeof event !== "object" || Array.isArray(event)) return;
    if (event.type === "thread.started" && typeof event.thread_id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,120}$/.test(event.thread_id)) {
      sessionId = event.thread_id; onSession(event.thread_id);
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") text = event.item.text.slice(-64000);
    if (event.type === "turn.completed") completed = true;
    if (event.type === "turn.failed" || event.type === "error") error = String(event.error?.message ?? event.message ?? "Codex could not finish this task.").slice(0, 2000);
  }
  return {
    push(chunk: Buffer | string) {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? ""; lines.forEach(consume);
      if (buffer.length > 1024 * 1024) throw new Error("session_output_too_large");
    },
    finish() { consume(buffer + decoder.end()); return { sessionId, text, completed, error }; },
  };
}
