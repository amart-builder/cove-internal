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

// Daily planning cannot be spent by unattended monitoring. Exact lane names
// prevent a new background lane from accidentally claiming protected capacity.
export function isPlanningLane(lane) {
  return lane === "morning-brief" || lane === "day-dump";
}

const WINDOWS = [["hour", "callsPerHour", 3_600_000], ["day", "callsPerDay", 86_400_000], ["week", "callsPerWeek", 604_800_000]];
const isChiefLane = lane => /^(chief-of-staff(?:$|-)|brief(?:$|-))/.test(lane);

function retryTime(rows, settings, lane, now) {
  const planning = isPlanningLane(lane);
  const pool = rows.filter(row => isPlanningLane(row.lane) === planning);
  const blocked = [];
  for (const [, key, duration] of WINDOWS) {
    const recent = pool.filter(row => row.started_at > now - duration);
    const limit = settings.backgroundLimits[key];
    if (recent.length >= limit) blocked.push(recent[recent.length - limit].started_at + duration + 1);
    // Monitoring leaves a quarter of its pool for consequential chief reviews.
    if (!planning && !isChiefLane(lane)) {
      const routine = recent.filter(row => !isChiefLane(row.lane));
      const routineLimit = Math.max(1, limit - Math.max(1, Math.floor(limit / 4)));
      if (routine.length >= routineLimit) blocked.push(routine[routine.length - routineLimit].started_at + duration + 1);
    }
  }
  return blocked.length ? new Date(Math.max(...blocked)).toISOString() : null;
}

/** Reserve before spawning. Failures/crashes count within their own pool. */
export function reserveBackgroundAttempt({ env, settings, lane, inputBytes, now = Date.now() }) {
  if (!isPlanningLane(lane) && inputBytes > settings.backgroundLimits.inputBytesPerCall) {
    throw Object.assign(new Error("background_input_limit: This job needs a smaller context before it can run."), { code: "background_input_limit" });
  }
  const db = openUsage(env);
  try {
    return db.transaction(() => {
      const rows = db.prepare("SELECT started_at,lane FROM cove_background_attempts WHERE started_at > ? ORDER BY started_at").all(now - 604_800_000);
      const retryAt = retryTime(rows, settings, lane, now);
      if (retryAt) {
        throw Object.assign(new Error(`background_usage_limit: Cove is waiting for ${isPlanningLane(lane) ? "daily planning" : "background review"} capacity. cove_budget_retry_at=${retryAt}. Scheduled task reminders remain available.`), { retryAt, code: "background_usage_limit" });
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

export function readBackgroundUsage(env = process.env, now = Date.now(), settings) {
  const db = openUsage(env);
  try {
    const rows = db.prepare("SELECT started_at,lane FROM cove_background_attempts WHERE started_at > ? ORDER BY started_at").all(now - 604_800_000);
    const pools = Object.fromEntries(["background", "planning"].map(pool => [pool, {
      windows: Object.fromEntries(WINDOWS.map(([key, , duration]) => [key, {
        calls: rows.filter(row => row.started_at > now - duration && isPlanningLane(row.lane) === (pool === "planning")).length,
      }])),
    }]));
    return {
      subscriptionRemaining: null,
      pools,
      ...(settings ? { availability: {
        routineRetryAt: retryTime(rows, settings, "email-classifier", now),
        chiefRetryAt: retryTime(rows, settings, "chief-of-staff", now),
        planningRetryAt: retryTime(rows, settings, "morning-brief", now),
      } } : {}),
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
