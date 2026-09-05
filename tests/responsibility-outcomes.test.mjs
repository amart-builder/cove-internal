import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openLocalDatabase } from "../src/lib/local/database.ts";
import {
  reconcileResponsibilities,
  listResponsibilities,
  responsibilityDesk,
  markResponsibilitiesReviewed,
  sourceRecord,
  sourceVersion,
  updateResponsibility,
  savePreparation,
  acknowledgeResponsibility,
} from "../src/lib/responsibility/store.ts";
import {
  assessCapacity,
  localHour,
} from "../src/lib/responsibility/planning.ts";
import { applyChiefOfStaffActions } from "../src/lib/chief-of-staff/driver.ts";
import { enqueueChiefOfStaffWake } from "../src/lib/chief-of-staff/storage.ts";
const now = new Date("2026-09-03T16:00:00Z");
function fixture(t) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-outcomes-"));
  const dbPath = path.join(dataDir, "cove.db");
  const db = openLocalDatabase(dbPath);
  t.after(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { db, dbPath, dataDir };
}
function task(db, id, values = {}) {
  db.prepare(
    "INSERT INTO tasks(id,title,status,priority,due_at,created_at,updated_at) VALUES(?,?,'open',?,?,?,?)",
  ).run(
    id,
    values.title ?? id,
    values.priority ?? "medium",
    values.due ?? null,
    values.created ?? now.toISOString(),
    now.toISOString(),
  );
}
function patch(row, extra = {}) {
  return {
    ref_kind: row.ref_kind,
    ref_id: row.ref_id,
    expected_version: row.source_version,
    expected_revision: row.revision,
    next_action: "Draft the three key points.",
    owner: "you",
    state: "ready",
    next_check_at: new Date(+now + 86400000).toISOString(),
    ...extra,
  };
}
test("original deadline, source quote and next check survive restart, planning and source edits", (t) => {
  const { db, dbPath } = fixture(t);
  task(db, "proposal", { due: "2026-09-04" });
  reconcileResponsibilities(db, now);
  let row = listResponsibilities(db)[0];
  updateResponsibility(
    db,
    patch(row, { planned_for: "2026-09-03T22:00:00Z", estimate_minutes: 45 }),
    now,
  );
  const reopened = openLocalDatabase(dbPath);
  assert.equal(
    listResponsibilities(reopened)[0].planned_for,
    "2026-09-03T22:00:00Z",
  );
  reopened.close();
  assert.equal(sourceRecord(db, "task", "proposal").due_at, "2026-09-04");
  db.prepare("UPDATE tasks SET due_at='2026-09-10' WHERE id='proposal'").run();
  reconcileResponsibilities(db, now);
  row = listResponsibilities(db)[0];
  assert.equal(row.original_due_at, "2026-09-04");
  assert.equal(row.due_at, "2026-09-10");
  assert.equal(row.last_reviewed_at, null);
  db.prepare("UPDATE tasks SET status='done' WHERE id='proposal'").run();
  reconcileResponsibilities(db, now);
  assert.equal(listResponsibilities(db).length, 0);
});
test("new and undated important work survives a large overdue backlog; only actually rendered rows are reviewed", (t) => {
  const { db } = fixture(t);
  for (let i = 0; i < 100; i++)
    task(db, `old-${i}`, {
      due: "2026-08-01",
      title: "Long old task ".repeat(40),
      created: "2026-08-01T00:00:00Z",
    });
  task(db, "zzz-new");
  task(db, "strategic", { priority: "high" });
  const first = responsibilityDesk(db, now, 8000);
  assert.ok(first.text.length <= 8000);
  assert.ok(first.seen.some((r) => r.ref_id === "zzz-new"));
  assert.ok(first.seen.some((r) => r.ref_id === "strategic"));
  assert.ok(first.seen.length < 102);
  markResponsibilitiesReviewed(db, first.seen, now);
  const rows = listResponsibilities(db);
  assert.equal(
    rows.filter((r) => r.last_reviewed_at).length,
    first.seen.length,
  );
  const second = responsibilityDesk(db, now, 8000);
  assert.ok(second.seen.length > 0);
  assert.ok(
    second.seen.every(
      (r) => !first.seen.some((prior) => prior.ref_id === r.ref_id),
    ),
  );
  for (const line of first.text.split("\n").slice(1))
    assert.doesNotThrow(() => JSON.parse(line));
});
test("same-timestamp edits, closed sources and stale plan revisions cannot be overwritten", (t) => {
  const { db } = fixture(t);
  task(db, "work");
  reconcileResponsibilities(db, now);
  const row = listResponsibilities(db)[0];
  updateResponsibility(db, patch(row), now);
  assert.throws(
    () => updateResponsibility(db, patch(row), now),
    /plan changed/,
  );
  const current = listResponsibilities(db)[0];
  db.prepare("UPDATE tasks SET title='Different' WHERE id='work'").run();
  assert.throws(
    () => updateResponsibility(db, patch(current), now),
    /source changed/,
  );
  db.prepare("UPDATE tasks SET status='done' WHERE id='work'").run();
  assert.equal(
    acknowledgeResponsibility(db, "task", "work", current.revision, now),
    false,
  );
});
test("chief cannot invent completion, clear or move a recorded deadline", (t) => {
  const { db, dbPath, dataDir } = fixture(t);
  task(db, "work", { due: "2026-09-04" });
  const version = sourceVersion(sourceRecord(db, "task", "work"));
  for (const [key, fields] of Object.entries({
    done: { status: "done" },
    moved: { due_at: "2026-09-10" },
    missing: { title: "Changed", expected_version: null },
  })) {
    const job = enqueueChiefOfStaffWake(db, { reason: "manual", now }).job;
    const result = applyChiefOfStaffActions({
      dbPath,
      dataDir,
      wakeJobId: job.id,
      now,
      actions: [
        {
          action_id: key,
          kind: "task_update",
          why: "Assume this is better",
          task_id: "work",
          expected_version: version,
          ...fields,
        },
      ],
    });
    assert.equal(result.rejected, 1);
  }
  assert.equal(sourceRecord(db, "task", "work").status, "open");
  assert.equal(sourceRecord(db, "task", "work").due_at, "2026-09-04");
});
test("waiting owner is durable and future check cannot conceal an earlier deadline; ideas are not obligations", (t) => {
  const { db } = fixture(t);
  db.prepare(
    "INSERT INTO commitments(id,kind,title,counterparty,source_kind,source_quote,source_ref,due_at,review_at,confirmed,created_at,updated_at) VALUES('bob','waiting_on','Proposal feedback','Bob','manual','Feedback by Friday','meeting-123','2026-09-04','2026-09-20',1,?,?)",
  ).run(now.toISOString(), now.toISOString());
  reconcileResponsibilities(db, now);
  const row = listResponsibilities(db)[0];
  assert.equal(row.owner, "Bob");
  assert.equal(row.source_quote, "Feedback by Friday");
  assert.ok(Date.parse(row.next_check_at) < Date.parse("2026-09-04"));
  db.prepare("UPDATE commitments SET kind='idea' WHERE id='bob'").run();
  reconcileResponsibilities(db, now);
  assert.equal(listResponsibilities(db).length, 0);
});
test("preparation exists locally, dedupes exact retries, preserves revisions and never completes the task", (t) => {
  const { db } = fixture(t);
  task(db, "proposal");
  const input = {
    ref_kind: "task",
    ref_id: "proposal",
    expected_version: sourceVersion(sourceRecord(db, "task", "proposal")),
    title: "Proposal outline",
    content: "Draft: confirm scope and fee.",
  };
  const id = savePreparation(db, input, now);
  assert.equal(savePreparation(db, input, now), id);
  assert.notEqual(
    savePreparation(
      db,
      { ...input, content: "Revised draft: clarify scope first." },
      now,
    ),
    id,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM cove_preparations").pluck().get(),
    2,
  );
  assert.equal(sourceRecord(db, "task", "proposal").status, "open");
});
test("capacity merges overlapping meetings, rejects impossible days and labels unknown estimates or calendar", () => {
  const base = {
    now,
    date: "2026-09-03",
    timezone: "America/Los_Angeles",
    events: [
      { start: "2026-09-03T17:00:00Z", end: "2026-09-03T19:00:00Z" },
      { start: "2026-09-03T18:00:00Z", end: "2026-09-03T20:00:00Z" },
    ],
    items: [{ id: "video", title: "Make video", minutes: 300 }],
  };
  const assessment = assessCapacity(base);
  assert.equal(assessment.availableMinutes, 210);
  assert.equal(assessment.overloaded, true);
  assert.equal(
    assessCapacity({ ...base, events: null }).availableMinutes,
    null,
  );
  assert.match(
    assessCapacity({
      ...base,
      items: [{ id: "unknown", title: "Unknown", minutes: null }],
    }).conclusion,
    /not enough evidence/,
  );
  assert.equal(
    localHour("2026-11-01", 9, "America/Los_Angeles").toISOString(),
    "2026-11-01T17:00:00.000Z",
  );
});
test("a closed working day has zero capacity; all-day busy events and declined meetings are handled", () => {
  const base = {
    now: new Date("2026-09-04T02:00:00Z"),
    date: "2026-09-03",
    timezone: "America/Los_Angeles",
    items: [],
    events: [],
  };
  assert.equal(assessCapacity(base).availableMinutes, 0);
  assert.equal(
    assessCapacity({
      ...base,
      now,
      events: [{ start: "2026-09-03", end: "2026-09-04" }],
    }).availableMinutes,
    0,
  );
  assert.equal(
    assessCapacity({
      ...base,
      now,
      events: [
        {
          start: "2026-09-03",
          end: "2026-09-04",
          attendees: [{ self: true, responseStatus: "declined" }],
        },
      ],
    }).availableMinutes,
    336,
  );
});

test("invented new work stays a proposal and never becomes an accepted obligation", (t) => {
  const { db, dbPath, dataDir } = fixture(t);
  const job = enqueueChiefOfStaffWake(db, { reason: "manual", now }).job;
  const result = applyChiefOfStaffActions({
    dbPath,
    dataDir,
    wakeJobId: job.id,
    now,
    actions: [
      {
        action_id: "invented",
        kind: "task_create",
        why: "My journal says this might help",
        title: "Unaccepted proposal",
        due_at: "2026-09-04",
      },
    ],
  });
  assert.equal(result.applied, 1);
  reconcileResponsibilities(db, now);
  assert.equal(listResponsibilities(db).length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) FROM tasks").pluck().get(), 0);
  assert.match(
    db.prepare("SELECT payload_json FROM chief_of_staff_actions").pluck().get(),
    /downgraded_to/,
  );
});
