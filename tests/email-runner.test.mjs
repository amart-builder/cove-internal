import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runEmailTriage } from "../scripts/cove-email-runner.ts";
import { openLocalDatabase } from "../src/lib/local/database.ts";
import { listFailures } from "../src/lib/reliability/failures.ts";
import { listRecentReceipts } from "../src/lib/reliability/receipts.ts";

function workspaceConfig(dataDir) {
  writeFileSync(
    path.join(dataDir, "cove-workspace.json"),
    JSON.stringify({
      version: 1,
      provider: "google-api",
      profile_id: "primary",
      account_email: "alex@example.com",
      oauth_client_id: "client.apps.googleusercontent.com",
      capabilities: { mail: true, calendar: false, documents: false },
      calendar_id: "primary",
      gmail: { support_draft_recipients: [] },
    }),
  );
}

function insertPendingReply(dbPath, input) {
  const db = openLocalDatabase(dbPath);
  try {
    db.prepare(
      `INSERT INTO email_items
         (id, message_id, thread_id, status, workflow_state, bucket,
          thread_version, latest_inbound_message_id, source_payload,
          sender_name, sender_email, subject, received_at, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 'open', 'reply', 1, ?, '{"bucket":"reply"}',
               'Sender', 'sender@example.com', 'Needs reply', ?, ?, ?)`,
    ).run(
      input.id,
      input.messageId,
      input.threadId,
      input.messageId,
      input.now,
      input.now,
      input.now,
    );
  } finally {
    db.close();
  }
}

function emailState(dbPath, id) {
  const db = openLocalDatabase(dbPath);
  try {
    return db.prepare(
      "SELECT status, workflow_state, completion_reason FROM email_items WHERE id = ?",
    ).get(id);
  } finally {
    db.close();
  }
}

function threadMessage(input) {
  return {
    id: input.id,
    threadId: input.threadId,
    historyId: null,
    labelIds: input.labelIds,
    internalDate: input.internalDate,
    headers: [{ name: "From", value: input.from }],
    snippet: "",
    text: "",
  };
}

test("top-level Google auth failure is surfaced on Issues before the runner exits", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-email-runner-"));
  const dbPath = path.join(dataDir, "cove.db");
  openLocalDatabase(dbPath).close();
  workspaceConfig(dataDir);
  await assert.rejects(
    runEmailTriage({
      dataDir,
      dbPath,
      gateway: {
        getProfile: async () => {
          throw new Error("auth offline");
        },
      },
      now: () => new Date("2026-07-29T18:00:00Z"),
    }),
    /auth offline/,
  );
  const failures = listFailures({ dbPath });
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /Google Workspace was temporarily unavailable/i);
});

test("inbox discovery excludes Cove and pre-rename Forge triage markers", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-email-query-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const dbPath = path.join(dataDir, "cove.db");
  openLocalDatabase(dbPath).close();
  workspaceConfig(dataDir);
  let query;

  await runEmailTriage({
    dataDir,
    dbPath,
    gateway: {
      getProfile: async () => ({ emailAddress: "alex@example.com" }),
      ensureCoveLabel: async () => ({ id: "label-cove", name: "Cove/Triaged" }),
      listMessages: async (input) => {
        query = input.query;
        return { messages: [] };
      },
    },
    now: () => new Date("2026-07-29T18:00:00Z"),
  });

  assert.equal(
    query,
    "in:inbox -label:Cove/Triaged -label:Forge/Triaged",
  );
});

test("inbox discovery follows every available page", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-email-pages-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const dbPath = path.join(dataDir, "cove.db");
  openLocalDatabase(dbPath).close();
  workspaceConfig(dataDir);
  const pageTokens = [];

  const result = await runEmailTriage({
    dataDir,
    dbPath,
    gateway: {
      getProfile: async () => ({ emailAddress: "alex@example.com" }),
      ensureCoveLabel: async () => ({ id: "label-cove", name: "Cove/Triaged" }),
      listMessages: async ({ pageToken }) => {
        pageTokens.push(pageToken);
        return pageToken
          ? { messages: [] }
          : { messages: [], nextPageToken: "page-2" };
      },
    },
    now: () => new Date("2026-07-29T18:00:00Z"),
  });

  assert.deepEqual(pageTokens, [undefined, "page-2"]);
  assert.equal(result.pagesScanned, 2);
  assert.equal(result.intakeTruncated, false);
});

test("inbox discovery stops at a visible bounded safety limit", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-email-cap-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const dbPath = path.join(dataDir, "cove.db");
  openLocalDatabase(dbPath).close();
  workspaceConfig(dataDir);
  let calls = 0;

  const result = await runEmailTriage({
    dataDir,
    dbPath,
    gateway: {
      getProfile: async () => ({ emailAddress: "alex@example.com" }),
      ensureCoveLabel: async () => ({ id: "label-cove", name: "Cove/Triaged" }),
      listMessages: async () => {
        calls += 1;
        return { messages: [], nextPageToken: `page-${calls + 1}` };
      },
    },
    now: () => new Date("2026-07-29T18:00:00Z"),
  });

  assert.equal(calls, 10);
  assert.equal(result.pagesScanned, 10);
  assert.equal(result.intakeTruncated, true);
  assert.equal(listRecentReceipts({ dbPath, source: "email-triage" })[0].outcome, "partial");
  const failures = listFailures({ dbPath });
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /Cove\/Triaged.*later runs/);
  assert.doesNotMatch(failures[0].message, /continue the backlog/);
});

test("a newer account-authored draft does not count as a sent reply", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-email-draft-reconcile-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const dbPath = path.join(dataDir, "cove.db");
  openLocalDatabase(dbPath).close();
  workspaceConfig(dataDir);
  insertPendingReply(dbPath, {
    id: "email-draft",
    messageId: "message-inbound",
    threadId: "thread-draft",
    now: "2026-07-29T18:00:00.000Z",
  });
  const archiveCalls = [];

  await runEmailTriage({
    dataDir,
    dbPath,
    gateway: {
      getProfile: async () => ({ emailAddress: "alex@example.com" }),
      ensureCoveLabel: async () => ({ id: "label-cove", name: "Cove/Triaged" }),
      listMessages: async () => ({ messages: [] }),
      getThread: async () => ({
        id: "thread-draft",
        historyId: null,
        messages: [
          threadMessage({
            id: "message-inbound",
            threadId: "thread-draft",
            labelIds: ["INBOX"],
            internalDate: "1000",
            from: "sender@example.com",
          }),
          threadMessage({
            id: "message-draft",
            threadId: "thread-draft",
            labelIds: ["DRAFT"],
            internalDate: "2000",
            from: "alex@example.com",
          }),
        ],
      }),
      archiveMessages: async (input) => archiveCalls.push(input),
    },
    now: () => new Date("2026-07-29T18:00:00Z"),
  });

  assert.deepEqual(archiveCalls, []);
  assert.deepEqual(emailState(dbPath, "email-draft"), {
    status: "pending",
    workflow_state: "open",
    completion_reason: null,
  });
});

test("a newer account-authored SENT message completes the reply", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-email-sent-reconcile-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const dbPath = path.join(dataDir, "cove.db");
  openLocalDatabase(dbPath).close();
  workspaceConfig(dataDir);
  insertPendingReply(dbPath, {
    id: "email-sent",
    messageId: "message-inbound",
    threadId: "thread-sent",
    now: "2026-07-29T18:00:00.000Z",
  });
  const archiveCalls = [];

  await runEmailTriage({
    dataDir,
    dbPath,
    gateway: {
      getProfile: async () => ({ emailAddress: "alex@example.com" }),
      ensureCoveLabel: async () => ({ id: "label-cove", name: "Cove/Triaged" }),
      listMessages: async () => ({ messages: [] }),
      getThread: async () => ({
        id: "thread-sent",
        historyId: null,
        messages: [
          threadMessage({
            id: "message-inbound",
            threadId: "thread-sent",
            labelIds: ["INBOX"],
            internalDate: "1000",
            from: "sender@example.com",
          }),
          threadMessage({
            id: "message-sent",
            threadId: "thread-sent",
            labelIds: ["SENT"],
            internalDate: "2000",
            from: "alex@example.com",
          }),
        ],
      }),
      archiveMessages: async (input) => archiveCalls.push(input),
    },
    now: () => new Date("2026-07-29T18:00:00Z"),
  });

  assert.deepEqual(archiveCalls, [{ messageIds: ["message-inbound"] }]);
  assert.deepEqual(emailState(dbPath, "email-sent"), {
    status: "actioned",
    workflow_state: "terminal",
    completion_reason: "sent_reply",
  });
});

test("an account-authored message with no labels never counts as a sent reply", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-email-nolabel-reconcile-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const dbPath = path.join(dataDir, "cove.db");
  openLocalDatabase(dbPath).close();
  workspaceConfig(dataDir);
  insertPendingReply(dbPath, {
    id: "email-nolabel",
    messageId: "message-inbound",
    threadId: "thread-nolabel",
    now: "2026-07-29T18:00:00.000Z",
  });
  const archiveCalls = [];

  await runEmailTriage({
    dataDir,
    dbPath,
    gateway: {
      getProfile: async () => ({ emailAddress: "alex@example.com" }),
      ensureCoveLabel: async () => ({ id: "label-cove", name: "Cove/Triaged" }),
      listMessages: async () => ({ messages: [] }),
      getThread: async () => ({
        id: "thread-nolabel",
        historyId: null,
        messages: [
          threadMessage({
            id: "message-inbound",
            threadId: "thread-nolabel",
            labelIds: ["INBOX"],
            internalDate: "1000",
            from: "sender@example.com",
          }),
          threadMessage({
            id: "message-nolabel",
            threadId: "thread-nolabel",
            labelIds: [],
            internalDate: "2000",
            from: "alex@example.com",
          }),
        ],
      }),
      archiveMessages: async (input) => archiveCalls.push(input),
    },
    now: () => new Date("2026-07-29T18:00:00Z"),
  });

  assert.deepEqual(archiveCalls, []);
  assert.deepEqual(emailState(dbPath, "email-nolabel"), {
    status: "pending",
    workflow_state: "open",
    completion_reason: null,
  });
});

test("a newer draft does not hide an older real sent reply", async (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-email-draft-after-sent-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const dbPath = path.join(dataDir, "cove.db");
  openLocalDatabase(dbPath).close();
  workspaceConfig(dataDir);
  insertPendingReply(dbPath, {
    id: "email-draft-after-sent",
    messageId: "message-inbound",
    threadId: "thread-draft-after-sent",
    now: "2026-07-29T18:00:00.000Z",
  });
  const archiveCalls = [];

  await runEmailTriage({
    dataDir,
    dbPath,
    gateway: {
      getProfile: async () => ({ emailAddress: "alex@example.com" }),
      ensureCoveLabel: async () => ({ id: "label-cove", name: "Cove/Triaged" }),
      listMessages: async () => ({ messages: [] }),
      getThread: async () => ({
        id: "thread-draft-after-sent",
        historyId: null,
        messages: [
          threadMessage({
            id: "message-inbound",
            threadId: "thread-draft-after-sent",
            labelIds: ["INBOX"],
            internalDate: "1000",
            from: "sender@example.com",
          }),
          threadMessage({
            id: "message-sent",
            threadId: "thread-draft-after-sent",
            labelIds: ["SENT"],
            internalDate: "2000",
            from: "alex@example.com",
          }),
          threadMessage({
            id: "message-draft",
            threadId: "thread-draft-after-sent",
            labelIds: ["DRAFT"],
            internalDate: "3000",
            from: "alex@example.com",
          }),
        ],
      }),
      archiveMessages: async (input) => archiveCalls.push(input),
    },
    now: () => new Date("2026-07-29T18:00:00Z"),
  });

  assert.deepEqual(archiveCalls, [{ messageIds: ["message-inbound"] }]);
  assert.deepEqual(emailState(dbPath, "email-draft-after-sent"), {
    status: "actioned",
    workflow_state: "terminal",
    completion_reason: "sent_reply",
  });
});
