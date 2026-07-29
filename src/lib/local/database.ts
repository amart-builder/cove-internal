import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { coveEnv } from "../env";
import { runLocalMigrations } from "./migrations";

export function localDatabasePath(): string {
  return coveEnv("DB_PATH") || path.join(process.cwd(), "data", "forge.db");
}

export function openSqliteDatabase(
  file: string = localDatabasePath(),
): Database.Database {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
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
