import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { coveDataDir } from "./operator-runtime.mjs";

export const RECOMMENDED_AGENTS = Object.freeze({
  claude: { provider: "claude", model: "claude-fable-5-1", effort: "low" },
  codex: { provider: "codex", model: "gpt-6-astra", effort: "low" },
});

// Provisional workload ceilings, not subscription percentages or token prices.
export const DEFAULT_BACKGROUND_LIMITS = Object.freeze({
  callsPerHour: 12,
  callsPerDay: 96,
  callsPerWeek: 400,
  inputBytesPerCall: 96_000,
  outputBytesPerCall: 64_000,
  timeoutMs: 120_000,
});

export function agentSettingsPath(env = process.env) {
  return path.join(coveDataDir(undefined, env), "agent-settings.json");
}

export function validateAgentSettings(value) {
  if (!value || value.version !== 1 || !["claude", "codex"].includes(value.provider) ||
      typeof value.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value.model) ||
      !["low", "medium", "high"].includes(value.effort)) {
    throw new Error("Invalid Cove agent settings. Choose a provider, model and effort before starting background work.");
  }
  if ((value.provider === "claude" && !value.model.startsWith("claude-")) ||
      (value.provider === "codex" && !value.model.startsWith("gpt-"))) {
    throw new Error("The selected model does not match the Cove agent provider.");
  }
  if (value.backgroundLimits !== undefined && (
    !value.backgroundLimits || typeof value.backgroundLimits !== "object" || Array.isArray(value.backgroundLimits) ||
    Object.keys(value.backgroundLimits).some(key => !Object.hasOwn(DEFAULT_BACKGROUND_LIMITS, key))
  )) throw new Error("Invalid Cove background limits. Use only the documented limit names.");
  const limits = { ...DEFAULT_BACKGROUND_LIMITS, ...value.backgroundLimits };
  for (const key of Object.keys(DEFAULT_BACKGROUND_LIMITS)) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > DEFAULT_BACKGROUND_LIMITS[key] * 10) {
      throw new Error(`Invalid Cove background limit: ${key}.`);
    }
  }
  let providers;
  if (value.providers !== undefined) {
    if (!value.providers || typeof value.providers !== "object" || Array.isArray(value.providers) ||
        Object.keys(value.providers).some(key => !Object.hasOwn(RECOMMENDED_AGENTS, key))) {
      throw new Error("Invalid connected Cove providers.");
    }
    providers = {};
    for (const [provider, selection] of Object.entries(value.providers)) {
      const checked = validateAgentSettings({ version: 1, provider, model: selection?.model, effort: selection?.effort });
      providers[provider] = { provider, model: checked.model, effort: checked.effort };
    }
    if (providers[value.provider]?.model !== value.model || providers[value.provider]?.effort !== value.effort) {
      throw new Error("The primary Cove agent must match a connected provider.");
    }
  }
  return { version: 1, provider: value.provider, model: value.model, effort: value.effort, backgroundLimits: limits,
    ...(providers ? { providers } : {}) };
}

// Older installs have verified only their saved primary. CLI presence alone is
// not evidence of model access. Preserve the legacy Claude lane before setup.
export function connectedAgents(settings) {
  if (!settings) return {};
  return settings.providers ?? { [settings.provider]: { provider: settings.provider, model: settings.model, effort: settings.effort } };
}

export function agentProviderStatus(settings) {
  return { defaultProvider: settings?.provider ?? "claude", connectedProviders: settings ? Object.keys(connectedAgents(settings)) : ["claude"] };
}

export function saveAgentSettings(settings, original, env = process.env) {
  const checked = validateAgentSettings(settings);
  const file = agentSettingsPath(env);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  try { writeFileSync(lock, String(process.pid), { mode: 0o600, flag: "wx" }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("Another settings change holds the configuration lock. Finish that change before retrying.");
    throw error;
  }
  try {
    let latest;
    try { latest = readFileSync(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (latest !== original) throw new Error("Agent settings changed during verification. Read the current selection and retry.");
    const pending = `${file}.${process.pid}.tmp`;
    try {
      writeFileSync(pending, JSON.stringify(checked, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      renameSync(pending, file);
    } finally { rmSync(pending, { force: true }); }
  } finally { rmSync(lock, { force: true }); }
  return checked;
}

export function setPrimaryAgent(provider, env = process.env) {
  const original = readFileSync(agentSettingsPath(env), "utf8");
  const current = validateAgentSettings(JSON.parse(original));
  const providers = connectedAgents(current);
  if (!Object.hasOwn(providers, provider)) throw new Error(`Connect and verify ${provider} in Cove setup before choosing it.`);
  return saveAgentSettings({ ...current, ...providers[provider], providers }, original, env);
}

/** No file means keep the existing installation's lane settings unchanged. */
export function readAgentSettings(env = process.env) {
  try {
    return validateAgentSettings(JSON.parse(readFileSync(agentSettingsPath(env), "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}
