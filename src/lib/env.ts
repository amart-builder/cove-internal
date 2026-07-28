import * as runtime from "./env-runtime.mjs";

/** Any environment-shaped bag of strings, including NodeJS.ProcessEnv. */
export type CoveEnvironment = Record<string, string | undefined>;

/**
 * Typed face of env-runtime.mjs. The plain-node scripts import the .mjs twin
 * directly; everything under src/ goes through here. See env-runtime.mjs for
 * why both COVE_* and FORGE_* are honoured.
 */

export function coveEnv(
  suffix: string,
  env: CoveEnvironment = process.env,
): string | undefined {
  return runtime.coveEnv(suffix, env) as string | undefined;
}

export function coveEnvTrimmed(
  suffix: string,
  env: CoveEnvironment = process.env,
): string | undefined {
  return runtime.coveEnvTrimmed(suffix, env) as string | undefined;
}

export function coveConfigPath(dataDir: string, name: string): string {
  return runtime.coveConfigPath(dataDir, name) as string;
}

export function coveConfigWritePath(dataDir: string, name: string): string {
  return runtime.coveConfigWritePath(dataDir, name) as string;
}
