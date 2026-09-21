/**
 * Moving a due date used to retire that task's reminder for good.
 *
 * The due reminder is a one-shot. `fireDueReminders` selects
 * `WHERE tasks.status = 'open' AND tasks.notified_at IS NULL` and stamps
 * `notified_at` as it claims each row, so a task that has been announced once
 * is never announced again.
 *
 * That is correct until the deadline moves. The stamp means "the person has
 * been told about this task's deadline", and a rescheduled task has a
 * different deadline — one nobody has been told about. Nothing cleared the
 * stamp: not the board, not the Today view, not the REST route. So the most
 * ordinary action on a board, dragging an overdue card to a later date,
 * silently turned its reminder off. The card stayed, the new date arrived, and
 * nothing rang.
 *
 * The rule already existed for the other half of the pair. A few lines below
 * this fix in src/lib/local/db.ts, a `remind_at` that moves clears `nudged_at`,
 * which is the same re-arm for the pre-deadline nudge. It was never written for
 * the stamp that guards the reminder people actually rely on, and
 * skills/cove-task/SKILL.md carries a hand-written workaround for it — "if you
 * ever change a task's due_at later, also set notified_at: null in the same
 * PATCH" — which is only ever read by an agent, never by the person clicking
 * the date field.
 *
 * Instants are compared rather than strings, because `due_at` has no canonical
 * form: the board writes a calendar date at UTC midnight, while intake and the
 * skills write local ISO datetimes. `remind_at` can compare as a string only
 * because validateTaskTiming forces it into one exact shape.
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

const require = createRequire(import.meta.url);
require("tsx/cjs");
const { runLocalMigrations } = require("../src/lib/local/migrations.ts");
const { handleLocalRest } = require("../src/lib/local/db.ts");

const TIMEZONE = "America/Los_Angeles";
const FIRST_PASS = "2026-09-22T17:30:00Z"; // 10:30 Los Angeles
const SECOND_PASS = "2026-09-25T17:30:00Z"; // three days later
const DUE_FIRST = "2026-09-22T00:00:00.000Z";
const DUE_MOVED = "2026-09-25T00:00:00.000Z";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-due-rearm-"));
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

  const prior = {
    db: process.env.COVE_DB_PATH,
    runtime: process.env.NEXT_PUBLIC_COVE_RUNTIME,
    timezone: process.env.COVE_TIMEZONE,
  };
  const priorDb = globalThis.__coveDb;
  delete globalThis.__coveDb;
  process.env.COVE_DB_PATH = dbPath;
  process.env.NEXT_PUBLIC_COVE_RUNTIME = "local";
  process.env.COVE_TIMEZONE = TIMEZONE;
  t.after(() => {
    globalThis.__coveDb?.close();
    if (priorDb === undefined) delete globalThis.__coveDb;
    else globalThis.__coveDb = priorDb;
    if (prior.db === undefined) delete process.env.COVE_DB_PATH;
    else process.env.COVE_DB_PATH = prior.db;
    if (prior.runtime === undefined) delete process.env.NEXT_PUBLIC_COVE_RUNTIME;
    else process.env.NEXT_PUBLIC_COVE_RUNTIME = prior.runtime;
    if (prior.timezone === undefined) delete process.env.COVE_TIMEZONE;
    else process.env.COVE_TIMEZONE = prior.timezone;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, bin, calls, dbPath, dataDir };
}

function addTask(id, overrides = {}) {
  return handleLocalRest("tasks", "POST", new URLSearchParams(), {
    id,
    title: "File the quarterly return",
    due_at: DUE_FIRST,
    status: "open",
    ...overrides,
  }).body[0];
}

function patch(id, body) {
  return handleLocalRest(
    "tasks",
    "PATCH",
    new URLSearchParams(`id=eq.${id}`),
    body,
  ).body[0];
}

function runReminders(files, now) {
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
  const log = existsSync(files.calls) ? readFileSync(files.calls, "utf8") : "";
  writeFileSync(files.calls, "");
  return log;
}

test("a due date the person moves re-arms the reminder", (t) => {
  fixture(t);
  addTask("rearm-forward", { notified_at: "2026-09-22T16:00:00.000Z" });

  const moved = patch("rearm-forward", { due_at: DUE_MOVED });

  assert.equal(moved.due_at, DUE_MOVED);
  assert.equal(moved.notified_at, null, "the old announcement is no longer true");
});

test("the same instant written a different way is not a reschedule", (t) => {
  fixture(t);
  addTask("rearm-same", { notified_at: "2026-09-22T16:00:00.000Z" });

  // The board stores a calendar date at UTC midnight; intake and the skills
  // write local ISO datetimes. These two strings are the same moment, and a
  // string comparison would call it a move.
  const rewritten = patch("rearm-same", { due_at: "2026-09-21T17:00:00-07:00" });

  assert.equal(
    rewritten.notified_at,
    "2026-09-22T16:00:00.000Z",
    "no deadline changed, so nothing is re-announced",
  );
});

test("an edit that leaves the deadline alone leaves the stamp alone", (t) => {
  fixture(t);
  addTask("rearm-title", { notified_at: "2026-09-22T16:00:00.000Z" });

  const renamed = patch("rearm-title", { title: "File the quarterly return (VAT)" });

  assert.equal(renamed.notified_at, "2026-09-22T16:00:00.000Z");
});

test("giving a previously undated task a deadline arms it", (t) => {
  fixture(t);
  addTask("rearm-undated", {
    due_at: null,
    notified_at: "2026-09-22T16:00:00.000Z",
  });

  const dated = patch("rearm-undated", { due_at: DUE_MOVED });

  assert.equal(dated.notified_at, null);
});

test("a deadline moved backwards re-arms too, because that is still a new deadline", (t) => {
  fixture(t);
  addTask("rearm-backward", {
    due_at: DUE_MOVED,
    notified_at: "2026-09-22T16:00:00.000Z",
  });

  // Deliberate, and worth stating: pulling a card forward means the person
  // has just said it is due sooner than Cove last told them, which is exactly
  // the case a reminder exists for. The due lane honours the time on the card,
  // so an already-past deadline announces itself on the next pass.
  const pulled = patch("rearm-backward", { due_at: DUE_FIRST });

  assert.equal(pulled.notified_at, null);
});

test("end to end: reschedule an announced task and the new date announces itself", (t) => {
  const files = fixture(t);
  addTask("rearm-live");

  const first = runReminders(files, FIRST_PASS);
  assert.match(first, /File the quarterly return/, "the original deadline rang");
  assert.equal(
    handleLocalRest(
      "tasks",
      "GET",
      new URLSearchParams("id=eq.rearm-live"),
    ).body[0].notified_at !== null,
    true,
    "and was stamped, so it will not ring twice for the same date",
  );

  assert.equal(runReminders(files, FIRST_PASS), "", "no second ring for the same date");

  patch("rearm-live", { due_at: DUE_MOVED });

  assert.match(
    runReminders(files, SECOND_PASS),
    /File the quarterly return/,
    "the new deadline rings on its own day",
  );
});
