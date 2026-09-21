/**
 * An accepted proposal with no date is the least-covered card Cove can hold.
 *
 * `acceptWorkSuggestion` writes the card into "Must happen today" and copies
 * `suggestion.dueDate` into `due_at`, or null when the proposal had none. Four
 * lanes could chase that card later and every one of them selects
 * `due_at IS NOT NULL`: the due reminder, the attention floor, the
 * follow-through checks and the pre-deadline nudge. The fifth safety net, the
 * stale-task watchdog, deliberately covers only Not Started and In Flight.
 *
 * So an undated accepted card sits in "Must happen today" — saying that every
 * day, including the ones where it is not true — and nothing in Cove will ever
 * raise it again. The acceptance path is the one place a person says "yes,
 * this is mine", and it produced the one card shape with no path to its next
 * decision.
 *
 * `dueDate` has always worked; `createWorkSuggestion` takes it and the accept
 * carries it straight through. `skills/cove-suggest/SKILL.md` simply never
 * mentioned it, so an agent following the skill proposed undated work by
 * construction — while `skills/cove-task/SKILL.md`, for the same person's
 * board, spends a whole section on choosing a date and telling them what it
 * chose. The skill now names the field and says what an undated proposal costs.
 *
 * The watchdog's exclusion of Today is left alone on purpose: it is a stated,
 * tested contract, and widening it changes how often Cove asks "still want
 * this?", which is Alex's call and not a defect fix. The findings report has
 * the argument and the one-line change.
 */
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import {
  acceptWorkSuggestion,
  createWorkSuggestion,
  setQuietCurrentNowForTests,
  setQuietCurrentStorePathForTests,
} from "../src/lib/quiet-current/store.ts";
import { detectStaleTasks } from "../src/lib/tasks/stale.ts";

const require = createRequire(import.meta.url);
require("tsx/cjs");
const { runLocalMigrations } = require("../src/lib/local/migrations.ts");

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-accepted-"));
  // withStore derives the board database from the test store path, not from
  // COVE_DB_PATH, so the migrated file has to be the one it will reach for.
  const storeFile = path.join(dir, "quiet-current.json");
  const dbPath = `${storeFile}.sqlite`;
  const db = new Database(dbPath);
  runLocalMigrations(db);
  db.close();
  mkdirSync(path.join(dir, "data"), { recursive: true });

  const prior = {
    db: process.env.COVE_DB_PATH,
    runtime: process.env.NEXT_PUBLIC_COVE_RUNTIME,
  };
  const priorDb = globalThis.__coveDb;
  delete globalThis.__coveDb;
  process.env.COVE_DB_PATH = dbPath;
  process.env.NEXT_PUBLIC_COVE_RUNTIME = "local";
  setQuietCurrentStorePathForTests(storeFile);
  setQuietCurrentNowForTests(undefined);
  t.after(() => {
    setQuietCurrentNowForTests(undefined);
    setQuietCurrentStorePathForTests(undefined);
    globalThis.__coveDb?.close();
    if (priorDb === undefined) delete globalThis.__coveDb;
    else globalThis.__coveDb = priorDb;
    if (prior.db === undefined) delete process.env.COVE_DB_PATH;
    else process.env.COVE_DB_PATH = prior.db;
    if (prior.runtime === undefined) delete process.env.NEXT_PUBLIC_COVE_RUNTIME;
    else process.env.NEXT_PUBLIC_COVE_RUNTIME = prior.runtime;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, dbPath };
}

function propose(overrides = {}) {
  return createWorkSuggestion({
    kind: "create_task",
    title: "Send Dana the signed lease",
    description: "She asked for it before the walkthrough.",
    reason: "Dana named Thursday in the thread.",
    source: "Gmail thread with Dana",
    priority: "high",
    ...overrides,
  });
}

function card(files, taskId) {
  const db = new Database(files.dbPath, { readonly: true });
  try {
    return db.prepare(
      `SELECT tasks.due_at, task_columns.name AS column_name
         FROM tasks JOIN task_columns ON task_columns.id = tasks.column_id
        WHERE tasks.id = ?`,
    ).get(taskId);
  } finally {
    db.close();
  }
}

test("a dated proposal carries its date onto the card", (t) => {
  const files = fixture(t);
  const suggestion = propose({ dueDate: "2026-09-24T00:00:00.000Z" });

  const accepted = acceptWorkSuggestion(suggestion.id, { source: "explicit_accept" });

  assert.deepEqual(card(files, accepted.taskId), {
    due_at: "2026-09-24T00:00:00.000Z",
    column_name: "Must happen today",
  });
});

test("an undated one lands where no lane can reach it", (t) => {
  const files = fixture(t);
  const suggestion = propose();

  const accepted = acceptWorkSuggestion(suggestion.id, { source: "explicit_accept" });
  const row = card(files, accepted.taskId);

  assert.equal(row.due_at, null, "every reminder lane selects due_at IS NOT NULL");
  assert.equal(row.column_name, "Must happen today");

  // And the one net that does not need a date does not cover that column.
  // Three weeks untouched, against a 14-day default.
  assert.deepEqual(
    detectStaleTasks({
      dbPath: files.dbPath,
      dataDir: path.join(files.dir, "data"),
      now: new Date(Date.now() + 21 * 86_400_000),
    }),
    [],
  );
});

test("the skill tells the agent the field exists and what leaving it out costs", () => {
  const skill = readFileSync("skills/cove-suggest/SKILL.md", "utf8");

  assert.match(skill, /`dueDate`/, "it names the field");
  assert.match(
    skill,
    /Must happen today/,
    "and where an accepted proposal actually lands",
  );
  assert.match(
    skill,
    /no reminder/i,
    "and that an undated one gets none",
  );
});
