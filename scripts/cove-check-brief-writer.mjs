#!/usr/bin/env node

import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { coveEnv } from "../src/lib/env-runtime.mjs";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function latestSuccessfulBriefWriter(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare(`
      SELECT brief_json FROM day_plan_briefs
      WHERE status = 'succeeded'
      ORDER BY COALESCE(finished_at, updated_at) DESC, id DESC LIMIT 1
    `).get();
    if (!row) throw new Error("No successful Morning Brief exists yet.");
    let brief;
    try {
      brief = JSON.parse(row.brief_json);
    } catch {
      throw new Error("The latest successful Morning Brief has invalid stored JSON.");
    }
    if (brief?.writer !== "claude" && brief?.writer !== "codex") {
      throw new Error("The latest successful Morning Brief does not record a supported writer.");
    }
    return brief.writer;
  } finally {
    db.close();
  }
}

function parseExpectedWriter(argv) {
  const index = argv.indexOf("--expect");
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value !== "claude" && value !== "codex") {
    throw new Error("--expect must be followed by 'claude' or 'codex'.");
  }
  return value;
}

export function checkLatestBriefWriter(options = {}) {
  const dbPath = path.resolve(
    options.dbPath ?? coveEnv("DB_PATH") ?? path.join(repoDir, "data", "cove.db"),
  );
  const writer = latestSuccessfulBriefWriter(dbPath);
  if (options.expected && writer !== options.expected) {
    throw new Error(`Expected Morning Brief writer ${options.expected}, found ${writer}.`);
  }
  return { writer, dbPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const expected = parseExpectedWriter(process.argv.slice(2));
    const result = checkLatestBriefWriter({ expected });
    console.log(`Morning Brief writer: ${result.writer}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
