/**
 * A scheduled reminder must be read from the directory the intake lane wrote
 * it to.
 *
 * Intake resolves its data directory as COVE_DATA_DIR first and the database's
 * directory only as a fallback; the reminder runner read the database's
 * directory alone. On an install where the two differ, every `surface:
 * "scheduled"` reminder was written somewhere nothing ever looked. Nothing
 * failed and nothing was recorded: the commitment simply never came back.
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

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-scheduled-reminder-"));
  const bin = path.join(dir, "bin");
  const calls = path.join(dir, "calls.log");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "osascript"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$COVE_TEST_CALLS\"\n");
  chmodSync(path.join(bin, "osascript"), 0o700);
  const dbPath = path.join(dir, "cove.db");
  const db = new Database(dbPath);
  runLocalMigrations(db);
  db.close();
  // The configuration this is about: a data directory that is not the
  // database's own directory.
  const dataDir = path.join(dir, "selected-data");
  mkdirSync(path.join(dataDir, "reminders"), { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, bin, calls, dbPath, dataDir };
}

test("a scheduled reminder in the configured data directory still fires", (t) => {
  const files = fixture(t);
  const reminder = path.join(files.dataDir, "reminders", "scheduled-task-1.json");
  writeFileSync(reminder, JSON.stringify({
    id: "scheduled-task-1",
    task_id: "task-1",
    title: "Send the revised scope",
    surface_at: "2020-01-02T09:00:00-08:00",
    source: "chat",
  }));

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
      // The runner holds a scheduled reminder outside 08:00-20:00 operator
      // time. This case is about which directory is read, not the window, so
      // its clock is pinned rather than left to read the wall clock.
      COVE_ATTENTION_NOW: "2026-09-22T19:30:00Z",
      COVE_TIMEZONE: "America/Los_Angeles",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    existsSync(files.calls) ? readFileSync(files.calls, "utf8") : "",
    /Send the revised scope/,
    "the person is notified",
  );
  assert.equal(existsSync(reminder), false, "the reminder is consumed, not left to fire again");
});
