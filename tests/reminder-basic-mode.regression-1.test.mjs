import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openLocalDatabase } from "../src/lib/local/database.ts";

test("Basic Mode suppresses unsolicited noon reminders while Full Cove retains them", (t) => {
  const sourceRoot = path.resolve(import.meta.dirname, "..");
  const root = mkdtempSync(path.join(os.tmpdir(), "cove-basic-reminder-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "scripts/lib"), { recursive: true });
  mkdirSync(path.join(root, "home"));
  mkdirSync(path.join(root, "bin"));
  symlinkSync(path.join(sourceRoot, "src"), path.join(root, "src"));
  symlinkSync(path.join(sourceRoot, "node_modules"), path.join(root, "node_modules"));
  copyFileSync(path.join(sourceRoot, "scripts/cove-reminders.mjs"), path.join(root, "scripts/cove-reminders.mjs"));
  copyFileSync(path.join(sourceRoot, "scripts/lib/load-local-env.mjs"), path.join(root, "scripts/lib/load-local-env.mjs"));
  const calls = path.join(root, "notification-attempts");
  const notifier = path.join(root, "bin/osascript");
  writeFileSync(notifier, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$COVE_TEST_CALLS"\n');
  chmodSync(notifier, 0o700);
  const dbPath = path.join(root, "data/cove.db");
  const db = openLocalDatabase(dbPath);
  db.prepare(`INSERT INTO tasks
    (id,title,status,due_at,source_type,remind_native,remind_text,position,project,created_at,updated_at)
    VALUES ('due-task','Synthetic follow-up','open','2099-08-06','manual',0,0,0,'Cove','now','now')`).run();
  db.close();
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:COVE_|FORGE_|NEXT_PUBLIC_COVE_|NEXT_PUBLIC_FORGE_)/.test(key)));
  const env = {
    ...baseEnv,
    HOME: path.join(root, "home"),
    PATH: `${path.join(root, "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    TZ: "America/Los_Angeles",
    COVE_DB_PATH: dbPath,
    COVE_DATA_DIR: path.dirname(dbPath),
    COVE_NOTIFICATION_APP: notifier,
    COVE_REMINDER_CONFIG_PATH: path.join(root, "no-text-config.json"),
    COVE_ATTENTION_NOW: "2099-08-06T12:00:00-07:00",
    COVE_TEST_CALLS: calls,
  };
  const run = (followThrough) => {
    // Use exactly the documented private configuration, not a test-only switch.
    writeFileSync(path.join(root, ".env.local"), `COVE_CHIEF_OF_STAFF=0\nCOVE_FOLLOW_THROUGH=${followThrough}\n`);
    return spawnSync(process.execPath, ["--import", "tsx", path.join(root, "scripts/cove-reminders.mjs")], {
      cwd: root, env, encoding: "utf8",
    });
  };
  const basic = run("0");
  assert.equal(basic.status, 0, basic.stderr);
  assert.equal(existsSync(calls), false, "Basic Mode must not attempt a noon banner");
  const optedIn = openLocalDatabase(dbPath);
  optedIn.prepare("UPDATE tasks SET remind_native=1, notified_at=NULL WHERE id='due-task'").run();
  optedIn.close();
  const explicit = run("0");
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.match(readFileSync(calls, "utf8"), /Here's your reminder: Synthetic follow-up/);
  rmSync(calls);
  const full = run("1");
  assert.equal(full.status, 0, full.stderr);
  assert.match(readFileSync(calls, "utf8"), /Synthetic follow-up/);
});
