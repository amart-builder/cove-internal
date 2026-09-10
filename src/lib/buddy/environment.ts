import path from "node:path";
import { coveEnv } from "../env";
import { defaultLocalDatabasePath } from "../local/database";

// Explicit configuration parity; never forward the entire server environment.
const SOURCE_SUFFIXES = [
  "BUDDY_APP_URL", "PROFILE_PATH", "TIMEZONE", "SALES_PIPELINE",
  "BRIEF_GOALS_PATH", "BRIEF_OPERATOR_PROFILE_PATH", "BRIEF_SPRINT_MEMO_PATH", "BRIEF_LEADUP_PATH",
] as const;
export const BUDDY_DATA_ENV_KEYS = ["COVE_DATA_DIR", "COVE_DB_PATH", ...SOURCE_SUFFIXES.map(key => `COVE_${key}`)];

export function buddyDataPaths(repoDir: string, options: {
  env?: NodeJS.ProcessEnv; dataDir?: string; dbPath?: string;
} = {}) {
  const env = options.env ?? process.env;
  const dbPath = options.dbPath ?? coveEnv("DB_PATH", env) ?? defaultLocalDatabasePath(repoDir);
  const dataDir = options.dataDir ?? coveEnv("DATA_DIR", env) ?? path.dirname(dbPath);
  return { dataDir, dbPath };
}

export function buddyDataEnvironment(repoDir: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const { dataDir, dbPath } = buddyDataPaths(repoDir, { env });
  return { COVE_DATA_DIR: dataDir, COVE_DB_PATH: dbPath,
    ...Object.fromEntries(SOURCE_SUFFIXES.flatMap(key => {
      const value = coveEnv(key, env);
      return value === undefined ? [] : [[`COVE_${key}`, value]];
    })),
  };
}
