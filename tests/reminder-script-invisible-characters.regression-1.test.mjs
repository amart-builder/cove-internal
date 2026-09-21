/**
 * The reminder script carries its own copy of the banner sanitizer, and the
 * copy was not the one that got fixed.
 *
 * src/lib/attention/safety.mjs learned on 2026-09-21 to remove the invisible
 * and bidi characters that walked a domain past its URL rules. But
 * scripts/cove-reminders.mjs does not import it: plainAttentionText and
 * sanitizedNonDirectText in that file were byte-for-byte copies of the pair in
 * safety.mjs as they stood before the fix, so the same bypass stayed open on
 * the path that runs every minute from com.cove.reminders.
 *
 * That path is the worse one. The library copy feeds a Mac banner; this copy
 * also feeds deliverTextReminder, which sends Telegram and iMessage, so the
 * spoofed text arrives on the person's phone where Cove's provenance label is
 * the only thing telling them it did not come from Cove.
 *
 * U+2060 WORD JOINER renders as nothing and breaks the label-dot-label shape
 * the domain rule matches, so "Visit evil<U+2060>.example now" reached the
 * screen reading "Visit evil.example now". U+202E reverses what follows it, so
 * what Cove stored and what the person read were two different strings.
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
// A fixed instant, so the verdict never depends on when the suite runs.
const NOW = "2026-09-22T19:30:00Z"; // 12:30 in Los Angeles
const PAST = "2026-09-22T11:00:00-07:00";

// What the eye sees. The assertions run against this rather than against the
// raw delivery, because a character that renders as nothing cannot defend a
// domain: the question is only ever what the person reads.
const INVISIBLE = /[­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const asRead = (value) => value.replace(INVISIBLE, "");

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-invisible-"));
  const bin = path.join(dir, "bin");
  const calls = path.join(dir, "calls.log");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "osascript"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$COVE_TEST_CALLS\"\n");
  chmodSync(path.join(bin, "osascript"), 0o700);
  const dbPath = path.join(dir, "cove.db");
  const db = new Database(dbPath);
  runLocalMigrations(db);
  const dataDir = path.join(dir, "data");
  mkdirSync(path.join(dataDir, "reminders"), { recursive: true });
  t.after(() => {
    try { db.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, bin, calls, dbPath, dataDir, db };
}

function dueTask(files, { id, title, source }) {
  files.db
    .prepare(
      `INSERT INTO tasks (id, title, status, due_at, source_type, remind_native, remind_text)
       VALUES (?, ?, 'open', ?, ?, 1, 0)`,
    )
    .run(id, title, PAST, source ? "inbound_event" : "manual");
  if (source) {
    files.db
      .prepare(
        `INSERT INTO inbound_events (id, source, source_id, raw_text, state, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'triaged', 1, ?, ?)`,
      )
      .run(id, source, `${id}-src`, title, NOW, NOW);
  }
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

test("a word joiner does not walk a domain past the reminder script's sanitizer", (t) => {
  const files = fixture(t);
  dueTask(files, {
    id: "task-joiner",
    title: "Confirm your account at evil⁠.example today",
    source: "email",
  });

  const delivered = asRead(runReminders(files));
  assert.match(delivered, /from email/, "the banner must still be delivered and labelled");
  assert.doesNotMatch(delivered, /evil\.example/, "the domain must not reach the person");
});

test("the other invisible spacers are closed too", (t) => {
  const files = fixture(t);
  dueTask(files, {
    id: "task-spacers",
    title: "Pay at one​.example and two﻿.example and three­.example",
    source: "email",
  });

  const delivered = asRead(runReminders(files));
  assert.doesNotMatch(delivered, /one\.example/);
  assert.doesNotMatch(delivered, /two\.example/);
  assert.doesNotMatch(delivered, /three\.example/);
});

test("a bidi override cannot make the banner read differently from what Cove stored", (t) => {
  const files = fixture(t);
  dueTask(files, {
    id: "task-bidi",
    title: "Invoice ‮paid‬ now",
    source: "email",
  });

  const delivered = runReminders(files);
  assert.doesNotMatch(delivered, /[‪-‮⁦-⁩]/, "no bidi control may reach the screen");
});

test("a title the owner wrote is cleaned the same way", (t) => {
  const files = fixture(t);
  dueTask(files, {
    id: "task-direct",
    title: "Check ‮thing‬ at mine⁠.example",
    source: "chat",
  });

  const delivered = runReminders(files);
  assert.doesNotMatch(delivered, /[‪-‮⁦-⁩]/);
  // A direct title keeps its content by design, so the domain survives here.
  // What must not survive is the invisible character that hid it.
  assert.match(delivered, /mine\.example/);
});

test("an ordinary title is untouched", (t) => {
  const files = fixture(t);
  dueTask(files, { id: "task-plain", title: "Send the revised scope", source: "email" });

  assert.match(runReminders(files), /from email: Send the revised scope/);
});
