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
  const db = new Database(file, { timeout: 250 });
  try {
    db.pragma("foreign_keys = ON");
    // Two first-openers can collide on the journal-mode lock upgrade even
    // with SQLite's busy handler. Retry only this idempotent setup operation.
    const deadline = Date.now() + 5000;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      try {
        db.pragma("journal_mode = WAL");
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== "SQLITE_BUSY" || Date.now() >= deadline) throw error;
        Atomics.wait(pause, 0, 0, 20);
      }
    }
    db.pragma("busy_timeout = 5000");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openLocalDatabase(
  file: string = localDatabasePath(),
): Database.Database {
  const db = openSqliteDatabase(file);
  try {
    runLocalMigrations(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
