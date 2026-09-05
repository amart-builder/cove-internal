import type { readAgentSettings } from "./agent-settings.mjs";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { runJob as runRuntimeJob } from "./model-runner-runtime.mjs";

export type ModelRunnerFailureCode =
  | "codex_unavailable"
  | "codex_timeout"
  | "codex_invalid_output"
  | "runner_interrupted"
  | "runner_output_too_large"
  | "runner_timeout"
  | "runner_failed"
  | "runner_budget_exceeded";

export type ModelRunnerBackend = "codex-sol-high" | "claude";

export type RunJobRuntimeInput = {
  lane: string;
  agentSettings?: NonNullable<ReturnType<typeof readAgentSettings>>;
  kind: "structured" | "text";
  prompt: string;
  schema?: Record<string, unknown>;
  timeoutMs?: number;
  backend?: ModelRunnerBackend;
  codexPath?: string;
  claudePath?: string;
  env?: NodeJS.ProcessEnv;
  spawnImpl?: typeof spawn;
  abortSignal?: AbortSignal;
  terminationGraceMs?: number;
  webSearch?: boolean;
  cwd?: string;
  claudeTools?: string;
  claudeMcpConfigPath?: string;
  claudeSettingsPath?: string;
  claudeNoChrome?: boolean;
  claudeDisableSlashCommands?: boolean;
  claudeMaxBudgetUsd?: string;
  validate?: (text: string, value: unknown) => unknown | Promise<unknown>;
  onSpawn?: (
    child: ChildProcessWithoutNullStreams,
    command: { executable: string; cwd: string; args: string[]; stdin: string },
  ) => void;
  onSettled?: () => void;
};

export type RunJobInput = Omit<RunJobRuntimeInput, "kind"> & (
  | { kind: "text"; schema?: never }
  | { kind: "structured"; schema: Record<string, unknown> }
);

export type RunJobResult<T = unknown> =
  | { ok: true; lane: string; backend: ModelRunnerBackend; text: string; value?: T }
  | { ok: false; error: { code: ModelRunnerFailureCode; lane: string; message: string } };

export async function runJob<T = unknown>(input: RunJobInput): Promise<RunJobResult<T>> {
  return runRuntimeJob(input) as Promise<RunJobResult<T>>;
}
