import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { coveEnv } from "../env";
import { runLocalMigrations } from "./migrations";

export function localDatabasePath(): string {
  const configured = coveEnv("DB_PATH");
  if (configured) return configured;
  const canonical = path.join(process.cwd(), "data", "cove.db");
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
