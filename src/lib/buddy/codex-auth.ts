import { execFile } from "node:child_process";
import { coveEnv } from "../env";
import { openAgentTerminal, shellQuote } from "../agent-terminal";

export function codexLoginCommand(env: NodeJS.ProcessEnv = process.env): string {
  const prefix = env.CODEX_HOME ? `CODEX_HOME=${shellQuote(env.CODEX_HOME)} ` : "";
  return `${prefix}${shellQuote(coveEnv("CODEX_BIN", env) ?? "codex")} login`;
}

export function openCodexLogin(): Promise<void> {
  return openAgentTerminal(codexLoginCommand());
}

export function probeCodexAuthStatus(env: NodeJS.ProcessEnv = process.env): Promise<{ signedIn: boolean }> {
  return new Promise(resolve => {
    execFile(coveEnv("CODEX_BIN", env) ?? "codex", ["login", "status"], {
      timeout: 10000, maxBuffer: 64000, encoding: "utf8",
      env: { HOME: env.HOME, PATH: env.PATH, TMPDIR: env.TMPDIR, CODEX_HOME: env.CODEX_HOME, NODE_ENV: env.NODE_ENV ?? "production" },
    }, (error, stdout, stderr) => resolve({ signedIn: !error && /logged in/i.test(`${stdout}\n${stderr}`) && !/not logged in/i.test(`${stdout}\n${stderr}`) }));
  });
}
