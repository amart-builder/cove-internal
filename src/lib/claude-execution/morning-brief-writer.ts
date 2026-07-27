import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { ClaudeCommand } from "./commands";

export type MorningBriefWriter = "codex" | "claude";

export function configuredMorningBriefWriter(
  env: NodeJS.ProcessEnv = process.env,
): MorningBriefWriter {
  return env.FORGE_BRIEF_WRITER?.trim().toLowerCase() === "claude" ? "claude" : "codex";
}

export function resolveCodexBinary(options: {
  env?: NodeJS.ProcessEnv;
  exists?: (candidate: string) => boolean;
  home?: string;
} = {}): string | undefined {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const configured = env.FORGE_CODEX_BIN?.trim();
  if (configured) {
    return configured.includes(path.sep) && !exists(configured) ? undefined : configured;
  }

  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, "codex");
    if (exists(candidate)) return candidate;
  }
  for (const candidate of [
    path.join(options.home ?? homedir(), ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
  ]) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

export type CodexStructuredAttempt = {
  command: ClaudeCommand;
  outputPath: string;
  cleanup: () => void;
};

export function createCodexStructuredAttempt(input: {
  prompt: string;
  executable?: string;
  env?: NodeJS.ProcessEnv;
  tempPrefix?: string;
}): CodexStructuredAttempt | undefined {
  const executable = input.executable ?? resolveCodexBinary({ env: input.env });
  if (!executable) return undefined;
  const cwd = mkdtempSync(path.join(tmpdir(), input.tempPrefix ?? "forge-morning-brief-"));
  chmodSync(cwd, 0o700);
  const outputPath = path.join(cwd, "last-message.json");
  return {
    command: {
      executable,
      cwd,
      args: [
        "exec",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "-m",
        "gpt-5.6-sol",
        "-c",
        "model_reasoning_effort=high",
        "--output-last-message",
        outputPath,
        "-",
      ],
      stdin: input.prompt,
    },
    outputPath,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

export function readCodexStructuredOutput(attempt: CodexStructuredAttempt): string {
  if (statSync(attempt.outputPath).size > 1024 * 1024) {
    throw new Error("brief_output_too_large");
  }
  return readFileSync(attempt.outputPath, "utf8");
}

// Backward-compatible names keep the established Morning Brief call sites and
// tests readable while the dump lane shares the same hardened runner.
export type CodexMorningBriefAttempt = CodexStructuredAttempt;
export const createCodexMorningBriefAttempt = createCodexStructuredAttempt;
export const readCodexMorningBriefOutput = readCodexStructuredOutput;
