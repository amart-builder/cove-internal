/**
 * The Issues screen quoted an email's words as though Cove had written them.
 *
 * Findings 46 to 51 are one rule with four gaps: a title written by someone
 * else is sanitized and labelled before it borrows Cove's credibility. The
 * fifth gap is on the path nobody looks at until something has already gone
 * wrong. When a native notification fails to deliver, `recordNativeOnlyFailure`
 * writes a row into the failure inbox with the task's **raw** title -- every
 * call site has already computed the sanitized, labelled variant to put on the
 * banner, and then passes the other one. `reminderFailureMessage`
 * (`src/lib/reliability/failures.ts:35`) renders that straight onto the Issues
 * screen:
 *
 *     Reminder: “Confirm your account at pay.example”. Cove could not confirm
 *     the Mac notification. You can review the reminder in Cove.
 *
 * Quotation marks are not a provenance label. The screen is Cove's own, the
 * sentence around the title is Cove's own, and nothing in it says the words in
 * the middle came from an email a stranger sent. It is the same failure the
 * banner had, on the screen a person goes to precisely because they have been
 * told something is wrong.
 *
 * The raw title is not lost: the failure row's details still carry the task id,
 * and the task row still has its own title for anyone investigating.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("tsx/cjs");
const { runLocalMigrations } = require("../src/lib/local/migrations.ts");
const { listFailures } = require("../src/lib/reliability/failures.ts");

const TIMEZONE = "America/Los_Angeles";
// 12:30 in Los Angeles: inside every delivery window, and past a 9am deadline.
const NOW = "2026-09-22T19:30:00Z";
const HOSTILE = "Confirm your account at pay.example";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-failed-report-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  // Every native notification in this fixture fails, which is the whole point.
  writeFileSync(path.join(bin, "osascript"), "#!/bin/sh\nexit 1\n");
  chmodSync(path.join(bin, "osascript"), 0o700);
  const dbPath = path.join(dir, "cove.db");
  const db = new Database(dbPath);
  runLocalMigrations(db);
  db.prepare(
    `INSERT INTO tasks (id, title, status, source_type, due_at, remind_native,
                        remind_text, created_at, updated_at)
     VALUES (?, ?, 'open', 'inbound_event', '2026-09-22', 1, 0, ?, ?)`,
  ).run("invoice", HOSTILE, "2026-09-21T00:00:00.000Z", "2026-09-21T00:00:00.000Z");
  db.prepare(
    `INSERT INTO inbound_events (id, source, source_id, raw_text, state, task_id,
                                 created_at, updated_at)
     VALUES (?, 'email', ?, ?, 'triaged', ?, ?, ?)`,
  ).run("invoice", "msg-1", HOSTILE, "invoice",
    "2026-09-21T00:00:00.000Z", "2026-09-21T00:00:00.000Z");
  db.close();
  const dataDir = path.join(dir, "data");
  mkdirSync(path.join(dataDir, "reminders"), { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, bin, dbPath, dataDir };
}

function run(files) {
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
        COVE_NOTIFICATION_APP: "/nonexistent",
        COVE_ATTENTION_NOW: NOW,
        COVE_TIMEZONE: TIMEZONE,
        TZ: TIMEZONE,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
}

function reminderIssues(files) {
  const prior = globalThis.__coveDb;
  delete globalThis.__coveDb;
  try {
    return listFailures({ dbPath: files.dbPath })
      .filter((item) => item.source === "reminder-delivery");
  } finally {
    globalThis.__coveDb?.close();
    if (prior === undefined) delete globalThis.__coveDb;
    else globalThis.__coveDb = prior;
  }
}

test("a failed reminder for an email capture says where the words came from", (t) => {
  const files = fixture(t);

  run(files);
  const issues = reminderIssues(files);

  assert.ok(issues.length > 0, "a failed native delivery should reach the Issues screen");
  for (const issue of issues) {
    assert.match(
      issue.message,
      /from email/,
      "the person is told whose words these are",
    );
    assert.doesNotMatch(
      issue.message,
      /pay\.example/,
      "and the domain is stripped, exactly as it is on the banner",
    );
  }
});

test("the person's own words are still their own on that screen", (t) => {
  const files = fixture(t);
  const db = new Database(files.dbPath);
  db.prepare("UPDATE tasks SET title=?, source_type='manual' WHERE id='invoice'")
    .run("Call Joe about the roof bid");
  db.prepare("DELETE FROM inbound_events WHERE id='invoice'").run();
  db.close();

  run(files);
  const issues = reminderIssues(files);

  assert.ok(issues.length > 0);
  for (const issue of issues) {
    assert.match(issue.message, /Call Joe about the roof bid/);
    assert.doesNotMatch(issue.message, /from email|from unknown source/);
  }
});
