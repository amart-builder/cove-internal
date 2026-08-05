import path from "node:path";
import { coveEnvTrimmed, type CoveEnvironment } from "../env";

export function resolveEmailRuntimePaths(input: {
  repoDir: string;
  dataDir?: string;
  dbPath?: string;
  env?: CoveEnvironment;
}): { dataDir: string; dbPath: string } {
  const env = input.env ?? process.env;
  const configuredDataDir = coveEnvTrimmed("DATA_DIR", env);
  const configuredDbPath = coveEnvTrimmed("DB_PATH", env);
  const dataDir = input.dataDir ??
    (input.dbPath
      ? path.dirname(input.dbPath)
      : configuredDataDir ??
        (configuredDbPath ? path.dirname(configuredDbPath) : path.join(input.repoDir, "data")));
  const dbPath = input.dbPath ??
    (input.dataDir ? path.join(dataDir, "cove.db") : configuredDbPath) ??
    path.join(dataDir, "cove.db");
  return { dataDir, dbPath };
}
