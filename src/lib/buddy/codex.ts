import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { ClaudeCommand } from "../claude-execution/commands";
import { coveDataDir } from "../operator";
import { coveEnv } from "../env";
import { BUDDY_DATA_ENV_KEYS, buddyDataEnvironment } from "./environment";

export type BuddyAgentSelection = {
  provider: "claude" | "codex";
  model: string;
  effort: "low" | "medium" | "high";
};

export class BuddyCodexSetupError extends Error {
  readonly code = "codex_setup_required";
}

export function buddyProviderHead(head: string | null, provider: "claude" | "codex"): string | null {
  if (!head) return null;
  return provider === "codex" ? (head.startsWith("codex:") ? head.slice(6) : null)
    : (head.startsWith("codex:") ? null : head);
}

/** Deliberately separate from the background runner whose isolation is deferred. */
export function ensureBuddyCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = path.join(coveDataDir(undefined, env), "buddy-codex-home");
  const sourceAuth = path.resolve(env.CODEX_HOME ?? path.join(env.HOME ?? os.homedir(), ".codex"), "auth.json");
  const auth = path.join(home, "auth.json");
  if (path.resolve(auth) === sourceAuth || !existsSync(sourceAuth)) {
    throw new BuddyCodexSetupError("Codex needs you to sign in. Run codex login on this Mac, then retry your message.");
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    if (!lstatSync(auth).isSymbolicLink() || path.resolve(home, readlinkSync(auth)) !== sourceAuth) {
      throw new BuddyCodexSetupError("Buddy's Codex sign-in source has changed. Ask your setup agent to check the Cove installation before retrying.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    symlinkSync(sourceAuth, auth);
  }
  const config = [
    'approval_policy = "on-request"', 'approvals_reviewer = "auto_review"',
    'sandbox_mode = "read-only"', 'web_search = "disabled"',
    '[features]', 'shell_tool = false', 'apps = false', 'multi_agent = false',
    '[mcp_servers.cove_buddy]',
    `command = ${JSON.stringify(process.execPath)}`,
    `args = ${JSON.stringify(["--import", path.join(process.cwd(), "node_modules/tsx/dist/loader.mjs"), path.join(process.cwd(), "scripts/cove-buddy-mcp.ts")])}`,
    `cwd = ${JSON.stringify(process.cwd())}`,
    `env_vars = ${JSON.stringify(BUDDY_DATA_ENV_KEYS)}`,
    'enabled_tools = ["cove_data"]', 'required = true', 'tool_timeout_sec = 60',
    'default_tools_approval_mode = "auto"', '',
  ].join("\n");
  const configPath = path.join(home, "config.toml");
  let current = "";
  try { current = readFileSync(configPath, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (current !== config) {
    const temporary = `${configPath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, config, { mode: 0o600 });
    renameSync(temporary, configPath);
  }
  return home;
}

export function buildCodexBuddyCommand(input: {
  selection: BuddyAgentSelection;
  headSessionId?: string | null;
  cwd: string;
  prompt: string;
  instructions?: string;
  schema?: string;
  noTools?: boolean;
  env?: NodeJS.ProcessEnv;
}): ClaudeCommand {
  const env = input.env ?? process.env;
  const home = ensureBuddyCodexHome(env);
  const head = buddyProviderHead(input.headSessionId ?? null, "codex");
  let schemaPath: string | undefined;
  if (input.schema) {
    schemaPath = path.join(home, "replan-schema.json");
    writeFileSync(schemaPath, input.schema, { mode: 0o600 });
  }
  return {
    provider: "codex",
    executable: coveEnv("CODEX_BIN", env) ?? "codex",
    cwd: input.cwd,
    env: {
      ...buddyDataEnvironment(process.cwd(), env),
      CODEX_HOME: home,
    },
    args: [
      "exec", "-C", input.cwd, "--skip-git-repo-check", "--ignore-rules", "--json",
      "--sandbox", "read-only", "-m", input.selection.model,
      "-c", "project_doc_max_bytes=0",
      "-c", `model_reasoning_effort=${JSON.stringify(input.selection.effort)}`,
      ...(schemaPath ? ["--output-schema", schemaPath] : []),
      ...(schemaPath || input.noTools ? ["-c", "mcp_servers.cove_buddy.enabled=false"] : []),
      ...(head ? ["resume", head, "-"] : ["-"]),
    ],
    stdin: [input.instructions, input.prompt].filter(Boolean).join("\n\n"),
  };
}
