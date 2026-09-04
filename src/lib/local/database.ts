/**
 * Canonical SQLite connection factory.
 *
 * `openSqliteDatabase` applies connection safety settings but deliberately does
 * not migrate. Migration and recovery code use it when timing matters.
 * `openLocalDatabase` is the normal product entry point and always brings the
 * schema current before returning the connection.
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { coveEnv } from "../env";
import { runLocalMigrations } from "./migrations";

export function localDatabasePath(): string {
  return coveEnv("DB_PATH") ?? defaultLocalDatabasePath();
}

/** The database Cove opens when COVE_DB_PATH is not set. */
export function defaultLocalDatabasePath(): string {
  const canonical = path.join(process.cwd(), "data", "cove.db");
  // Pre-rename installs may still own data/forge.db. This fallback exists only
  // to migrate that one store forward; new features and docs use cove.db.
  const legacy = path.join(process.cwd(), "data", "forge.db");
  return existsSync(canonical) || !existsSync(legacy) ? canonical : legacy;
}

export function openSqliteDatabase(
  file: string = localDatabasePath(),
): Database.Database {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  return db;
}

export function openLocalDatabase(
  file: string = localDatabasePath(),
): Database.Database {
  const db = openSqliteDatabase(file);
  runLocalMigrations(db);
  return db;
}
