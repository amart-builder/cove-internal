import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { coveConfigPath, coveEnvTrimmed } from "./env-runtime.mjs";

let cachedOperatorProfile;

export function coveDataDir(explicit, env = process.env) {
  if (explicit) return explicit;
  const configured = coveEnvTrimmed("DATA_DIR", env);
  if (configured) return configured;
  const dbPath = coveEnvTrimmed("DB_PATH", env);
  return dbPath ? path.dirname(dbPath) : path.join(process.cwd(), "data");
}

export function operatorProfilePath(dataDir, env = process.env) {
  return coveEnvTrimmed("PROFILE_PATH", env) ??
    coveConfigPath(coveDataDir(dataDir, env), "profile.json");
}

export function loadOperatorProfile(dataDir, env = process.env) {
  const profilePath = operatorProfilePath(dataDir, env);
  try {
    const stats = statSync(profilePath);
    if (
      cachedOperatorProfile?.path === profilePath &&
      cachedOperatorProfile.mtimeMs === stats.mtimeMs &&
      cachedOperatorProfile.size === stats.size
    ) {
      return cachedOperatorProfile.profile;
    }
    const parsed = JSON.parse(readFileSync(profilePath, "utf8"));
    const profile = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : undefined;
    cachedOperatorProfile = {
      path: profilePath,
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      profile,
    };
    return profile;
  } catch {
    cachedOperatorProfile = undefined;
    return undefined;
  }
}

/**
 * What operatorName() returns when nothing is configured. Callers that route on
 * identity need to recognize this exact value, so it lives here rather than
 * being retyped as a literal in each of them.
 */
export const OPERATOR_NAME_FALLBACK = "the operator";
// "Atlas" is the folder name on the machine Cove was built on. It stays the
// fallback so an existing install keeps filing work exactly where it always
// has, but a new person gets to use a word that means something to them.
export const DEFAULT_PROJECT_FALLBACK = "Atlas";

export function operatorName(dataDir, env = process.env) {
  const envName = coveEnvTrimmed("OPERATOR_NAME", env);
  if (envName) return envName;
  const profileName = loadOperatorProfile(dataDir, env)?.name;
  return typeof profileName === "string" && profileName.trim()
    ? profileName.trim()
    : OPERATOR_NAME_FALLBACK;
}

export function operatorDefaultProject(dataDir, env = process.env) {
  const configured = coveEnvTrimmed("DEFAULT_PROJECT", env);
  if (configured) return configured;
  const profileProject = loadOperatorProfile(dataDir, env)?.defaultProject;
  return typeof profileProject === "string" && profileProject.trim()
    ? profileProject.trim()
    : DEFAULT_PROJECT_FALLBACK;
}

function usableTimezone(value) {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch {
    return undefined;
  }
}

/**
 * The operator's own timezone: the shared profile, then COVE_TIMEZONE (or the
 * legacy FORGE_TIMEZONE), then whatever this Mac is set to. Anything that
 * prints a date to the operator should use
 * this rather than a constant, or every install outside Pacific reads the wrong
 * day back to its owner.
 */
export function operatorTimezone() {
  return (
    usableTimezone(loadOperatorProfile()?.timezone) ??
    usableTimezone(coveEnvTrimmed("TIMEZONE")) ??
    usableTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone) ??
    "UTC"
  );
}

export function workspaceRoot(options = {}) {
  const configured = coveEnvTrimmed("BUDDY_WORKSPACE_ROOT", options.env);
  if (configured) return configured;
  const legacy = path.join(options.homeDir ?? os.homedir(), "Atlas");
  return (options.exists ?? existsSync)(legacy) ? legacy : null;
}
