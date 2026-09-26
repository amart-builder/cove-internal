/**
 * The wake loop validated a proposed deadline and then threw it away.
 *
 * `task_create` is the legacy action kind, and Cove does the right thing with
 * it: new work is never added on the model's say-so, so the action is
 * downgraded to a Quiet Current proposal for the person to accept. On the way
 * through, `validateChiefOfStaffDueAt` checks the proposed `due_at` and
 * `proposedDeadlineLabel` writes it into the description as a sentence the
 * person can read -- "Proposed deadline, not yet confirmed: Sep 22, 2026".
 *
 * It was never passed to `createWorkSuggestion` as data. The `suggest` branch
 * eleven lines below does pass its own `due_date` through, so the two adjacent
 * paths disagreed about whether a proposed deadline is a value or a sentence.
 *
 * Finding 54 is what makes that expensive rather than untidy. An accepted
 * proposal lands in "Must happen today" with `due_at = dueDate ?? null`, every
 * reminder lane selects `due_at IS NOT NULL`, and the stale watchdog skips that
 * column. So the person accepted a card that says, inside its own description,
 * which day it is due -- and no lane in Cove could ever raise it. Cove knew the
 * date, told them the date, and kept no date.
 *
 * Accepting is the confirmation the downgrade was waiting for, which is why the
 * value carries across at that moment and not before.
 */
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyChiefOfStaffActions } from "../src/lib/chief-of-staff/driver.ts";
import { enqueueChiefOfStaffWake } from "../src/lib/chief-of-staff/storage.ts";
import { openLocalDatabase } from "../src/lib/local/database.ts";
import {
  acceptWorkSuggestion,
  getQuietCurrentSnapshot,
  setQuietCurrentStorePathForTests,
} from "../src/lib/quiet-current/store.ts";

const NOW = new Date("2026-09-21T16:00:00Z");
const TITLE = "Send Priya the revised scope";

function propose(t, dueAt) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-cos-carry-"));
  const dbPath = path.join(dataDir, "cove.db");
  const prior = {
    data: process.env.COVE_DATA_DIR,
    zone: process.env.COVE_TIMEZONE,
    db: process.env.COVE_DB_PATH,
  };
  process.env.COVE_DATA_DIR = dataDir;
  process.env.COVE_TIMEZONE = "America/Los_Angeles";
  process.env.COVE_DB_PATH = dbPath;
  t.after(() => {
    setQuietCurrentStorePathForTests(undefined);
    globalThis.__coveDb?.close();
    delete globalThis.__coveDb;
    for (const [key, value] of [
      ["COVE_DATA_DIR", prior.data],
      ["COVE_TIMEZONE", prior.zone],
      ["COVE_DB_PATH", prior.db],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  const db = openLocalDatabase(dbPath);
  let job;
  try {
    job = db.transaction(() =>
      enqueueChiefOfStaffWake(db, { reason: "manual", note: TITLE, now: NOW }),
    ).immediate().job;
  } finally {
    db.close();
  }

  const counts = applyChiefOfStaffActions({
    dbPath,
    dataDir,
    wakeJobId: job.id,
    actions: [{
      action_id: "propose",
      kind: "task_create",
      why: "Priya asked for it in this morning's meeting.",
      title: TITLE,
      details: "She wants the revised scope before the walkthrough.",
      due_at: dueAt,
    }],
    now: NOW,
  });
  assert.equal(counts.applied, 1, "the proposal should be recorded");

  const suggestion = getQuietCurrentSnapshot(dataDir).suggestions
    .find((item) => item.title === TITLE);
  assert.ok(suggestion, "the proposal should reach the suggestion store");
  return { dataDir, dbPath, suggestion };
}

function card(dbPath, taskId) {
  const db = new Database(dbPath, { readonly: true });
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

test("the proposed deadline is kept as a value, not only as a sentence", (t) => {
  const { suggestion } = propose(t, "2026-09-22T09:00:00-07:00");

  assert.equal(suggestion.dueDate, "2026-09-22T09:00:00-07:00");
  // And the sentence the person reads is still there, unchanged.
  assert.match(suggestion.description, /Proposed deadline, not yet confirmed: Sep 22, 2026/);
});

test("a date-only proposal keeps its day", (t) => {
  const { suggestion } = propose(t, "2026-09-22");
  assert.equal(suggestion.dueDate, "2026-09-22");
});

test("a proposal with no deadline still has none", (t) => {
  const { suggestion } = propose(t, null);
  assert.equal(suggestion.dueDate, undefined);
  assert.doesNotMatch(suggestion.description, /Proposed deadline/);
});

test("accepting it produces a card a reminder lane can reach", (t) => {
  const { dataDir, dbPath, suggestion } = propose(t, "2026-09-22T09:00:00-07:00");
  setQuietCurrentStorePathForTests(undefined);

  const accepted = acceptWorkSuggestion(suggestion.id, {
    source: "explicit_accept",
    dataDir,
  });

  assert.deepEqual(card(dbPath, accepted.taskId), {
    due_at: "2026-09-22T09:00:00-07:00",
    column_name: "Must happen today",
  });
});

test("the mandate tells the model that a suggestion takes a day", () => {
  // The schema makes every field visible and the mandate requires all of them,
  // so `due_date` was never hidden -- it was simply never explained, and the
  // sentence beside it ("use plan_update for proposed work times") reads as a
  // reason to leave it null. Same shape as finding 54 in cove-suggest.
  const mandate = readFileSync("prompts/chief-of-staff-mandate.md", "utf8");
  assert.match(mandate, /`due_date`/, "it names the field");
  assert.match(mandate, /Must happen today/, "and where an accepted proposal lands");
  assert.match(mandate, /no reminder/i, "and what an undated one costs");
});
