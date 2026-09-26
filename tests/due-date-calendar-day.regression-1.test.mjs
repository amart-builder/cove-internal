/**
 * A due date picked on the board rang the evening before.
 *
 * Cove's own date pickers store a calendar date as that date at UTC midnight.
 * `toSupabaseDueAt` in KanbanBoard.tsx does it, TodayView.tsx does the same,
 * and the comment beside it explains why: the read path slices the date off
 * the front of the string, so storing local midnight would show an operator at
 * or ahead of UTC the day before the one they picked.
 *
 * That is right for display and wrong for every lane that asks *when* the
 * deadline is. `2026-10-02T00:00:00.000Z` is 5pm on October 1 in Los Angeles,
 * so for a card the board labels October 2:
 *
 *   - the due reminder rang at 17:00 on October 1;
 *   - the attention floor said "Due today and still open in Cove" at lunchtime
 *     on October 1, contradicting the board on the same screen;
 *   - the follow-through lane's advance banner landed an hour before that, and
 *     its overdue stage a day early;
 *   - the pre-deadline nudge's "is this still in the future" gate closed a day
 *     early too.
 *
 * Everyone west of UTC — which is everyone in the Americas — got this on the
 * first due date they set.
 *
 * The encoding is not ambiguous in practice. Those two components are the only
 * writers of an exact UTC midnight; intake, the meeting analyst and the skills
 * all write an offset timestamp or a bare calendar date. So the lanes now read
 * it as what it is: a day, treated exactly like the bare `YYYY-MM-DD` form
 * they already understood, which means 9am in the operator's own morning.
 *
 * A fifth reader, found by sweeping the rule rather than by the symptom:
 * `taskDueToday` in the progress reconciler, which runs on its own LaunchAgent
 * every thirty minutes. It already handled the bare form and not this one, so
 * a project whose only signal was "something is due today" was reconciled on
 * the day before the deadline and not on the day of it.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { dueCalendarDay } from "../src/lib/attention/due-date.mjs";

const require = createRequire(import.meta.url);
require("tsx/cjs");
const { runLocalMigrations } = require("../src/lib/local/migrations.ts");

const TIMEZONE = "America/Los_Angeles";
// What the board stores when the person picks October 2 in the date field.
const PICKED_OCTOBER_2 = "2026-10-02T00:00:00.000Z";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-due-day-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const calls = path.join(dir, "calls.log");
  writeFileSync(
    path.join(bin, "osascript"),
    "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$COVE_TEST_CALLS\"\n",
  );
  chmodSync(path.join(bin, "osascript"), 0o700);
  const dbPath = path.join(dir, "cove.db");
  const db = new Database(dbPath);
  runLocalMigrations(db);
  db.close();
  const dataDir = path.join(dir, "data");
  mkdirSync(path.join(dataDir, "reminders"), { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, bin, calls, dbPath, dataDir };
}

function addTask(files, overrides = {}) {
  const db = new Database(files.dbPath);
  const row = {
    id: "roof-bid",
    title: "Call Joe about the roof bid",
    due_at: PICKED_OCTOBER_2,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO tasks (id, title, status, source_type, due_at, remind_native,
                        remind_text, created_at, updated_at)
     VALUES (?, ?, 'open', 'manual', ?, 1, 0, ?, ?)`,
  ).run(row.id, row.title, row.due_at, "2026-09-21T00:00:00.000Z", "2026-09-21T00:00:00.000Z");
  db.close();
}

function runReminders(files, now) {
  try {
    rmSync(files.calls);
  } catch {
    // First pass; nothing to clear.
  }
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/cove-reminders.mjs"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${files.bin}:${process.env.PATH}`,
        COVE_DB_PATH: files.dbPath,
        COVE_DATA_DIR: files.dataDir,
        COVE_REMINDER_CONFIG_PATH: path.join(files.dir, "missing-reminders.json"),
        COVE_TEST_CALLS: files.calls,
        COVE_NOTIFICATION_APP: "/nonexistent",
        COVE_ATTENTION_NOW: now,
        COVE_TIMEZONE: TIMEZONE,
        TZ: TIMEZONE,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return existsSync(files.calls) ? readFileSync(files.calls, "utf8") : "";
}

test("the picked day is read off the string, not off the instant", () => {
  assert.equal(dueCalendarDay(PICKED_OCTOBER_2), "2026-10-02");
  assert.equal(dueCalendarDay("2026-10-02T00:00:00Z"), "2026-10-02");
  assert.equal(dueCalendarDay("2026-10-02"), "2026-10-02");
  // A real time of day is an instant and stays one.
  assert.equal(dueCalendarDay("2026-10-02T15:00:00"), null);
  assert.equal(dueCalendarDay("2026-10-02T00:30:00.000Z"), null);
  assert.equal(dueCalendarDay("2026-10-02T00:00:00-07:00"), null);
  assert.equal(dueCalendarDay(null), null);
  assert.equal(dueCalendarDay(""), null);
});

test("a card the board labels October 2 does not ring on October 1", (t) => {
  const files = fixture(t);
  addTask(files);

  // 17:30 in Los Angeles on October 1 — half an hour past the stored instant.
  assert.equal(runReminders(files, "2026-10-02T00:30:00Z"), "");
});

test("it rings on October 2, in the operator's own morning", (t) => {
  const files = fixture(t);
  addTask(files);

  assert.equal(runReminders(files, "2026-10-02T15:30:00Z"), "", "08:30, before 9am");
  assert.match(
    runReminders(files, "2026-10-02T16:30:00Z"),
    /Here's your reminder: Call Joe about the roof bid/,
    "09:30 on the day the board shows",
  );
});

test("the floor does not say \"due today\" the day before the board does", (t) => {
  const files = fixture(t);
  addTask(files);

  // 13:30 in Los Angeles on October 1. The floor runs from noon, and this is
  // the contradiction that was on screen: the banner said today, the card
  // said tomorrow.
  assert.doesNotMatch(runReminders(files, "2026-10-01T20:30:00Z"), /Due today/);
  assert.match(
    runReminders(files, "2026-10-02T20:30:00Z"),
    /Due today and still open in Cove: Call Joe about the roof bid/,
    "and it does say it on the right day",
  );
});

test("a deadline with a real time of day is untouched", (t) => {
  const files = fixture(t);
  // What the cove-task skill writes for "Friday at 3pm": a local ISO datetime.
  addTask(files, { due_at: "2026-10-02T15:00:00" });

  // The floor legitimately speaks from noon about anything due today, so this
  // reads the due reminder's own line rather than the whole log.
  const reminderLines = (now) =>
    runReminders(files, now).split("\n").filter((line) => line.includes("Your reminder"));

  assert.deepEqual(reminderLines("2026-10-02T21:30:00Z"), [], "14:30, before it is due");
  assert.match(
    reminderLines("2026-10-02T22:30:00Z")[0] ?? "",
    /Here's your reminder/,
    "15:30, just after",
  );
});

test("the progress reconciler asks about the day the board shows", async () => {
  const { taskDueToday, shouldProcessProject } = await import(
    "../scripts/cove-progress-reconcile.mjs"
  );
  const picked = { due_at: PICKED_OCTOBER_2 };

  assert.equal(taskDueToday(picked, "2026-10-01", TIMEZONE), false);
  assert.equal(taskDueToday(picked, "2026-10-02", TIMEZONE), true);

  // Its gate is what the bug actually cost: a project with no other signal was
  // looked at on the wrong day, and skipped on the day the deadline landed.
  const noPings = { pings: [] };
  assert.equal(shouldProcessProject(noPings, [picked], "2026-10-01", TIMEZONE), false);
  assert.equal(shouldProcessProject(noPings, [picked], "2026-10-02", TIMEZONE), true);

  // The two forms it already read correctly still read the same way.
  assert.equal(taskDueToday({ due_at: "2026-10-02" }, "2026-10-02", TIMEZONE), true);
  assert.equal(
    taskDueToday({ due_at: "2026-10-02T15:00:00" }, "2026-10-02", TIMEZONE),
    true,
  );
  assert.equal(taskDueToday({ due_at: null }, "2026-10-02", TIMEZONE), false);
});
