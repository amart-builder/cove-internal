import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openLocalDatabase } from "../src/lib/local/database.ts";
import {
  listResponsibilities,
  reconcileResponsibilities,
} from "../src/lib/responsibility/store.ts";

const NOW = new Date("2026-09-21T16:00:00Z");
const LATER = new Date("2026-09-21T16:06:00Z");

function withDb(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-resp-"));
  const db = openLocalDatabase(path.join(dir, "cove.db"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

function seedTask(db, columnId) {
  db.prepare(
    `INSERT INTO tasks (id, title, priority, status, project, column_id, position, created_at, updated_at)
     VALUES ('task-drag', 'Call the plumber', 'medium', 'open', 'Home', ?, 0, ?, ?)`,
  ).run(columnId, NOW.toISOString(), NOW.toISOString());
}

function row(db) {
  return listResponsibilities(db).find((r) => r.ref_id === "task-drag");
}

test("moving a card across the board does not report the work as blocked", (t) => {
  const db = withDb(t);
  seedTask(db, "col-not-started");
  reconcileResponsibilities(db, NOW);
  assert.equal(row(db).state, "ready");

  // A pure drag: a different column, a new position, a new updated_at. Nothing
  // about the obligation itself changed.
  db.prepare(
    "UPDATE tasks SET column_id='col-today', position=3, updated_at=? WHERE id='task-drag'",
  ).run(LATER.toISOString());
  reconcileResponsibilities(db, LATER);

  const after = row(db);
  assert.notEqual(
    after.state,
    "blocked",
    "the Follow-through page prints this state as a bare 'Blocked', and dragging a card blocks nothing",
  );
  assert.equal(after.blocker ?? null, null, "a blocked item with no blocker is not a state a person can act on");
});

test("a changed source is still pulled forward for review", (t) => {
  const db = withDb(t);
  seedTask(db, "col-not-started");
  reconcileResponsibilities(db, NOW);
  db.prepare(
    "UPDATE cove_responsibilities SET last_reviewed_at=?, next_check_at=? WHERE ref_id='task-drag'",
  ).run(NOW.toISOString(), new Date(NOW.getTime() + 3 * 86_400_000).toISOString());

  db.prepare("UPDATE tasks SET title='Call the plumber about the leak', updated_at=? WHERE id='task-drag'")
    .run(LATER.toISOString());
  reconcileResponsibilities(db, LATER);

  const after = row(db);
  assert.equal(after.last_reviewed_at, null, "an edited source has to be looked at again");
  assert.equal(after.next_check_at, LATER.toISOString(), "and looked at now, not in three days");
});

test("a responsibility whose source reopens comes back as work, not as blocked", (t) => {
  const db = withDb(t);
  seedTask(db, "col-not-started");
  reconcileResponsibilities(db, NOW);
  db.prepare("UPDATE cove_responsibilities SET state='resolved' WHERE ref_id='task-drag'").run();
  reconcileResponsibilities(db, LATER);
  assert.equal(row(db).state, "ready");
});
