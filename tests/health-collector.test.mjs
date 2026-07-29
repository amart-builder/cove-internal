import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectCoveHealth,
  enqueueDueHealthCollection,
  latestCoveHealthSnapshot,
} from "../src/lib/health/collector.ts";
import { openLocalDatabase } from "../src/lib/local/database.ts";
import { JobScheduler } from "../src/lib/reliability/jobs.ts";
import { recordReceipt } from "../src/lib/reliability/receipts.ts";

const NOW = new Date("2026-07-29T18:00:00.000Z");

function fixture(t) {
  const dir = path.join(
    os.tmpdir(),
    `cove-health-stage5b-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(path.join(dir, "intake"), { recursive: true });
  const dbPath = path.join(dir, "cove.db");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, dbPath };
}

test("health collector writes the deterministic system and adoption row shape", (t) => {
  const files = fixture(t);
  const db = openLocalDatabase(files.dbPath);
  try {
    db.exec(`
      CREATE TABLE day_plans (
        id TEXT PRIMARY KEY,
        arrival_interacted_at TEXT,
        confirmed_at TEXT,
        settled_at TEXT
      );
      CREATE TABLE day_plan_briefs (
        id TEXT PRIMARY KEY,
        status TEXT,
        finished_at TEXT,
        updated_at TEXT
      );
      INSERT INTO day_plans
        (id, arrival_interacted_at, confirmed_at, settled_at)
      VALUES
        ('plan-1', '2026-07-28T18:00:00.000Z', NULL,
         '2026-07-27T18:00:00.000Z');
      INSERT INTO day_plan_briefs
        (id, status, finished_at, updated_at)
      VALUES
        ('brief-1', 'succeeded', '2026-07-29T12:00:00.000Z',
         '2026-07-29T12:00:00.000Z');
      INSERT INTO email_items
        (id, status, source_payload, created_at)
      VALUES
        ('email-1', 'pending', '{"gmail_draft_id":"draft-1"}',
         '2026-07-28T18:00:00.000Z');
      INSERT INTO recurring_templates
        (id, title, cadence, active, created_at, updated_at)
      VALUES
        ('rhythm-1', 'Post', 'daily', 1,
         '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
      INSERT INTO recurring_occurrences
        (id, template_id, occurrence_local_date, state, missed_at,
         created_at, updated_at)
      VALUES
        ('occ-1', 'rhythm-1', '2026-07-28', 'missed',
         '2026-07-29T01:00:00.000Z', '2026-07-28T01:00:00.000Z',
         '2026-07-29T01:00:00.000Z');
      INSERT INTO app_state (key, value)
      VALUES ('cove.restore_test_passed', 'true');
    `);
  } finally {
    db.close();
  }
  recordReceipt({
    dbPath: files.dbPath,
    source: "email-triage",
    startedAt: "2026-07-29T15:00:00.000Z",
    finishedAt: "2026-07-29T15:01:00.000Z",
    summary: "ok",
    outcome: "success",
  });
  recordReceipt({
    dbPath: files.dbPath,
    source: "email-triage",
    startedAt: "2026-07-28T15:00:00.000Z",
    finishedAt: "2026-07-28T15:01:00.000Z",
    summary: "failed",
    outcome: "failed",
    surfaceFailure: false,
  });
  recordReceipt({
    dbPath: files.dbPath,
    source: "backup",
    startedAt: "2026-07-29T10:00:00.000Z",
    finishedAt: "2026-07-29T10:01:00.000Z",
    summary: "backup",
    outcome: "success",
  });
  writeFileSync(
    path.join(files.dir, "intake", "heartbeats.json"),
    JSON.stringify({
      version: 2,
      machines: {
        machine1: {
          meeting_watch: {
            last_run_at: "2026-07-29T17:55:00.000Z",
            disabled: false,
            errors: 0,
          },
        },
      },
    }),
  );
  writeFileSync(
    path.join(files.dir, "cove-lane-owners.json"),
    JSON.stringify({
      lanes: {
        meeting_watch: {
          id: "machine1",
          hostname_at_claim: "alex-mac.local",
        },
      },
    }),
  );

  const snapshot = collectCoveHealth({
    dbPath: files.dbPath,
    dataDir: files.dir,
    now: NOW,
  });
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "adoption",
    "collectedAt",
    "collectorVersion",
    "id",
    "system",
  ]);
  assert.deepEqual(Object.keys(snapshot.system).sort(), [
    "backup",
    "brief",
    "failureInboxCount",
    "jobs",
    "meetingLane",
    "triage",
  ]);
  assert.deepEqual(Object.keys(snapshot.adoption).sort(), [
    "daysSinceArrival",
    "daysSinceSettlement",
    "draftsWrittenLast30Days",
    "recurringStreakBreaksLast30Days",
    "staleTaskCount",
  ]);
  assert.equal(snapshot.system.triage.successRate, 0.5);
  assert.equal(snapshot.system.meetingLane.ownerId, "machine1");
  assert.equal(snapshot.system.backup.lastRestoreTestPassed, true);
  assert.equal(snapshot.adoption.daysSinceArrival, 1);
  assert.equal(snapshot.adoption.daysSinceSettlement, 2);
  assert.equal(snapshot.adoption.draftsWrittenLast30Days, 1);
  assert.equal(snapshot.adoption.recurringStreakBreaksLast30Days, 1);
  assert.deepEqual(latestCoveHealthSnapshot({ dbPath: files.dbPath }), snapshot);
});

test("the scheduler enqueues health collection only when two days have elapsed", (t) => {
  const files = fixture(t);
  openLocalDatabase(files.dbPath).close();
  const scheduler = new JobScheduler({ dbPath: files.dbPath, now: () => NOW });
  t.after(() => scheduler.close());
  const first = enqueueDueHealthCollection(scheduler, {
    dbPath: files.dbPath,
    now: NOW,
  });
  assert.deepEqual(first, { enqueued: true, reason: "due" });
  const duplicate = enqueueDueHealthCollection(scheduler, {
    dbPath: files.dbPath,
    now: NOW,
  });
  assert.deepEqual(duplicate, {
    enqueued: false,
    reason: "already-scheduled",
  });

  collectCoveHealth({ dbPath: files.dbPath, dataDir: files.dir, now: NOW });
  const recent = enqueueDueHealthCollection(scheduler, {
    dbPath: files.dbPath,
    now: new Date("2026-07-31T17:59:59.000Z"),
  });
  assert.deepEqual(recent, { enqueued: false, reason: "recent" });
});
