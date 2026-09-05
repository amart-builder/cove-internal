import { readFileSync } from "node:fs";
import path from "node:path";
import { coveDataDir } from "./operator-runtime.mjs";

export const RECOMMENDED_AGENTS = Object.freeze({
  claude: { provider: "claude", model: "claude-fable-5-1", effort: "low" },
  codex: { provider: "codex", model: "gpt-6-astra", effort: "low" },
});

// Provisional workload ceilings, not subscription percentages or token prices.
export const DEFAULT_BACKGROUND_LIMITS = Object.freeze({
  callsPerHour: 6,
  callsPerDay: 24,
  callsPerWeek: 100,
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
  return { version: 1, provider: value.provider, model: value.model, effort: value.effort, backgroundLimits: limits };
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
