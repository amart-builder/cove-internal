/**
 * The scheduled reminder was the one banner nobody labelled.
 *
 * Every other path in scripts/cove-reminders.mjs decides whether the person
 * wrote the words before it puts them on screen. The due lane says so in a
 * comment at its notifyNative call -- "a title written by someone else is
 * sanitized and labelled before it borrows Cove's credibility" -- and the
 * attention floor does the same. fireScheduledReminders did neither. It read
 * `entry.title || "Task"` and handed it straight to notifyNative, so a banner
 * saying "Here's your reminder: Confirm your account at pay.example" arrived
 * carrying Cove's name and nothing to say the words were not Cove's.
 *
 * entry.title is written by the triage model from captured text. For a capture
 * that came from email, that text is a third party's.
 *
 * Note what this does not change. The text branch a few lines below already
 * sends CONTENT_FREE_REMINDER for a non-direct source, so the phone was never
 * the exposure here; the Mac banner was.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("tsx/cjs");
const { runLocalMigrations } = require("../src/lib/local/migrations.ts");

const TIMEZONE = "America/Los_Angeles";
const NOW = "2026-09-22T19:30:00Z";  // 12:30 in Los Angeles, inside the window
const PAST = "2026-09-22T11:00:00-07:00";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-sched-banner-"));
  const bin = path.join(dir, "bin");
  const calls = path.join(dir, "calls.log");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "osascript"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$COVE_TEST_CALLS\"\n");
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

function schedule(files, name, entry) {
  writeFileSync(path.join(files.dataDir, "reminders", `scheduled-${name}.json`), JSON.stringify({
    id: `scheduled-${name}`,
    task_id: name,
    surface: "scheduled",
    surface_at: PAST,
    ...entry,
  }));
}

function runReminders(files) {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/cove-reminders.mjs"], {
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
      COVE_ATTENTION_NOW: NOW,
      COVE_TIMEZONE: TIMEZONE,
      TZ: TIMEZONE,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return existsSync(files.calls) ? readFileSync(files.calls, "utf8") : "";
}

test("an email-sourced scheduled reminder says where the words came from", (t) => {
  const files = fixture(t);
  schedule(files, "task-email", { source: "email", title: "Approve the invoice" });

  assert.match(runReminders(files), /from email: Approve the invoice/);
});

test("it carries no address the person could act on", (t) => {
  const files = fixture(t);
  schedule(files, "task-phish", {
    source: "email",
    title: "Confirm your account at pay.example or call +1 (555) 010-9999",
  });

  const delivered = runReminders(files);
  assert.doesNotMatch(delivered, /pay\.example/, "no domain");
  assert.doesNotMatch(delivered, /555/, "no phone number");
  assert.match(delivered, /from email/, "still labelled and still delivered");
});

test("a meeting-sourced one is labelled from meeting", (t) => {
  const files = fixture(t);
  schedule(files, "task-meeting", { source: "meeting", title: "Send Dana the deck" });

  assert.match(runReminders(files), /from meeting: Send Dana the deck/);
});

test("a reminder with no recorded source is treated as outside words", (t) => {
  const files = fixture(t);
  schedule(files, "task-unknown", { title: "Wire the deposit to acct.example" });

  const delivered = runReminders(files);
  assert.doesNotMatch(delivered, /acct\.example/);
  assert.match(delivered, /from unknown source/);
});

test("a reminder the owner wrote keeps its words and its plain shape", (t) => {
  const files = fixture(t);
  schedule(files, "task-mine", { source: "chat", title: "Book the flights at united.example" });

  const delivered = runReminders(files);
  assert.match(delivered, /Here's your reminder: Book the flights at united\.example/);
  assert.doesNotMatch(delivered, /from you/, "a direct title is not relabelled");
});

test("an empty title still produces a usable banner", (t) => {
  const files = fixture(t);
  schedule(files, "task-empty", { source: "email", title: "" });

  assert.match(runReminders(files), /from email: Open Cove to review this item\./);
});
