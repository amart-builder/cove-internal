/**
 * The one reminder a model picks the time for was the one with no quiet hours.
 *
 * Cove holds its own automatic notifications to daytime in three places:
 * firePredeadlineNudges in this same file returns early outside 08:00-20:00,
 * apple-reminders/bridge.mjs refuses a routine phone notification at night in
 * as many words, and validateMeetingAnalystArtifact rejects a remind_at outside
 * the same window. fireScheduledReminders had no such check. It fired whenever
 * surface_at had passed, and com.cove.reminders runs on StartInterval 60 --
 * every minute, around the clock -- sending a Mac banner and a phone text.
 *
 * surface_at is not a time the operator chose. prompts/triage.md asks the model
 * question 4, "is it urgent", and the model picks both the surface and the
 * hour, from a prompt whose only timestamp is NOW in UTC and which never
 * mentions a delivery window. A late-evening hour is a reasonable answer to
 * "when should this surface"; 3am is what it costs if the offset is misread.
 *
 * surface: "now" is deliberately exempt. It fires at the moment of capture,
 * so the person is at the machine -- holding that to 8am would break the
 * urgent path rather than protect anyone.
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
// Fixed instants, so the verdict never depends on when the suite runs.
const NIGHT = "2026-09-22T10:30:00Z"; // 03:30 in Los Angeles
const DAY = "2026-09-22T19:30:00Z";   // 12:30 in Los Angeles

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-quiet-hours-"));
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
  const file = path.join(files.dataDir, "reminders", `scheduled-${name}.json`);
  writeFileSync(file, JSON.stringify({
    id: `scheduled-${name}`,
    task_id: name,
    source: "chat",
    surface: "scheduled",
    ...entry,
  }));
  return file;
}

function runReminders(files, now, zones = {}) {
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
      COVE_ATTENTION_NOW: now,
      COVE_TIMEZONE: zones.operator ?? TIMEZONE,
      TZ: zones.machine ?? TIMEZONE,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return existsSync(files.calls) ? readFileSync(files.calls, "utf8") : "";
}

test("a scheduled reminder that comes due at 3am waits rather than firing", (t) => {
  const files = fixture(t);
  const file = schedule(files, "task-1", {
    title: "Send the revised scope",
    surface_at: "2026-09-22T03:00:00-07:00",
  });

  assert.doesNotMatch(runReminders(files, NIGHT), /Send the revised scope/);
  assert.equal(existsSync(file), true, "waiting must not mean discarded");
});

test("the same reminder is delivered at the next daytime pass", (t) => {
  const files = fixture(t);
  const file = schedule(files, "task-1", {
    title: "Send the revised scope",
    surface_at: "2026-09-22T03:00:00-07:00",
  });

  assert.match(runReminders(files, DAY), /Send the revised scope/);
  assert.equal(existsSync(file), false, "consumed once delivered");
});

test("a daytime reminder is unaffected", (t) => {
  const files = fixture(t);
  const file = schedule(files, "task-2", {
    title: "Call the supplier back",
    surface_at: "2026-09-22T11:00:00-07:00",
  });

  assert.match(runReminders(files, DAY), /Call the supplier back/);
  assert.equal(existsSync(file), false);
});

test("a reminder not yet due is still not delivered", (t) => {
  const files = fixture(t);
  const file = schedule(files, "task-3", {
    title: "Not yet",
    surface_at: "2026-09-23T11:00:00-07:00",
  });

  assert.doesNotMatch(runReminders(files, DAY), /Not yet/);
  assert.equal(existsSync(file), true);
});

test("an urgent capture still reaches the person at any hour", (t) => {
  // surface: "now" is written at the moment of capture, so the person is at
  // the machine. This is the case the window must not touch.
  const files = fixture(t);
  const file = schedule(files, "task-4", {
    title: "Wire transfer needs approving",
    surface: "now",
    surface_at: "2026-09-22T03:00:00-07:00",
  });

  assert.match(runReminders(files, NIGHT), /Wire transfer needs approving/);
  assert.equal(existsSync(file), false);
});

test("an entry with no recorded surface is treated as scheduled", (t) => {
  // Older files on disk predate the field. The safe reading of an unknown
  // origin is the one that does not ring at 3am.
  const files = fixture(t);
  const file = path.join(files.dataDir, "reminders", "scheduled-task-5.json");
  writeFileSync(file, JSON.stringify({
    id: "scheduled-task-5",
    task_id: "task-5",
    title: "Legacy entry",
    surface_at: "2026-09-22T03:00:00-07:00",
    source: "chat",
  }));

  assert.doesNotMatch(runReminders(files, NIGHT), /Legacy entry/);
  assert.equal(existsSync(file), true);
});

test("the window is the operator's hour, not the machine's", (t) => {
  // A Mac set to one zone and an operator profile set to another is the
  // ordinary case for anyone who travels, and the whole point of
  // operatorTimezone(). At this instant it is noon in Tokyo and 20:00 in Los
  // Angeles, so the two zones disagree about whether the window is open.
  const files = fixture(t);
  const file = schedule(files, "task-6", {
    title: "Tokyo morning item",
    surface_at: "2026-09-22T00:00:00Z",
  });

  const text = runReminders(files, "2026-09-22T03:00:00Z", {
    operator: "Asia/Tokyo",
    machine: "America/Los_Angeles",
  });
  assert.match(text, /Tokyo morning item/, "the operator's noon is inside the window");
  assert.equal(existsSync(file), false);
});

test("an unusable timezone must not silently mute every reminder", (t) => {
  // localHour returns NaN for a zone Intl cannot read, and
  // insideNudgeDeliveryWindow answers false for NaN -- which would defer every
  // scheduled reminder forever, with nothing failing and nothing logged.
  // operatorTimezone() is what stops that: it validates through Intl and falls
  // back to UTC. This pins that guarantee, because the cost of losing it is
  // every reminder silently disabled rather than one arriving late.
  const files = fixture(t);
  const file = schedule(files, "task-7", {
    title: "Still delivered",
    surface_at: "2026-09-22T00:00:00Z",
  });

  // 19:30 UTC, inside the window once the fallback lands on UTC.
  const text = runReminders(files, "2026-09-22T19:30:00Z", {
    operator: "Not/AZone",
    machine: "Not/AZone",
  });
  assert.match(text, /Still delivered/);
  assert.equal(existsSync(file), false);
});
