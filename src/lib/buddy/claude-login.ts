import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { minimalChildEnvironment } from "../claude-execution/worker";
import { coveEnv } from "../env";

type SpawnImpl = typeof spawn;

export type ExecResult = { stdout: string; stderr: string };

/**
 * Runs a binary with argv and resolves with whatever it printed, even when it
 * exits non-zero. `claude auth status` exits 1 while signed out but still
 * prints the JSON we need, so a rejection would hide the answer.
 */
export type ExecImpl = (
  file: string,
  args: string[],
  options: { timeout: number; env: NodeJS.ProcessEnv },
) => Promise<ExecResult>;

export const CLAUDE_AUTH_STATUS_TIMEOUT_MS = 10_000;

export function resolveClaudeBinary(): string {
  return coveEnv("CLAUDE_BIN") ?? path.join(os.homedir(), ".local/bin/claude");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

/** The exact argv handed to osascript. Exported so tests can pin it. */
export function buildClaudeLoginCommand(claudePath = resolveClaudeBinary()) {
  const shellCommand = `${shellQuote(claudePath)} auth login`;
  return {
    executable: "/usr/bin/osascript",
    args: [
      "-e", 'tell application "Terminal" to activate',
      "-e", `tell application "Terminal" to do script ${appleScriptString(shellCommand)}`,
    ],
  };
}

/**
 * Opens a Terminal window running `claude auth login`. The login needs a real
 * TTY and a browser, so Cove cannot run it in the background the way it runs
 * Buddy turns. Resolves once osascript has started, not when the login ends.
 */
export function openClaudeLoginInTerminal(
  dependencies: { spawnImpl?: SpawnImpl; claudePath?: string; platform?: NodeJS.Platform } = {},
): { ok: true } | { ok: false; error: string } {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "darwin") {
    return { ok: false, error: "Opening Terminal for sign-in only works on a Mac." };
  }
  const command = buildClaudeLoginCommand(dependencies.claudePath);
  try {
    const child = (dependencies.spawnImpl ?? spawn)(command.executable, command.args, {
      detached: true,
      stdio: "ignore",
      env: minimalChildEnvironment(),
    });
    child.once("error", (error) => {
      console.error("Could not open Terminal for Claude sign-in.", error);
    });
    child.unref();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not open Terminal for Claude sign-in.",
    };
  }
}

/**
 * Reads `claude auth status --json` output defensively. Any truthy
 * loggedIn/signedIn/authenticated field, or status === "authenticated", counts
 * as signed in. Anything else, including unparseable text, counts as signed out.
 */
export function parseClaudeAuthStatus(raw: string): { signedIn: boolean; raw?: Record<string, unknown> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) return { signedIn: false };
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
      return { signedIn: false };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { signedIn: false };
  const status = parsed as Record<string, unknown>;
  const signedIn = Boolean(status.loggedIn) ||
    Boolean(status.signedIn) ||
    Boolean(status.authenticated) ||
    status.status === "authenticated";
  return { signedIn, raw: status };
}

const defaultExec: ExecImpl = (file, args, options) => new Promise((resolve) => {
  execFile(file, args, { ...options, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
    // A non-zero exit still carries the JSON we want, so it is not a failure here.
    void error;
    resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
  });
});

export async function probeClaudeAuthStatus(
  dependencies: { execImpl?: ExecImpl; claudePath?: string; timeoutMs?: number } = {},
): Promise<{ signedIn: boolean; raw?: Record<string, unknown> }> {
  try {
    const result = await (dependencies.execImpl ?? defaultExec)(
      dependencies.claudePath ?? resolveClaudeBinary(),
      ["auth", "status", "--json"],
      {
        timeout: dependencies.timeoutMs ?? CLAUDE_AUTH_STATUS_TIMEOUT_MS,
        env: minimalChildEnvironment(),
      },
    );
    return parseClaudeAuthStatus(result.stdout);
  } catch (error) {
    console.error("Could not check Claude sign-in status.", error);
    return { signedIn: false };
  }
}
