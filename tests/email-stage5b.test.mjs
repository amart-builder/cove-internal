import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  archiveEmailItemFromCard,
  captureEmailCommitments,
  reconcileGmailToCard,
} from "../src/lib/email/automation.ts";
import {
  archiveEmailItemFromCard as archiveEmailItemFromCardData,
} from "../src/lib/data/email.ts";
import { openLocalDatabase } from "../src/lib/local/database.ts";
import { listFailures } from "../src/lib/reliability/failures.ts";

const NOW = new Date("2026-07-29T18:00:00.000Z");

function fixture(t) {
  const dir = path.join(
    os.tmpdir(),
    `cove-email-stage5b-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "forge.db");
  openLocalDatabase(dbPath).close();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, dbPath };
}

function insertEmail(dbPath, input) {
  const db = openLocalDatabase(dbPath);
  try {
    db.prepare(
      `INSERT INTO email_items
         (id, message_id, thread_id, status, workflow_state, bucket,
          thread_version, latest_inbound_message_id, source_payload,
          sender_name, sender_email, subject, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 'open', ?, 1, ?, ?,
               'Sender', 'sender@example.com', ?, ?, ?)`,
    ).run(
      input.id,
      input.messageId,
      input.threadId,
      input.bucket ?? "reply",
      input.messageId,
      JSON.stringify({ bucket: input.bucket ?? "reply" }),
      input.id,
      NOW.toISOString(),
      NOW.toISOString(),
    );
    db.prepare(
      `INSERT INTO forge_email_messages
         (message_id, thread_id, email_item_id, internal_date, direction,
          state, attempts, observed_at, processed_at, updated_at)
       VALUES (?, ?, ?, '1000', 'inbound', 'processed', 0, ?, ?, ?)`,
    ).run(
      input.messageId,
      input.threadId,
      input.id,
      NOW.toISOString(),
      NOW.toISOString(),
      NOW.toISOString(),
    );
  } finally {
    db.close();
  }
}

function email(dbPath, id) {
  const db = openLocalDatabase(dbPath);
  try {
    return db.prepare(
      "SELECT status, workflow_state, completion_reason FROM email_items WHERE id = ?",
    ).get(id);
  } finally {
    db.close();
  }
}

test("manual Gmail archive closes the item without another provider write", async (t) => {
  const files = fixture(t);
  insertEmail(files.dbPath, {
    id: "email-a",
    messageId: "message-a",
    threadId: "thread-a",
  });
  let writes = 0;
  const result = await reconcileGmailToCard({
    dbPath: files.dbPath,
    observations: [{
      emailItemId: "email-a",
      threadId: "thread-a",
      inInbox: false,
      userReplied: false,
    }],
    gateway: {
      archiveMessages: async () => { writes += 1; },
    },
    now: NOW,
  });
  assert.equal(result.autoChecked, 1);
  assert.equal(writes, 0);
  assert.deepEqual(email(files.dbPath, "email-a"), {
    status: "actioned",
    workflow_state: "terminal",
    completion_reason: "manual_archive",
  });
});

test("a newer sent reply archives the exact inbound message before closing Cove", async (t) => {
  const files = fixture(t);
  insertEmail(files.dbPath, {
    id: "email-reply",
    messageId: "message-reply",
    threadId: "thread-reply",
  });
  const prepared = openLocalDatabase(files.dbPath);
  try {
    prepared.prepare(
      "UPDATE email_items SET source_payload = '{}' WHERE id = 'email-reply'",
    ).run();
  } finally {
    prepared.close();
  }
  const calls = [];
  const result = await reconcileGmailToCard({
    dbPath: files.dbPath,
    observations: [{
      emailItemId: "email-reply",
      threadId: "thread-reply",
      inInbox: true,
      userReplied: true,
    }],
    gateway: {
      getThread: async () => ({
        messages: [{ id: "message-card", labelIds: ["INBOX"] }],
      }),
      archiveMessages: async (input) => calls.push(input),
    },
    now: NOW,
  });
  assert.deepEqual(calls, [{ messageIds: ["message-reply"] }]);
  assert.deepEqual(result.changedIds, ["email-reply"]);
  assert.equal(email(files.dbPath, "email-reply").status, "actioned");
});

test("provider failure leaves a sent reply open and surfaces an Issue", async (t) => {
  const files = fixture(t);
  insertEmail(files.dbPath, {
    id: "email-fail",
    messageId: "message-fail",
    threadId: "thread-fail",
  });
  const result = await reconcileGmailToCard({
    dbPath: files.dbPath,
    observations: [{
      emailItemId: "email-fail",
      threadId: "thread-fail",
      inInbox: true,
      userReplied: true,
    }],
    gateway: {
      getThread: async () => ({
        messages: [{ id: "message-card-fail", labelIds: ["INBOX"] }],
      }),
      archiveMessages: async () => { throw new Error("offline"); },
    },
    now: NOW,
  });
  assert.equal(result.archiveFailures.length, 1);
  assert.deepEqual(email(files.dbPath, "email-fail"), {
    status: "pending",
    workflow_state: "open",
    completion_reason: null,
  });
  assert.equal(listFailures({ dbPath: files.dbPath }).length, 1);
});

test("card completion removes INBOX from the exact message and fails closed", async (t) => {
  const files = fixture(t);
  insertEmail(files.dbPath, {
    id: "email-card",
    messageId: "message-card",
    threadId: "thread-card",
    bucket: "action",
  });
  const calls = [];
  await archiveEmailItemFromCard({
    emailItemId: "email-card",
    dbPath: files.dbPath,
    gateway: {
      getThread: async () => ({
        messages: [{ id: "message-card", labelIds: ["INBOX"] }],
      }),
      archiveMessages: async (input) => calls.push(input),
    },
    now: NOW,
  });
  assert.deepEqual(calls, [{ messageIds: ["message-card"] }]);
  assert.deepEqual(email(files.dbPath, "email-card"), {
    status: "actioned",
    workflow_state: "terminal",
    completion_reason: "card",
  });
  const completed = openLocalDatabase(files.dbPath);
  try {
    assert.deepEqual(
      completed.prepare(
        `SELECT operation.status AS operation_status, job.status AS job_status
         FROM forge_gmail_operations operation
         JOIN forge_jobs job ON job.id = operation.job_id
         WHERE operation.email_item_id = 'email-card'`,
      ).get(),
      { operation_status: "succeeded", job_status: "done" },
    );
  } finally {
    completed.close();
  }

  insertEmail(files.dbPath, {
    id: "email-card-fail",
    messageId: "message-card-fail",
    threadId: "thread-card-fail",
    bucket: "action",
  });
  await assert.rejects(archiveEmailItemFromCard({
    emailItemId: "email-card-fail",
    dbPath: files.dbPath,
    gateway: {
      getThread: async () => ({
        messages: [{ id: "message-card-fail", labelIds: ["INBOX"] }],
      }),
      archiveMessages: async () => { throw new Error("offline"); },
    },
    now: NOW,
  }));
  assert.equal(email(files.dbPath, "email-card-fail").status, "pending");
  const failed = openLocalDatabase(files.dbPath);
  try {
    assert.deepEqual(
      failed.prepare(
        `SELECT operation.status AS operation_status, job.status AS job_status
         FROM forge_gmail_operations operation
         JOIN forge_jobs job ON job.id = operation.job_id
         WHERE operation.email_item_id = 'email-card-fail'`,
      ).get(),
      { operation_status: "pending", job_status: "failed" },
    );
  } finally {
    failed.close();
  }
});

test("card completion repairs a migrated thread that had no legacy message id", async (t) => {
  const files = fixture(t);
  const db = openLocalDatabase(files.dbPath);
  try {
    db.prepare(
      `INSERT INTO email_items
         (id, thread_id, status, workflow_state, bucket, thread_version,
          source_payload, subject, created_at, updated_at)
       VALUES ('email-legacy-null', 'thread-legacy-null', 'pending', 'open',
               'action', 1, '{}', 'Legacy email', ?, ?)`,
    ).run(NOW.toISOString(), NOW.toISOString());
  } finally {
    db.close();
  }
  const calls = [];
  await archiveEmailItemFromCard({
    emailItemId: "email-legacy-null",
    dbPath: files.dbPath,
    gateway: {
      getThread: async () => ({
        messages: [{
          id: "message-repaired",
          threadId: "thread-legacy-null",
          labelIds: ["INBOX"],
          internalDate: "1000",
          headers: [],
          snippet: "",
          text: "",
        }],
      }),
      archiveMessages: async (input) => calls.push(input),
    },
    now: NOW,
  });
  assert.deepEqual(calls, [{ messageIds: ["message-repaired"] }]);
  const repaired = openLocalDatabase(files.dbPath);
  try {
    assert.equal(repaired.prepare(
      "SELECT message_id FROM email_items WHERE id = 'email-legacy-null'",
    ).get().message_id, "message-repaired");
  } finally {
    repaired.close();
  }
});

test("hosted mode cannot report handled without Gmail confirmation", async (t) => {
  const previous = process.env.NEXT_PUBLIC_FORGE_RUNTIME;
  process.env.NEXT_PUBLIC_FORGE_RUNTIME = "supabase";
  t.after(() => {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_FORGE_RUNTIME;
    else process.env.NEXT_PUBLIC_FORGE_RUNTIME = previous;
  });
  await assert.rejects(
    archiveEmailItemFromCardData("hosted-email"),
    /connected Gmail account confirms the archive/,
  );
});

test("email commitment capture remains idempotent", (t) => {
  const files = fixture(t);
  const input = {
    commitments: [{
      threadId: "thread-commitment",
      kind: "follow_up",
      title: "Send the revised proposal",
      sourceQuote: "I will send the revised proposal.",
      threadLink: "https://mail.google.com/mail/#all/thread-commitment",
    }],
    dbPath: files.dbPath,
    now: NOW,
  };
  assert.equal(captureEmailCommitments(input).inserted, 1);
  assert.equal(captureEmailCommitments(input).existing, 1);
  const db = openLocalDatabase(files.dbPath);
  try {
    assert.deepEqual(
      db.prepare(
        "SELECT confidence, confirmed FROM commitments WHERE source_ref = ?",
      ).get("gmail:thread-commitment"),
      { confidence: "medium", confirmed: 0 },
    );
  } finally {
    db.close();
  }
});
