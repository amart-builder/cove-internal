import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { coveDataDir } from "./operator-runtime.mjs";
import { coveEnv } from "./env-runtime.mjs";

export const BACKGROUND_USAGE_SCHEMA = `CREATE TABLE IF NOT EXISTS cove_background_attempts (
    id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, lane TEXT NOT NULL,
    provider TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL,
    input_bytes INTEGER NOT NULL, output_bytes INTEGER,
    status TEXT NOT NULL DEFAULT 'reserved', finished_at INTEGER,
    input_tokens INTEGER, cached_input_tokens INTEGER, output_tokens INTEGER
  ); CREATE INDEX IF NOT EXISTS cove_background_attempts_started ON cove_background_attempts(started_at);`;

// Plain Node workers can initialize this additive table without importing TS.
// It remains in the main database so ordinary Cove backups preserve the budget.
function openUsage(env) {
  const directory = coveDataDir(undefined, env);
  const canonical = path.join(directory, "cove.db");
  const legacy = path.join(directory, "forge.db");
  const file = coveEnv("DB_PATH", env) ?? (existsSync(canonical) || !existsSync(legacy) ? canonical : legacy);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  db.pragma("busy_timeout = 5000");
  db.exec(BACKGROUND_USAGE_SCHEMA);
  return db;
}

/** Reserve before spawning. Failures/crashes still count; retries cannot evade limits. */
export function reserveBackgroundAttempt({ env, settings, lane, inputBytes, now = Date.now() }) {
  if (inputBytes > settings.backgroundLimits.inputBytesPerCall) throw new Error("background_input_limit: This job needs a smaller context before it can run.");
  const db = openUsage(env);
  try {
    return db.transaction(() => {
      const windows = [["callsPerHour", 3_600_000], ["callsPerDay", 86_400_000], ["callsPerWeek", 604_800_000]];
      for (const [key, duration] of windows) {
        const count = db.prepare("SELECT COUNT(*) FROM cove_background_attempts WHERE started_at > ?").pluck().get(now - duration);
        if (count >= settings.backgroundLimits[key]) throw new Error(`background_usage_limit: Cove reached its ${key} limit. Scheduled task reminders remain available.`);
      }
      const id = randomUUID();
      db.prepare("INSERT INTO cove_background_attempts (id, started_at, lane, provider, model, effort, input_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, now, lane, settings.provider, settings.model, settings.effort, inputBytes);
      return id;
    }).immediate();
  } finally { db.close(); }
}

export function finishBackgroundAttempt({ env, id, status, outputBytes = null, usage = {}, now = Date.now() }) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const db = openUsage(env);
  try {
    db.prepare(`UPDATE cove_background_attempts SET status = ?, finished_at = ?, output_bytes = ?,
      input_tokens = ?, cached_input_tokens = ?, output_tokens = ? WHERE id = ? AND status = 'reserved'`)
      .run(status, now, outputBytes, count(usage.inputTokens), count(usage.cachedInputTokens), count(usage.outputTokens), id);
  } finally { db.close(); }
}

export function readBackgroundUsage(env = process.env, now = Date.now()) {
  const db = openUsage(env);
  try {
    return {
      subscriptionRemaining: null,
      windows: Object.fromEntries([["hour", 3_600_000], ["day", 86_400_000], ["week", 604_800_000]].map(([key, duration]) => [key,
        db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(input_bytes), 0) AS inputBytes,
          SUM(output_bytes) AS outputBytes, SUM(CASE WHEN output_bytes IS NULL THEN 1 ELSE 0 END) AS callsWithoutOutputBytes, SUM(input_tokens) AS inputTokens,
          SUM(output_tokens) AS outputTokens, SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) AS callsWithoutTokenUsage
          FROM cove_background_attempts WHERE started_at > ?`).get(now - duration),
      ])),
      recent: db.prepare("SELECT lane, provider, model, effort, status, started_at AS startedAt, finished_at AS finishedAt FROM cove_background_attempts ORDER BY started_at DESC LIMIT 20").all(),
    };
  } finally { db.close(); }
}
