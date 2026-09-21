#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentSettingsPath, readAgentSettings, RECOMMENDED_AGENTS, validateAgentSettings, connectedAgents, saveAgentSettings, setPrimaryAgent } from "../src/lib/agent-settings.mjs";
import { readBackgroundUsage } from "../src/lib/background-usage.mjs";
import { loadLocalEnv } from "./lib/load-local-env.mjs";
import { runJob } from "../src/lib/model-runner-runtime.mjs";

const CLI_NAMES = { claude: "Claude CLI", codex: "Codex CLI" };

// A CLI that is not installed yet arrives here as a raw spawn failure --
// "spawn /Users/someone/.local/bin/claude ENOENT" -- at the one step of setup
// where not having installed it is the expected state. SETUP.md calls a failed
// access check a real blocker, so the sentence it prints has to say which thing
// is missing. Every other failure keeps the runner's own words: those name a
// cause, and a lapsed sign-in must not be reported as a missing program.
export function accessCheckDetail(provider, error) {
  const message = typeof error?.message === "string" ? error.message : String(error ?? "");
  const missing = /^spawn (.+) ENOENT$/.exec(message);
  if (!missing) return message;
  return `${CLI_NAMES[provider] ?? provider} is not installed at ${missing[1]}. Install it and sign in, then run this command again.`;
}

export async function configureAgent({ provider, model, effort, makePrimary = true, env = process.env, runner = runJob }) {
  const recommendation = RECOMMENDED_AGENTS[provider];
  if (!recommendation) throw new Error("Choose --provider claude or --provider codex.");
  const file = agentSettingsPath(env);
  let original;
  try { original = readFileSync(file, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const current = readAgentSettings(env);
  if (!makePrimary && !current) throw new Error("Choose a primary provider before connecting another.");
  const selection = validateAgentSettings({ version: 1, provider,
    model: model ?? connectedAgents(current)[provider]?.model ?? recommendation.model, effort: effort ?? connectedAgents(current)[provider]?.effort ?? recommendation.effort,
    ...(current ? { backgroundLimits: current.backgroundLimits } : {}),
  });
  // Preflight uses a temporary desk, never the person's tasks or email.
  const temporary = mkdtempSync(path.join(os.tmpdir(), "cove-agent-preflight-"));
  try {
    const result = await runner({ lane: "setup-check", kind: "structured", prompt: 'Return {"ready":true}. Do not use tools.',
      schema: { type: "object", properties: { ready: { const: true, type: "boolean" } }, required: ["ready"], additionalProperties: false },
      agentSettings: selection, env: { ...env, COVE_DATA_DIR: temporary, COVE_DB_PATH: path.join(temporary, "cove.db") },
      claudeTools: "", claudeNoChrome: true, claudeDisableSlashCommands: true,
      timeoutMs: 60_000,
    });
    if (!result.ok) throw new Error(`Model access check failed. Settings were not changed. ${accessCheckDetail(provider, result.error)}`);
    const providers = { ...connectedAgents(current), [provider]: { provider, model: selection.model, effort: selection.effort } };
    const primary = makePrimary || current.provider === provider ? selection : current;
    return saveAgentSettings({ ...primary, providers }, original, env);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

async function main() {
  loadLocalEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const [command = "status", ...args] = process.argv.slice(2);
  if (command === "status") {
    const settings = readAgentSettings();
    console.log(JSON.stringify({ settings: settings ?? null, usage: settings ? readBackgroundUsage() : null }, null, 2));
    return;
  }
  if (!["configure", "connect", "primary"].includes(command)) throw new Error("Usage: node scripts/cove-agent-settings.mjs status | configure|connect|primary --provider claude|codex [--model ID] [--effort low|medium|high]");
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/, "");
    if (!["provider", "model", "effort"].includes(key) || !args[index + 1] || Object.hasOwn(options, key)) throw new Error("Invalid agent setting argument.");
    options[key] = args[index + 1];
  }
  if (command === "primary" && Object.keys(options).some(key => key !== "provider")) throw new Error("Primary selects an already verified provider; use configure to change its model.");
  const settings = command === "primary" ? setPrimaryAgent(options.provider) : await configureAgent({ ...options, makePrimary: command !== "connect" });
  console.log(`Primary Cove agent: ${settings.model} at ${settings.effort} effort.`);
  console.log(`Connected providers: ${Object.keys(connectedAgents(settings)).join(", ")}. Buddy conversation/replan calls use this selection. Task sessions use the same selection; interactive usage is separate from background caps. This command does not install or restart services.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
