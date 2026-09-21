/**
 * Jev (TypeSafe System One) settings. Everything is off unless two things are
 * both true: the operator wrote `cove-jev.json` with `enabled: true` and at
 * least one feature in shadow or assist, and `COVE_TYPESAFE_API_KEY` is set in
 * the process environment (loaded from the ignored .env.local). A client
 * install has neither, so this module never reaches the network there.
 *
 * The key is read here and handed to the transport only. It is never
 * serialized, logged, projected, or passed to model child processes (those
 * build their environment from an allowlist that does not include it).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { coveConfigPath, coveConfigWritePath, coveEnvTrimmed, type CoveEnvironment } from "../env";
import { coveDataDir } from "../operator";

export type JevFeatureMode = "off" | "shadow" | "assist";
export const JEV_FEATURES = ["commitment_meaning", "email_meaning", "draft_correctness", "reply_detection", "task_identity", "planning_audit"] as const;
export type JevFeature = typeof JEV_FEATURES[number];

export type JevLimits = {
  callsPerHour: number;
  callsPerDay: number;
  concurrency: number;
  attemptTimeoutMs: number;
  totalTimeoutMs: number;
  maxRequestBytes: number;
  maxQuestions: number;
  maxResponseBytes: number;
};

export type JevSettings = {
  version: 1;
  enabled: boolean;
  features: Partial<Record<JevFeature, JevFeatureMode>>;
  limits: JevLimits;
};

// Engineering defaults from the agreed plan, not accuracy or capacity claims.
export const DEFAULT_JEV_LIMITS: Readonly<JevLimits> = Object.freeze({
  callsPerHour: 120,
  callsPerDay: 800,
  concurrency: 2,
  attemptTimeoutMs: 3_000,
  totalTimeoutMs: 6_000,
  maxRequestBytes: 24 * 1024,
  maxQuestions: 32,
  maxResponseBytes: 64 * 1024,
});

export const JEV_SETTINGS_OFF: Readonly<JevSettings> = Object.freeze({
  version: 1, enabled: false, features: {}, limits: DEFAULT_JEV_LIMITS,
});

export function jevSettingsPath(dataDir?: string, env?: CoveEnvironment): string {
  return coveConfigPath(coveDataDir(dataDir, env as NodeJS.ProcessEnv), "jev.json");
}

export function validateJevSettings(value: unknown): JevSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("cove_jev_settings_invalid");
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || typeof raw.enabled !== "boolean") throw new Error("cove_jev_settings_invalid");
  const features: Partial<Record<JevFeature, JevFeatureMode>> = {};
  const rawFeatures = raw.features ?? {};
  if (!rawFeatures || typeof rawFeatures !== "object" || Array.isArray(rawFeatures)) throw new Error("cove_jev_settings_invalid");
  for (const [name, mode] of Object.entries(rawFeatures as Record<string, unknown>)) {
    if (!(JEV_FEATURES as readonly string[]).includes(name)) throw new Error("cove_jev_settings_invalid");
    if (mode !== "off" && mode !== "shadow" && mode !== "assist") throw new Error("cove_jev_settings_invalid");
    features[name as JevFeature] = mode;
  }
  const limits: JevLimits = { ...DEFAULT_JEV_LIMITS };
  const rawLimits = raw.limits ?? {};
  if (!rawLimits || typeof rawLimits !== "object" || Array.isArray(rawLimits)) throw new Error("cove_jev_settings_invalid");
  for (const [name, limit] of Object.entries(rawLimits as Record<string, unknown>)) {
    if (!Object.hasOwn(DEFAULT_JEV_LIMITS, name)) throw new Error("cove_jev_settings_invalid");
    const key = name as keyof JevLimits;
    // A limit may be lowered freely; it may be raised to at most ten times the default.
    if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > DEFAULT_JEV_LIMITS[key] * 10) throw new Error("cove_jev_settings_invalid");
    limits[key] = Number(limit);
  }
  if (limits.attemptTimeoutMs > limits.totalTimeoutMs) throw new Error("cove_jev_settings_invalid");
  return { version: 1, enabled: raw.enabled, features, limits };
}

/** No file means off. A malformed file is an error, never a silent enable. */
export function readJevSettings(dataDir?: string, env: CoveEnvironment = process.env): JevSettings {
  try {
    return validateJevSettings(JSON.parse(readFileSync(jevSettingsPath(dataDir, env), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { ...JEV_SETTINGS_OFF, features: {}, limits: { ...DEFAULT_JEV_LIMITS } };
  }
}

export function writeJevSettings(settings: JevSettings, dataDir?: string, env: CoveEnvironment = process.env): JevSettings {
  const checked = validateJevSettings(settings);
  const file = coveConfigWritePath(coveDataDir(dataDir, env as NodeJS.ProcessEnv), "jev.json");
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const pending = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(pending, JSON.stringify(checked, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(pending, file);
  } finally { rmSync(pending, { force: true }); }
  return checked;
}

/** The key itself. Callers pass it straight to the transport and nowhere else. */
export function jevApiKey(env: CoveEnvironment = process.env): string | undefined {
  return coveEnvTrimmed("TYPESAFE_API_KEY", env);
}

/** A short non-reversible fingerprint so the ledger can tell "the key changed"
 * without ever storing the key. */
export function jevCredentialRevision(env: CoveEnvironment = process.env): string | undefined {
  const key = jevApiKey(env);
  return key ? createHash("sha256").update(key).digest("hex").slice(0, 16) : undefined;
}

export type JevAvailability =
  | { available: true; mode: Exclude<JevFeatureMode, "off"> }
  | { available: false; reason: "disabled" | "feature_off" | "no_key" };

export function jevAvailability(feature: JevFeature, settings: JevSettings, env: CoveEnvironment = process.env): JevAvailability {
  if (!settings.enabled) return { available: false, reason: "disabled" };
  const mode = settings.features[feature] ?? "off";
  if (mode === "off") return { available: false, reason: "feature_off" };
  if (!jevApiKey(env)) return { available: false, reason: "no_key" };
  return { available: true, mode };
}
