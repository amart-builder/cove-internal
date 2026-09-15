import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coveEnv } from "../../src/lib/env-runtime.mjs";
import { loadLocalEnv } from "./load-local-env.mjs";

// Shell recovery commands and launchd jobs must read the same private settings
// as the app before choosing a database. Explicit process settings still win.
// Relative paths belong to the checkout, not the caller's current directory.
export function loadCoveRuntimePaths(repoDir, env = process.env) {
  loadLocalEnv(repoDir, env);
  const configuredDb = coveEnv("DB_PATH", env);
  const dataDir = path.resolve(repoDir, coveEnv("DATA_DIR", env) ??
    (configuredDb ? path.dirname(configuredDb) : "data"));
  const canonical = path.join(dataDir, "cove.db");
  const legacy = path.join(dataDir, "forge.db");
  const dbPath = configuredDb ? path.resolve(repoDir, configuredDb) :
    (existsSync(canonical) || !existsSync(legacy) ? canonical : legacy);
  return {
    dataDir,
    dbPath,
    backupDir: path.resolve(repoDir, coveEnv("BACKUP_DIR", env) ?? path.join(path.dirname(dbPath), "backups")),
  };
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repoDir, field] = process.argv.slice(2);
  if (!repoDir || !["dataDir", "dbPath", "backupDir"].includes(field)) {
    throw new Error("Usage: node cove-runtime-paths.mjs <repo> dataDir|dbPath|backupDir");
  }
  process.stdout.write(loadCoveRuntimePaths(repoDir)[field]);
}
