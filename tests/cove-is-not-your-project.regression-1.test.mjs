/**
 * Every card Cove made for you said your project was "Cove".
 *
 * The tasks table stores a project name, and `TodayRiverStageV2` prints it on
 * the first screen: `{task.project || 'No project'} · Due …`. Finding 15
 * established that `Atlas` is the stored sentinel for "nobody chose a project"
 * -- it is the tasks table's own column default, the day-plan store writes it
 * when no project is given (`day-plan/store.ts:326`), groundwork treats it as
 * "no project" (`autonomy/groundwork.ts:292`), and `helpfulProjectLabel` hides
 * it so the card shows no project rather than a folder name from the machine
 * Cove was built on.
 *
 * Three writers put the literal string `Cove` there instead: accepting a Quiet
 * Current proposal, accepting a day-plan item, and every capture intake makes
 * from an email or a meeting. `helpfulProjectLabel` does not hide `Cove` and
 * must not -- Alex's own project is Cove, and hiding it would hide a real
 * label. So Gary's first screen reads
 *
 *     Cove · Due Sep 24
 *
 * against "Send Dana the signed lease", and against every task Cove captured
 * from his email. The app's own name, printed in the slot that answers "which
 * of your projects is this".
 *
 * It is not only a label. `day-plan/store.ts:1661` resolves a task session's
 * working directory from a non-empty project name, and
 * `autonomy/groundwork.ts:292` does the same, so `Cove` sends both looking for
 * a folder called Cove on the person's machine.
 *
 * These three writers mean "no project was chosen", and Cove already has a
 * value for that, so they now let the column default supply it.
 */
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

import { helpfulProjectLabel } from "../src/lib/day-plan/presentation.ts";
import {
  acceptWorkSuggestion,
  createWorkSuggestion,
  setQuietCurrentStorePathForTests,
} from "../src/lib/quiet-current/store.ts";

const require = createRequire(import.meta.url);
require("tsx/cjs");
const { runLocalMigrations } = require("../src/lib/local/migrations.ts");

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-project-label-"));
  const storeFile = path.join(dir, "quiet-current.json");
  const dbPath = `${storeFile}.sqlite`;
  const db = new Database(dbPath);
  runLocalMigrations(db);
  db.close();
  mkdirSync(path.join(dir, "data"), { recursive: true });

  const prior = { db: process.env.COVE_DB_PATH, runtime: process.env.NEXT_PUBLIC_COVE_RUNTIME };
  delete globalThis.__coveDb;
  process.env.COVE_DB_PATH = dbPath;
  process.env.NEXT_PUBLIC_COVE_RUNTIME = "local";
  setQuietCurrentStorePathForTests(storeFile);
  t.after(() => {
    setQuietCurrentStorePathForTests(undefined);
    globalThis.__coveDb?.close();
    delete globalThis.__coveDb;
    if (prior.db === undefined) delete process.env.COVE_DB_PATH;
    else process.env.COVE_DB_PATH = prior.db;
    if (prior.runtime === undefined) delete process.env.NEXT_PUBLIC_COVE_RUNTIME;
    else process.env.NEXT_PUBLIC_COVE_RUNTIME = prior.runtime;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, dbPath };
}

test("the label hides the no-project sentinel and shows a real name", () => {
  assert.equal(helpfulProjectLabel("Atlas"), undefined);
  assert.equal(helpfulProjectLabel("Beacon Engine"), "Beacon Engine");
  // Cove is a legitimate project name -- it is Alex's -- so the label must not
  // learn to hide it. The writers are what has to change.
  assert.equal(helpfulProjectLabel("Cove"), "Cove");
});

test("an accepted proposal does not claim to belong to a project called Cove", (t) => {
  const files = fixture(t);
  const suggestion = createWorkSuggestion({
    kind: "create_task",
    title: "Send Dana the signed lease",
    description: "She asked for it before the walkthrough.",
    reason: "Dana named Thursday in the thread.",
    source: "Gmail thread with Dana",
    priority: "high",
    dueDate: "2026-09-24",
  });

  const accepted = acceptWorkSuggestion(suggestion.id, { source: "explicit_accept" });

  const db = new Database(files.dbPath, { readonly: true });
  let project;
  try {
    project = db.prepare("SELECT project FROM tasks WHERE id=?").pluck().get(accepted.taskId);
  } finally {
    db.close();
  }
  assert.equal(project, "Atlas", "the column default is the no-project sentinel");
  assert.equal(
    helpfulProjectLabel(project),
    undefined,
    "so the first screen shows no project rather than the app's own name",
  );
});

// The other two writers are guarded at the source, in the same style as
// tests/today-river-project-label.regression-1.test.mjs: both are inside larger
// functions whose real entry points need a live event or a day-plan session,
// and what matters here is only that neither writes the app's own name into the
// person's project column. `Cove` appearing anywhere else in these files -- in
// prose, an origin line, a comment -- is not what this is looking for.
test("the day-plan accept and the intake writer do not write it either", () => {
  const planning = readFileSync("src/lib/day-plan/planning.ts", "utf8");
  assert.doesNotMatch(
    planning,
    /INSERT INTO tasks\([^)]*project[^)]*\)[^;]*'Cove'/,
    "day-plan acceptance",
  );

  const writer = readFileSync("src/lib/intake/task-writer.ts", "utf8");
  assert.doesNotMatch(writer, /project:\s*input\.project\s*\?\?\s*"Cove"/, "intake capture");
});
