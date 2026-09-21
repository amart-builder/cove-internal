/**
 * A card sitting in Done kept ringing.
 *
 * Every reminder lane keys on `status`: the due reminder, the attention floor,
 * the follow-through checks and the pre-deadline nudge all select
 * `status = 'open'`. The board keys on `column_id`. Nothing on the server kept
 * the two in step.
 *
 * `KanbanBoard.tsx:531` does it on the client -- `patchWithColumnStatus` adds
 * `status` to any patch that moves a column -- so a person dragging a card is
 * fine. Anyone else is not. An agent following `skills/cove-task/SKILL.md`
 * PATCHes "only the fields that need changing", and Apple Reminders' bridge
 * and any other API caller do the same. Move a card into Done that way and the
 * row reads `column_id: Done, status: open`: the board shows it finished and
 * every lane still thinks it is live.
 *
 * Reproduced on a live install before this fix, against the real HTTP API and
 * the real reminder script:
 *
 *     PATCH /api/cove-rest/tasks?id=eq.…   {"column_id": "<Done>"}
 *       → status "open", column "Done"
 *     scripts/cove-reminders.mjs
 *       → "Here's your reminder: Call Joe about the roof bid"
 *
 * The rule now lives beside the one that re-arms a moved deadline, in the one
 * place every task write goes through. An explicit `status` in the same patch
 * still wins, because a caller that says what it means is not guessing, and an
 * archived task is never quietly reopened by a column move.
 */
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { handleLocalRest } from "../src/lib/local/db.ts";

const require = createRequire(import.meta.url);
require("tsx/cjs");
const { runLocalMigrations } = require("../src/lib/local/migrations.ts");

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-done-column-"));
  const dbPath = path.join(dir, "cove.db");
  const prior = process.env.COVE_DB_PATH;
  const priorDb = globalThis.__coveDb;
  delete globalThis.__coveDb;
  process.env.COVE_DB_PATH = dbPath;
  const db = new Database(dbPath);
  runLocalMigrations(db);
  const columns = db.prepare("SELECT id, name FROM task_columns ORDER BY position").all();
  const column = (name) => columns.find((c) => c.name === name).id;
  db.prepare(
    `INSERT INTO tasks (id, column_id, title, status, source_type, due_at,
                        remind_native, remind_text, created_at, updated_at)
     VALUES (?, ?, ?, 'open', 'manual', '2026-09-25T15:00:00', 1, 0, ?, ?)`,
  ).run("roof", column("Must happen today"), "Call Joe about the roof bid",
    "2026-09-21T00:00:00.000Z", "2026-09-21T00:00:00.000Z");
  t.after(() => {
    db.close();
    globalThis.__coveDb?.close();
    if (priorDb === undefined) delete globalThis.__coveDb;
    else globalThis.__coveDb = priorDb;
    if (prior === undefined) delete process.env.COVE_DB_PATH;
    else process.env.COVE_DB_PATH = prior;
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, dbPath, column };
}

function patch(_dbPath, id, body) {
  return handleLocalRest("tasks", "PATCH", new URLSearchParams({ id: `eq.${id}` }), body);
}

function row(db, id = "roof") {
  return db.prepare(
    `SELECT tasks.status, task_columns.name AS column_name
       FROM tasks JOIN task_columns ON task_columns.id = tasks.column_id
      WHERE tasks.id = ?`,
  ).get(id);
}

test("moving a card into Done finishes it, even when the caller only sent the column", (t) => {
  const { db, dbPath, column } = fixture(t);

  patch(dbPath, "roof", { column_id: column("Done") });

  assert.deepEqual(row(db), { status: "done", column_name: "Done" });
});

test("moving it back out reopens it", (t) => {
  const { db, dbPath, column } = fixture(t);

  patch(dbPath, "roof", { column_id: column("Done") });
  patch(dbPath, "roof", { column_id: column("In Flight / Waiting") });

  assert.deepEqual(row(db), { status: "open", column_name: "In Flight / Waiting" });
});

test("an explicit status in the same patch still wins", (t) => {
  const { db, dbPath, column } = fixture(t);

  // What the board itself sends. It must not be second-guessed.
  patch(dbPath, "roof", { column_id: column("Done"), status: "open" });

  assert.deepEqual(row(db), { status: "open", column_name: "Done" });
});

test("an archived task is not reopened by a column move", (t) => {
  const { db, dbPath, column } = fixture(t);
  db.prepare("UPDATE tasks SET status='archived', archived_at=? WHERE id='roof'")
    .run("2026-09-21T00:00:00.000Z");

  patch(dbPath, "roof", { column_id: column("Not Started") });

  assert.deepEqual(row(db), { status: "archived", column_name: "Not Started" });
});

test("a patch that does not move the column leaves status alone", (t) => {
  const { db, dbPath } = fixture(t);
  db.prepare("UPDATE tasks SET status='done' WHERE id='roof'").run();

  patch(dbPath, "roof", { title: "Call Joe about the roof bid again" });

  assert.equal(row(db).status, "done");
});
