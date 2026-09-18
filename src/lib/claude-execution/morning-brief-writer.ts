import type { ClaudeCommand } from "./commands";
import {
  configuredJobBackend,
  createCodexJobAttempt,
  readCodexJobOutput,
} from "../model-runner-runtime.mjs";

export { resolveCodexBinary } from "../model-runner-runtime.mjs";

export type MorningBriefWriter = "codex" | "claude";

export function configuredMorningBriefWriter(
  env: NodeJS.ProcessEnv = process.env,
): MorningBriefWriter {
  return configuredJobBackend(env, "BRIEF_WRITER") === "claude" ? "claude" : "codex";
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
  codexConfigProbe?: typeof import("node:child_process").spawnSync;
}): CodexStructuredAttempt | undefined {
  return createCodexJobAttempt({
    prompt: input.prompt,
    executable: input.executable,
    env: input.env,
    codexConfigProbe: input.codexConfigProbe,
    tempPrefix: input.tempPrefix ?? "cove-morning-brief-",
  }) as CodexStructuredAttempt | undefined;
}

export function readCodexStructuredOutput(attempt: CodexStructuredAttempt): string {
  try {
    return readCodexJobOutput(attempt);
  } catch (error) {
    if (error instanceof Error && error.message === "model_output_too_large") {
      throw new Error("brief_output_too_large");
    }
    throw error;
  }
}

// Backward-compatible names keep the established Morning Brief call sites and
// tests readable while the dump lane shares the same hardened runner.
export type CodexMorningBriefAttempt = CodexStructuredAttempt;
export const createCodexMorningBriefAttempt = createCodexStructuredAttempt;
export const readCodexMorningBriefOutput = readCodexStructuredOutput;
