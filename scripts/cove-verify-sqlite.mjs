#!/usr/bin/env node

import Database from "better-sqlite3";

const file = process.argv[2];
if (!file) throw new Error("Usage: node scripts/cove-verify-sqlite.mjs <database>");

const db = new Database(file, { readonly: true, fileMustExist: true });
try {
  const result = db.pragma("quick_check");
  if (result.length !== 1 || result[0]?.quick_check !== "ok") {
    throw new Error(`SQLite quick_check failed: ${JSON.stringify(result)}`);
  }
  const coveTables = db.prepare(
    `SELECT COUNT(*) AS count
     FROM sqlite_schema
     WHERE type = 'table' AND name IN ('tasks','day_plans','buddy_state')`,
  ).get();
  if (!coveTables || coveTables.count === 0) {
    throw new Error("The database does not contain a recognized Cove table.");
  }
} finally {
  db.close();
}
