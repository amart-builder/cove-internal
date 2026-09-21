import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openLocalDatabase } from "../src/lib/local/database.ts";
import { LOCAL_MIGRATIONS, runLocalMigrations } from "../src/lib/local/migrations.ts";
import { processMeetingNotesEmail } from "../src/lib/intake/meeting-pipeline.ts";
import { claimMessageIngestion, messageIngestionExtraction } from "../src/lib/intake/message-ingestion.ts";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-extraction-retry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, "cove.db");
  return { dir, dbPath };
}
const now = new Date("2026-09-15T16:00:00Z");
const email = { messageId: "synthetic-retry", threadId: "synthetic-thread", subject: "Synthetic meeting", body: "Source notes", detectedTool: "fixture" };

test("partial meeting writes retry the saved extraction and retain one task and one completion receipt", async t => {
  const { dir, dbPath } = fixture(t);
  let extractionCalls = 0, waitingAttempts = 0;
  const taskSources = new Set();
  const options = {
    sourceDoor: "watcher", dbPath, dataDir: dir, baseUrl: "http://fixture.invalid", now: () => now,
    crmBackend: { resolveAndAppendMeetingActivity: () => ({ status: "matched", contactId: "fixture-contact" }), close() {} },
    isOperatorOwnedImpl: name => name === "Taylor",
    extractFollowUps: async () => [{ owner: "Taylor", title: ++extractionCalls === 1 ? "Send proposal" : "Send the proposal", detail: "Same obligation", due_at: "2026-09-16T17:00:00Z" }, { owner: "Sam Smith", title: "Reply", detail: "Same waiting item" }],
    runIntakeImpl: async input => {
      taskSources.add(input.sourceId);
      const taskDb = openLocalDatabase(dbPath);
      try { taskDb.prepare("INSERT OR IGNORE INTO tasks(id,title,status) VALUES(?,?,'open')").run(input.sourceId, input.text); }
      finally { taskDb.close(); }
      return { event: { id: input.sourceId }, exitCode: 0 };
    },
    recordEventImpl: async () => ({ event: { id: "fixture-event" } }), resolveEventImpl: async () => {},
    writeCommitmentImpl: async () => { if (++waitingAttempts === 1) throw new Error("later write outage"); return "fixture-commitment"; },
  };
  await assert.rejects(processMeetingNotesEmail(email, options), /later write outage/);
  const db = openLocalDatabase(dbPath);
  try {
    const saved = JSON.parse(db.prepare("SELECT followups_json FROM cove_message_ingestion").get().followups_json);
    assert.equal(saved[0].title, "Send proposal");
    assert.equal(saved[0].due_at, "2026-09-16T17:00:00Z");
    const retried = await processMeetingNotesEmail(email, options);
    const replay = await processMeetingNotesEmail(email, options);
    assert.equal(extractionCalls, 1);
    assert.equal(taskSources.size, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, 1);
    assert.equal(retried.status, "processed");
    assert.equal(replay.receiptId, retried.receiptId);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cove_receipts WHERE source='meeting-intake'").get().n, 1);
  } finally { db.close(); }
});

test("corrupt saved extraction fails visibly without re-extracting or writing side effects", async t => {
  const { dir, dbPath } = fixture(t);
  const claim = claimMessageIngestion({ ...email, sourceDoor: "watcher", dbPath, now });
  assert.equal(claim.claimed, true);
  const db = openLocalDatabase(dbPath);
  try {
    db.prepare("UPDATE cove_message_ingestion SET status='retry',followups_json='broken-json'").run();
    let called = false;
    await assert.rejects(processMeetingNotesEmail(email, { sourceDoor: "watcher", dbPath, dataDir: dir, baseUrl: "http://fixture.invalid", now: () => now,
      extractFollowUps: async () => { called = true; return []; },
      crmBackend: { resolveAndAppendMeetingActivity: () => { called = true; throw new Error("must not write"); }, close() {} },
    }));
    assert.equal(called, false);
    const row = db.prepare("SELECT status,last_error,followups_json FROM cove_message_ingestion").get();
    assert.equal(row.status, "retry"); assert.ok(row.last_error); assert.equal(row.followups_json, "broken-json");
  } finally { db.close(); }
});

test("only the current claimant can save an extraction and a retry cannot replace the first snapshot", t => {
  const { dbPath } = fixture(t);
  const first = claimMessageIngestion({ ...email, sourceDoor: "watcher", dbPath, now, leaseMs: 10_000 });
  const second = claimMessageIngestion({ ...email, sourceDoor: "watcher", dbPath, now: new Date(+now + 11_000) });
  const extraction = [{ owner: "Taylor", title: "One", detail: "Original" }];
  assert.throws(() => messageIngestionExtraction({ messageId: email.messageId, leaseToken: first.leaseToken, dbPath, extraction }), /no longer owned/);
  assert.deepEqual(messageIngestionExtraction({ messageId: email.messageId, leaseToken: second.leaseToken, dbPath, extraction }), extraction);
  assert.deepEqual(messageIngestionExtraction({ messageId: email.messageId, leaseToken: second.leaseToken, dbPath, extraction: [] }), extraction);
});

test("migration34 preserves existing ingestion rows and replayed migration is harmless", t => {
  const { dbPath } = fixture(t);
  const db = new Database(dbPath);
  try {
    db.exec("CREATE TABLE cove_message_ingestion(message_id TEXT PRIMARY KEY, status TEXT, receipt_id TEXT); INSERT INTO cove_message_ingestion VALUES('old','processed','old-receipt')");
    const migration = LOCAL_MIGRATIONS.find(item => item.version === 34);
    migration.up(db); migration.up(db);
    assert.deepEqual(db.prepare("SELECT * FROM cove_message_ingestion").get(), { message_id: "old", status: "processed", receipt_id: "old-receipt", followups_json: null });
  } finally { db.close(); }
  const fresh = new Database(":memory:");
  try { runLocalMigrations(fresh); assert.ok(fresh.prepare("PRAGMA table_info(cove_message_ingestion)").all().some(row => row.name === "followups_json")); } finally { fresh.close(); }
});
