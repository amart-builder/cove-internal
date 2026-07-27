import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let cachedOperatorProfile;

function trimmedEnv(name, env = process.env) {
  const value = env[name]?.trim();
  return value || undefined;
}

export function forgeDataDir(explicit) {
  if (explicit) return explicit;
  const configured = trimmedEnv("FORGE_DATA_DIR");
  if (configured) return configured;
  const dbPath = trimmedEnv("FORGE_DB_PATH");
  return dbPath ? path.dirname(dbPath) : path.join(process.cwd(), "data");
}

export function operatorProfilePath(dataDir) {
  return trimmedEnv("FORGE_PROFILE_PATH") ??
    path.join(forgeDataDir(dataDir), "forge-profile.json");
}

export function loadOperatorProfile() {
  const profilePath = operatorProfilePath();
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

export function operatorName() {
  const envName = trimmedEnv("FORGE_OPERATOR_NAME");
  if (envName) return envName;
  const profileName = loadOperatorProfile()?.name;
  return typeof profileName === "string" && profileName.trim()
    ? profileName.trim()
    : "the operator";
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
 * The operator's own timezone: FORGE_TIMEZONE, then the profile, then whatever
 * this Mac is set to. Anything that prints a date to the operator should use
 * this rather than a constant, or every install outside Pacific reads the wrong
 * day back to its owner.
 */
export function operatorTimezone() {
  return (
    usableTimezone(trimmedEnv("FORGE_TIMEZONE")) ??
    usableTimezone(loadOperatorProfile()?.timezone) ??
    usableTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone) ??
    "UTC"
  );
}

export function workspaceRoot(options = {}) {
  const configured = trimmedEnv("FORGE_BUDDY_WORKSPACE_ROOT", options.env);
  if (configured) return configured;
  const legacy = path.join(options.homeDir ?? os.homedir(), "Atlas");
  return (options.exists ?? existsSync)(legacy) ? legacy : null;
}
