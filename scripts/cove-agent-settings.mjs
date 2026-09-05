#!/usr/bin/env node
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentSettingsPath, readAgentSettings, RECOMMENDED_AGENTS, validateAgentSettings } from "../src/lib/agent-settings.mjs";
import { readBackgroundUsage } from "../src/lib/background-usage.mjs";
import { loadLocalEnv } from "./lib/load-local-env.mjs";
import { runJob } from "../src/lib/model-runner-runtime.mjs";

export async function configureAgent({ provider, model, effort, env = process.env, runner = runJob }) {
  const recommendation = RECOMMENDED_AGENTS[provider];
  if (!recommendation) throw new Error("Choose --provider claude or --provider codex.");
  const file = agentSettingsPath(env);
  let original;
  try { original = readFileSync(file, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const current = readAgentSettings(env);
  const settings = validateAgentSettings({ version: 1, provider,
    model: model ?? recommendation.model, effort: effort ?? recommendation.effort,
    ...(current ? { backgroundLimits: current.backgroundLimits } : {}),
  });
  // Preflight uses a temporary desk, never the person's tasks or email.
  const temporary = mkdtempSync(path.join(os.tmpdir(), "cove-agent-preflight-"));
  try {
    const result = await runner({ lane: "setup-check", kind: "structured", prompt: 'Return {"ready":true}. Do not use tools.',
      schema: { type: "object", properties: { ready: { const: true, type: "boolean" } }, required: ["ready"], additionalProperties: false },
      agentSettings: settings, env: { ...env, COVE_DATA_DIR: temporary, COVE_DB_PATH: path.join(temporary, "cove.db") },
      claudeTools: "", claudeNoChrome: true, claudeDisableSlashCommands: true,
      timeoutMs: 60_000,
    });
    if (!result.ok) throw new Error(`Model access check failed. Settings were not changed. ${result.error.message}`);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const lock = `${file}.lock`;
    try { writeFileSync(lock, String(process.pid), { mode: 0o600, flag: "wx" }); }
    catch (error) {
      if (error.code === "EEXIST") throw new Error("Another settings change holds the configuration lock. Finish that change before retrying.");
      throw error;
    }
    try {
      // Serialize cooperating setup commands, then check changes made while
      // the model-access probe was running.
      let latest;
      try { latest = readFileSync(file, "utf8"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (latest !== original) throw new Error("Agent settings changed during verification. Read the current selection and retry.");
      const pending = `${file}.${process.pid}.tmp`;
      try {
        writeFileSync(pending, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        renameSync(pending, file);
      } finally { rmSync(pending, { force: true }); }
    } finally { rmSync(lock, { force: true }); }
    return settings;
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
  if (command !== "configure") throw new Error("Usage: node scripts/cove-agent-settings.mjs status | configure --provider claude|codex [--model ID] [--effort low|medium|high]");
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/, "");
    if (!["provider", "model", "effort"].includes(key) || !args[index + 1] || Object.hasOwn(options, key)) throw new Error("Invalid agent setting argument.");
    options[key] = args[index + 1];
  }
  const settings = await configureAgent(options);
  console.log(`Verified and saved ${settings.model} at ${settings.effort} effort for bounded model jobs and the chief of staff.`);
  console.log("Buddy conversation/replan calls use this selection. Task sessions use the same selection; interactive usage is separate from background caps. This command does not install or restart services.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
