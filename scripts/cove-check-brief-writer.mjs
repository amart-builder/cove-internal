#!/usr/bin/env node

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configuredJobBackend } from "../src/lib/model-runner-runtime.mjs";
import { loadCoveRuntimePaths } from "./lib/cove-runtime-paths.mjs";

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const NO_BRIEF_YET = "No successful Morning Brief exists yet.";

// day_plan_briefs is created by the day-plan store the first time it runs, so
// on an install that has not produced a brief yet the table is simply absent
// and SQLite's own words are what SETUP.md's check prints: "no such table:
// day_plan_briefs". At Step 5, where having no brief yet is the expected
// state, that reads like a broken migration and invites someone to repair a
// database that is fine. The sentence below is the one the code already meant
// to print in that case.
function requireBriefTable(db) {
  const present = db.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'day_plan_briefs'",
  ).get();
  if (!present) throw new Error(NO_BRIEF_YET);
}

// better-sqlite3 answers a missing file with "unable to open database file",
// which names neither the file nor the reason. At Step 5 the likeliest reason
// is that the check is looking somewhere the app is not.
function openBriefDatabase(dbPath) {
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (error) {
    if (existsSync(dbPath)) throw error;
    throw new Error(
      `Cove has no database at ${dbPath} yet. Start Cove once, or check COVE_DATA_DIR and COVE_DB_PATH.`,
    );
  }
}

export function latestSuccessfulBriefWriter(dbPath) {
  const db = openBriefDatabase(dbPath);
  try {
    requireBriefTable(db);
    const row = db.prepare(`
      SELECT brief_json FROM day_plan_briefs
      WHERE status = 'succeeded'
      ORDER BY COALESCE(finished_at, updated_at) DESC, id DESC LIMIT 1
    `).get();
    if (!row) throw new Error(NO_BRIEF_YET);
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

export function latestSuccessfulBriefLocalSources(dbPath, dataDir) {
  const db = openBriefDatabase(dbPath);
  try {
    requireBriefTable(db);
    const row = db.prepare(`
      SELECT source_manifest_json FROM day_plan_briefs
      WHERE status = 'succeeded'
      ORDER BY COALESCE(finished_at, updated_at) DESC, id DESC LIMIT 1
    `).get();
    if (!row) throw new Error(NO_BRIEF_YET);
    let manifest;
    try {
      manifest = JSON.parse(row.source_manifest_json);
    } catch {
      throw new Error("The latest successful Morning Brief has no valid source manifest.");
    }
    if (!Array.isArray(manifest?.sources)) {
      throw new Error("The latest successful Morning Brief has no valid source manifest.");
    }

    const sourceById = new Map(manifest.sources.map((source) => [source?.id, source]));
    const expected = {
      goals: [path.join(dataDir, "brief", "goals.md")],
      operator_profile: [
        path.join(dataDir, "brief", "operator-profile.md"),
        path.join(dataDir, "cove-profile.json"),
      ],
      leadup: [path.join(dataDir, "brief", "leadup.md")],
      sprint_memo: [path.join(dataDir, "brief", "sprint-memo.md")],
    };

    const verified = [];
    for (const [id, allowedPaths] of Object.entries(expected)) {
      const source = sourceById.get(id);
      const note = typeof source?.note === "string" ? source.note : "";
      const resolvedNote = note.startsWith("unreadable:")
        ? path.resolve(note.slice("unreadable:".length))
        : path.resolve(note);
      if (
        !source ||
        source.freshness === "missing" ||
        !Number.isFinite(source.chars) ||
        source.chars <= 0 ||
        !allowedPaths.some((allowedPath) => path.resolve(allowedPath) === resolvedNote)
      ) {
        throw new Error(
          `Morning Brief source ${id} did not come from this Cove installation.`,
        );
      }
      verified.push(id);
    }
    return verified;
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

export function configuredExpectedBriefWriter(env = process.env) {
  return configuredJobBackend(env, "BRIEF_WRITER") === "claude" ? "claude" : "codex";
}

export function checkLatestBriefWriter(options = {}) {
  // The check has to open the database the app opens. Reading COVE_DB_PATH out
  // of the process environment found neither COVE_DATA_DIR nor anything set in
  // .env.local, which is where SETUP.md puts this configuration -- so on a
  // relocated install this looked in <repo>/data/cove.db and reported on a
  // database nothing had written. loadCoveRuntimePaths is the resolver the
  // recovery commands and launchd jobs already share for the same reason.
  const runtime = loadCoveRuntimePaths(repoDir);
  const dbPath = path.resolve(options.dbPath ?? runtime.dbPath);
  const writer = latestSuccessfulBriefWriter(dbPath);
  if (options.expected && writer !== options.expected) {
    throw new Error(`Expected Morning Brief writer ${options.expected}, found ${writer}.`);
  }
  const dataDir = path.resolve(options.dataDir ?? runtime.dataDir);
  const localSources = options.expectLocalSources
    ? latestSuccessfulBriefLocalSources(dbPath, dataDir)
    : undefined;
  return { writer, dbPath, ...(localSources ? { localSources } : {}) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    const explicitExpected = parseExpectedWriter(argv);
    if (explicitExpected && argv.includes("--expect-configured")) {
      throw new Error("Use either --expect or --expect-configured, not both.");
    }
    const expected = argv.includes("--expect-configured")
      ? configuredExpectedBriefWriter()
      : explicitExpected;
    const expectLocalSources = argv.includes("--expect-local-sources");
    const result = checkLatestBriefWriter({ expected, expectLocalSources });
    console.log(`Morning Brief writer: ${result.writer}`);
    if (result.localSources) {
      console.log(`Morning Brief local sources: ${result.localSources.join(", ")}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
