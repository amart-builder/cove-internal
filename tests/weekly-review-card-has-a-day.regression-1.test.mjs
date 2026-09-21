/**
 * The weekly review card was proposed into "Must happen today" with no day.
 *
 * `runChiefOfStaffReview` writes the week's review to a file and files one
 * Quiet Current proposal pointing at it. That proposal is `kind:
 * "create_task"`, so accepting it creates a real card -- in the "Must happen
 * today" column, with `due_at = dueDate ?? null`, and it passed no `dueDate`.
 *
 * Finding 54 is what that costs. Every reminder lane selects
 * `due_at IS NOT NULL` and the stale-task watchdog skips that column, so the
 * card cannot be raised by anything. And this proposal is filed once a week,
 * with a per-week claim key, so a person who accepts them and does not get to
 * them accumulates one permanently silent card per week, each one claiming to
 * be that day's work on every day that follows.
 *
 * The fix does not invent a deadline. It writes the day the card is being put
 * into, which is the day Cove has already chosen by filing it in "Must happen
 * today" -- read on the operator's clock, not the machine's, since a review
 * generated on Sunday evening in Los Angeles is still Monday in UTC.
 *
 * This is the third `create_task` caller found without a date (see also
 * findings 54 and 56), which is the argument for the structural fix recorded
 * under "Found, deliberately not fixed".
 */
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runChiefOfStaffReview } from "../src/lib/chief-of-staff/review.ts";
import {
  acceptWorkSuggestion,
  getQuietCurrentSnapshot,
} from "../src/lib/quiet-current/store.ts";

const ROOT = process.cwd();
// 6pm Sunday September 6 in Los Angeles, which is already Monday in UTC. The
// card belongs to the operator's Sunday.
const NOW = new Date("2026-09-07T01:00:00Z");
const TIMEZONE = "America/Los_Angeles";

const REVIEW = {
  score_1_to_5: 4,
  observations: ["The agent kept tasks current."],
  misses: ["One follow-up was late."],
  proposed_mandate_lines: ["Escalate overdue client follow-ups."],
  keep_doing: ["Use claim-key dedupe."],
};

async function fileReview(t) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-review-day-"));
  mkdirSync(path.join(dataDir, "operator-codex"));
  writeFileSync(
    path.join(dataDir, "operator-codex", "auth.json"),
    '{"auth":"operator"}\n',
  );
  const dbPath = path.join(dataDir, "cove.db");
  const prior = { zone: process.env.COVE_TIMEZONE, data: process.env.COVE_DATA_DIR };
  process.env.COVE_TIMEZONE = TIMEZONE;
  process.env.COVE_DATA_DIR = dataDir;
  t.after(() => {
    globalThis.__coveDb?.close();
    delete globalThis.__coveDb;
    if (prior.zone === undefined) delete process.env.COVE_TIMEZONE;
    else process.env.COVE_TIMEZONE = prior.zone;
    if (prior.data === undefined) delete process.env.COVE_DATA_DIR;
    else process.env.COVE_DATA_DIR = prior.data;
    rmSync(dataDir, { recursive: true, force: true });
  });

  await runChiefOfStaffReview({
    repoDir: ROOT,
    dataDir,
    dbPath,
    now: NOW,
    runJobImpl: async (input) => ({
      ok: true,
      lane: input.lane,
      backend: "claude",
      text: "",
      value: REVIEW,
    }),
  });

  const suggestion = getQuietCurrentSnapshot(dataDir).suggestions
    .find((item) => item.claimKey === "cos-review:2026-W36");
  assert.ok(suggestion, "the review should file one proposal");
  return { dataDir, dbPath, suggestion };
}

test("the review proposal carries the day it is proposed for", async (t) => {
  const { suggestion } = await fileReview(t);
  assert.equal(suggestion.dueDate, "2026-09-06");
});

test("accepting it produces a card a reminder lane can reach", async (t) => {
  const { dataDir, dbPath, suggestion } = await fileReview(t);

  const accepted = acceptWorkSuggestion(suggestion.id, {
    source: "explicit_accept",
    dataDir,
  });

  const db = new Database(dbPath, { readonly: true });
  try {
    assert.deepEqual(
      db.prepare(
        `SELECT tasks.due_at, task_columns.name AS column_name
           FROM tasks JOIN task_columns ON task_columns.id = tasks.column_id
          WHERE tasks.id = ?`,
      ).get(accepted.taskId),
      { due_at: "2026-09-06", column_name: "Must happen today" },
    );
  } finally {
    db.close();
  }
});
