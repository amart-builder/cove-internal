import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { observeIncrementalInbox } from "../src/lib/email/incremental-intake.ts";
import { runLocalMigrations } from "../src/lib/local/migrations.ts";

test("the five-minute lane observes new mail and enqueues exactly one classifier job", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-incremental-email-"));
  const dbPath = path.join(dir, "cove.db");
  const db = new Database(dbPath);
  runLocalMigrations(db);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const message = {
    id: "message-new",
    threadId: "thread-new",
    historyId: "42",
    internalDate: "1786042800000",
    snippet: "Can you confirm today?",
    text: "Can you confirm today?",
    headers: [
      { name: "From", value: "Client <client@example.com>" },
      { name: "Subject", value: "Same-day question" },
    ],
    labelIds: ["INBOX"],
  };
  const gateway = {
    ensureCoveLabel: async () => ({ id: "label-1", name: "Cove/Triaged" }),
    listMessages: async () => ({ messages: [{ id: message.id, threadId: message.threadId }] }),
    getMessage: async () => message,
  };

  const first = await observeIncrementalInbox({
    gateway,
    accountEmail: "alex@example.com",
    dbPath,
    now: () => new Date("2026-08-06T09:05:00-07:00"),
  });
  const second = await observeIncrementalInbox({
    gateway,
    accountEmail: "alex@example.com",
    dbPath,
    now: () => new Date("2026-08-06T09:10:00-07:00"),
  });
  assert.equal(first.observed, 1);
  assert.equal(second.observed, 0);
  assert.equal(db.prepare(
    "SELECT COUNT(*) FROM cove_jobs WHERE type = 'email-classify'",
  ).pluck().get(), 1);
  assert.equal(db.prepare(
    "SELECT state FROM cove_email_messages WHERE message_id = 'message-new'",
  ).pluck().get(), "observed");
});

test("the five-minute lane leaves a permanently failed classification alone", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-incremental-failed-"));
  const dbPath = path.join(dir, "cove.db");
  const db = new Database(dbPath);
  runLocalMigrations(db);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const message = {
    id: "message-dead",
    threadId: "thread-dead",
    historyId: "43",
    internalDate: "1786042800000",
    snippet: "This one keeps failing",
    text: "This one keeps failing",
    headers: [
      { name: "From", value: "Client <client@example.com>" },
      { name: "Subject", value: "Fails to classify" },
    ],
    labelIds: ["INBOX"],
  };
  const gateway = {
    ensureCoveLabel: async () => ({ id: "label-1", name: "Cove/Triaged" }),
    listMessages: async () => ({ messages: [{ id: message.id, threadId: message.threadId }] }),
    getMessage: async () => message,
  };
  const observe = (minute) => observeIncrementalInbox({
    gateway,
    accountEmail: "alex@example.com",
    dbPath,
    now: () => new Date(`2026-08-06T09:${minute}:00-07:00`),
  });

  await observe("05");
  // The classifier exhausted its attempts and the message is dead.
  db.prepare(
    "UPDATE cove_email_messages SET state = 'failed' WHERE message_id = ?",
  ).run(message.id);
  db.prepare(
    "UPDATE cove_jobs SET status = 'dead', attempts = 5 WHERE type = 'email-classify'",
  ).run();

  // Every tick would otherwise restart the retry ladder and hold the lane.
  await observe("10");
  await observe("15");
  assert.equal(db.prepare(
    "SELECT state FROM cove_email_messages WHERE message_id = ?",
  ).pluck().get(message.id), "failed");
  assert.deepEqual(db.prepare(
    "SELECT status, attempts FROM cove_jobs WHERE type = 'email-classify'",
  ).get(), { status: "dead", attempts: 5 });
});
