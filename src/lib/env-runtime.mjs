import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Cove used to be called Forge. Every setting keeps working under both names:
 * the new COVE_* variable wins, and the old FORGE_* one is the fallback, so a
 * machine installed before the rename runs unchanged with no edits to its
 * LaunchAgents or .env.local.
 *
 * Call sites pass the suffix only ("DB_PATH"), never the full variable name.
 *
 * The one exception is NEXT_PUBLIC_*: Next.js inlines those into the browser
 * bundle at build time, so they cannot be resolved at runtime. Those keep their
 * FORGE_ names (see src/lib/runtime/mode.ts and src/lib/supabase/rest.ts).
 *
 * @param {string} suffix
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | undefined}
 */
export function coveEnv(suffix, env = process.env) {
  return env[`COVE_${suffix}`] ?? env[`FORGE_${suffix}`];
}

/**
 * The same lookup, with blank and whitespace-only values treated as unset.
 *
 * @param {string} suffix
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | undefined}
 */
export function coveEnvTrimmed(suffix, env = process.env) {
  const value = coveEnv(suffix, env)?.trim();
  return value || undefined;
}

/**
 * Operator config files are named cove-<name>.json now. An install made before
 * the rename still has forge-<name>.json on disk and must keep working, so
 * reads prefer the new name and fall back to the old one.
 *
 * `name` is the bare part: "profile.json", "email.json", "autonomy.json".
 */
export function coveConfigPath(dataDir, name) {
  const canonical = path.join(dataDir, `cove-${name}`);
  if (existsSync(canonical)) return canonical;
  const legacy = path.join(dataDir, `forge-${name}`);
  return existsSync(legacy) ? legacy : canonical;
}

/** Writes always go to the new name, which migrates the file on first write. */
export function coveConfigWritePath(dataDir, name) {
  return path.join(dataDir, `cove-${name}`);
}
