import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEmailClassificationHandler } from "../src/lib/email/classification-job.ts";
import { createGmailOperationHandler } from "../src/lib/email/gmail-outbox.ts";
import {
  applyEmailClassification,
  observeInboundMessage,
  requestEmailCompletion,
} from "../src/lib/email/state-machine.ts";
import { openLocalDatabase } from "../src/lib/local/database.ts";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-email-state-"));
  t.after(() => {
    // The OS temporary directory is left for its normal cleanup policy.
  });
  return path.join(dir, "cove.db");
}

function row(dbPath, sql, ...params) {
  const db = openLocalDatabase(dbPath);
  try {
    return db.prepare(sql).get(...params);
  } finally {
    db.close();
  }
}

function fakeJob(operationId) {
  return {
    id: `job-${operationId}`,
    type: "gmail-operation",
    payload: { operationId },
    priority: 0,
    runAfter: new Date(0).toISOString(),
    leaseUntil: null,
    attempts: 1,
    maxAttempts: 5,
    status: "leased",
    idempotencyKey: `gmail-operation:${operationId}`,
    createdAt: new Date(0).toISOString(),
    finishedAt: null,
    lastError: null,
  };
}

test("one inbound message creates one canonical thread and one classification job", (t) => {
  const dbPath = fixture(t);
  const first = observeInboundMessage({
    messageId: "m1",
    threadId: "t1",
    internalDate: "1000",
    accountEmail: "alex@example.com",
    subject: "Need a decision",
    dbPath,
    now: new Date("2026-07-29T12:00:00Z"),
  });
  const duplicate = observeInboundMessage({
    messageId: "m1",
    threadId: "t1",
    internalDate: "1000",
    accountEmail: "alex@example.com",
    dbPath,
    now: new Date("2026-07-29T12:01:00Z"),
  });
  assert.equal(first.inserted, true);
  assert.equal(first.threadVersion, 1);
  assert.equal(duplicate.inserted, false);
  assert.equal(
    row(dbPath, "SELECT COUNT(*) AS count FROM email_items WHERE thread_id = 't1'").count,
    1,
  );
  assert.equal(
    row(dbPath, "SELECT COUNT(*) AS count FROM cove_jobs WHERE type = 'email-classify'").count,
    1,
  );
});

test("Gmail history id orders distinct inbound messages with the same millisecond", (t) => {
  const dbPath = fixture(t);
  const first = observeInboundMessage({
    messageId: "m-same-time-1",
    threadId: "t-same-time",
    gmailHistoryId: "100",
    internalDate: "1000",
    accountEmail: "alex@example.com",
    dbPath,
  });
  const second = observeInboundMessage({
    messageId: "m-same-time-2",
    threadId: "t-same-time",
    gmailHistoryId: "101",
    internalDate: "1000",
    accountEmail: "alex@example.com",
    dbPath,
  });
  assert.equal(first.threadVersion, 1);
  assert.equal(second.newer, true);
  assert.equal(second.threadVersion, 2);
  assert.equal(
    row(
      dbPath,
      "SELECT latest_inbound_message_id FROM email_items WHERE id = ?",
      first.emailItemId,
    ).latest_inbound_message_id,
    "m-same-time-2",
  );
});

test("ungrounded model commitment quotes never enter the durable artifact job", async (t) => {
  const dbPath = fixture(t);
  const observed = observeInboundMessage({
    messageId: "m-grounding",
    threadId: "t-grounding",
    internalDate: "1000",
    accountEmail: "alex@example.com",
    dbPath,
  });
  const handler = createEmailClassificationHandler({
    dbPath,
    accountEmail: "alex@example.com",
    gateway: {
      getMessage: async () => ({
        id: "m-grounding",
        threadId: "t-grounding",
        historyId: "10",
        labelIds: ["INBOX"],
        internalDate: "1000",
        headers: [
          { name: "From", value: "Person <person@example.com>" },
          { name: "Subject", value: "Simple update" },
        ],
        snippet: "Here is the update.",
        text: "Here is the update. No promises were made.",
      }),
      modifyThreadLabels: async () => {},
    },
    classifier: async () => ({
      bucket: "action",
      summary: "Review the update.",
      recommendedAction: "review",
      draftBody: null,
      commitments: [{
        kind: "follow_up",
        title: "Send a proposal",
        sourceQuote: "I promise to send a proposal tomorrow.",
        dueAt: null,
      }],
      recordCorrespondence: false,
      modelVersion: "test",
    }),
  });
  await handler({
    ...fakeJob("classification"),
    type: "email-classify",
    payload: {
      messageId: "m-grounding",
      emailItemId: observed.emailItemId,
      threadVersion: observed.threadVersion,
    },
  });
  const artifactPayload = row(
    dbPath,
    "SELECT payload FROM cove_jobs WHERE type = 'email-artifacts'",
  ).payload;
  assert.deepEqual(JSON.parse(artifactPayload).commitments, []);
});

test("FYI is durably surfaced before archive and becomes terminal only after Gmail success", async (t) => {
  const dbPath = fixture(t);
  const observed = observeInboundMessage({
    messageId: "m-fyi",
    threadId: "t-fyi",
    internalDate: "2000",
    accountEmail: "alex@example.com",
    subject: "Receipt",
    dbPath,
    now: new Date("2026-07-29T12:00:00Z"),
  });
  const classification = applyEmailClassification({
    messageId: "m-fyi",
    emailItemId: observed.emailItemId,
    threadVersion: observed.threadVersion,
    bucket: "fyi",
    summary: "A useful receipt.",
    modelVersion: "test",
    dbPath,
    now: new Date("2026-07-29T12:01:00Z"),
  });
  const before = row(
    dbPath,
    "SELECT workflow_state, status, surface_receipt_id FROM email_items WHERE id = ?",
    observed.emailItemId,
  );
  assert.equal(before.workflow_state, "finalizing");
  assert.equal(before.status, "pending");
  assert.ok(before.surface_receipt_id);
  const calls = [];
  const handler = createGmailOperationHandler({
    dbPath,
    now: () => new Date("2026-07-29T12:02:00Z"),
    gateway: {
      getThread: async () => ({
        id: "t-fyi",
        historyId: "1",
        messages: [
          {
            id: "m-fyi-old",
            threadId: "t-fyi",
            labelIds: ["INBOX"],
            internalDate: "1000",
            headers: [],
            snippet: "",
            text: "",
          },
          {
            id: "m-fyi",
            threadId: "t-fyi",
            labelIds: ["INBOX"],
            internalDate: "2000",
            headers: [],
            snippet: "",
            text: "",
          },
          {
            id: "m-fyi-newer",
            threadId: "t-fyi",
            labelIds: ["INBOX"],
            internalDate: "3000",
            headers: [],
            snippet: "",
            text: "",
          },
        ],
      }),
      archiveMessages: async ({ messageIds }) => calls.push(messageIds),
    },
  });
  await handler(fakeJob(classification.operationId));
  assert.deepEqual(calls, [["m-fyi-old", "m-fyi"]]);
  const after = row(
    dbPath,
    "SELECT workflow_state, status FROM email_items WHERE id = ?",
    observed.emailItemId,
  );
  assert.deepEqual(after, { workflow_state: "terminal", status: "actioned" });
});

test("new inbound reopens the same thread and supersedes an older archive operation", (t) => {
  const dbPath = fixture(t);
  const first = observeInboundMessage({
    messageId: "m-old",
    threadId: "t-reopen",
    internalDate: "1000",
    accountEmail: "alex@example.com",
    dbPath,
    now: new Date("2026-07-29T12:00:00Z"),
  });
  applyEmailClassification({
    messageId: "m-old",
    emailItemId: first.emailItemId,
    threadVersion: first.threadVersion,
    bucket: "action",
    summary: "Do the work.",
    modelVersion: "test",
    dbPath,
  });
  const completion = requestEmailCompletion({
    emailItemId: first.emailItemId,
    reason: "card",
    dbPath,
  });
  const second = observeInboundMessage({
    messageId: "m-new",
    threadId: "t-reopen",
    internalDate: "2000",
    accountEmail: "alex@example.com",
    dbPath,
    now: new Date("2026-07-29T13:00:00Z"),
  });
  assert.equal(second.emailItemId, first.emailItemId);
  assert.equal(second.threadVersion, 2);
  const item = row(
    dbPath,
    "SELECT workflow_state, status, latest_inbound_message_id FROM email_items WHERE id = ?",
    first.emailItemId,
  );
  assert.deepEqual(item, {
    workflow_state: "observed",
    status: "pending",
    latest_inbound_message_id: "m-new",
  });
  assert.equal(
    row(dbPath, "SELECT status FROM cove_gmail_operations WHERE id = ?", completion.operationId).status,
    "superseded",
  );
});

test("a dead archive operation can be requeued without duplicating its ledger row", (t) => {
  const dbPath = fixture(t);
  const observed = observeInboundMessage({
    messageId: "m-requeue",
    threadId: "t-requeue",
    internalDate: "1000",
    accountEmail: "alex@example.com",
    dbPath,
  });
  applyEmailClassification({
    messageId: "m-requeue",
    emailItemId: observed.emailItemId,
    threadVersion: observed.threadVersion,
    bucket: "action",
    summary: "Review the request.",
    modelVersion: "test",
    dbPath,
  });
  const first = requestEmailCompletion({
    emailItemId: observed.emailItemId,
    reason: "card",
    dbPath,
  });
  const db = openLocalDatabase(dbPath);
  try {
    db.prepare(
      "UPDATE cove_gmail_operations SET status = 'dead' WHERE id = ?",
    ).run(first.operationId);
    db.prepare(
      "UPDATE cove_jobs SET status = 'dead', attempts = max_attempts WHERE id = ?",
    ).run(first.jobId);
  } finally {
    db.close();
  }
  const retry = requestEmailCompletion({
    emailItemId: observed.emailItemId,
    reason: "card",
    dbPath,
  });
  assert.equal(retry.operationId, first.operationId);
  assert.equal(retry.jobId, first.jobId);
  assert.deepEqual(
    row(
      dbPath,
      `SELECT operation.status AS operation_status, job.status AS job_status,
              job.attempts
       FROM cove_gmail_operations operation
       JOIN cove_jobs job ON job.id = operation.job_id
       WHERE operation.id = ?`,
      first.operationId,
    ),
    { operation_status: "pending", job_status: "queued", attempts: 0 },
  );
});

test("a purged dead archive job is replaced and the operation points to it", (t) => {
  const dbPath = fixture(t);
  const observed = observeInboundMessage({
    messageId: "m-purged-requeue",
    threadId: "t-purged-requeue",
    internalDate: "1000",
    accountEmail: "alex@example.com",
    dbPath,
  });
  applyEmailClassification({
    messageId: "m-purged-requeue",
    emailItemId: observed.emailItemId,
    threadVersion: observed.threadVersion,
    bucket: "action",
    summary: "Review the request.",
    modelVersion: "test",
    dbPath,
  });
  const first = requestEmailCompletion({
    emailItemId: observed.emailItemId,
    reason: "card",
    dbPath,
  });
  const db = openLocalDatabase(dbPath);
  try {
    db.prepare(
      "UPDATE cove_gmail_operations SET status = 'dead' WHERE id = ?",
    ).run(first.operationId);
    db.prepare("DELETE FROM cove_jobs WHERE id = ?").run(first.jobId);
  } finally {
    db.close();
  }

  const retry = requestEmailCompletion({
    emailItemId: observed.emailItemId,
    reason: "card",
    dbPath,
  });
  assert.equal(retry.operationId, first.operationId);
  assert.notEqual(retry.jobId, first.jobId);
  assert.deepEqual(
    row(
      dbPath,
      `SELECT operation.status AS operation_status,
              operation.job_id AS operation_job_id,
              job.status AS job_status
       FROM cove_gmail_operations operation
       JOIN cove_jobs job ON job.id = operation.job_id
       WHERE operation.id = ?`,
      first.operationId,
    ),
    {
      operation_status: "pending",
      operation_job_id: retry.jobId,
      job_status: "queued",
    },
  );
});

test("a dead classification is requeued when Gmail presents the untriaged message again", (t) => {
  const dbPath = fixture(t);
  const first = observeInboundMessage({
    messageId: "m-classify-requeue",
    threadId: "t-classify-requeue",
    internalDate: "1000",
    accountEmail: "alex@example.com",
    dbPath,
  });
  const db = openLocalDatabase(dbPath);
  try {
    db.prepare(
      "UPDATE cove_email_messages SET state = 'failed' WHERE message_id = ?",
    ).run("m-classify-requeue");
    db.prepare(
      "UPDATE email_items SET workflow_state = 'failed' WHERE id = ?",
    ).run(first.emailItemId);
    db.prepare(
      `UPDATE cove_jobs SET status = 'dead', attempts = max_attempts
       WHERE idempotency_key = ?`,
    ).run("email-classify:m-classify-requeue");
  } finally {
    db.close();
  }
  const retried = observeInboundMessage({
    messageId: "m-classify-requeue",
    threadId: "t-classify-requeue",
    internalDate: "1000",
    accountEmail: "alex@example.com",
    dbPath,
  });
  assert.equal(retried.inserted, false);
  assert.equal(retried.newer, true);
  assert.deepEqual(
    row(
      dbPath,
      `SELECT message.state AS message_state, job.status AS job_status,
              job.attempts
       FROM cove_email_messages message
       JOIN cove_jobs job
         ON job.idempotency_key = 'email-classify:' || message.message_id
       WHERE message.message_id = ?`,
      "m-classify-requeue",
    ),
    { message_state: "observed", job_status: "queued", attempts: 0 },
  );
});

test("an uncertain draft create is observed and never blindly created again", async (t) => {
  const dbPath = fixture(t);
  const observed = observeInboundMessage({
    messageId: "m-reply",
    threadId: "t-reply",
    internalDate: "1000",
    accountEmail: "alex@example.com",
    dbPath,
  });
  const classified = applyEmailClassification({
    messageId: "m-reply",
    emailItemId: observed.emailItemId,
    threadVersion: observed.threadVersion,
    bucket: "reply",
    summary: "Reply needed.",
    draftBody: "Thanks. I will take a look.",
    modelVersion: "test",
    dbPath,
  });
  const db = openLocalDatabase(dbPath);
  try {
    db.prepare(
      "UPDATE cove_gmail_operations SET status = 'uncertain' WHERE id = ?",
    ).run(classified.operationId);
  } finally {
    db.close();
  }
  let creates = 0;
  const handler = createGmailOperationHandler({
    dbPath,
    gateway: {
      listDrafts: async () => ({ drafts: [] }),
      createReplyDraft: async () => {
        creates += 1;
        return { id: "d1", messageId: "dm1", threadId: "t-reply" };
      },
    },
  });
  await assert.rejects(handler(fakeJob(classified.operationId)), /will not create another/);
  assert.equal(creates, 0);
});

test("draft recovery pages through drafts and matches Cove's operation header", async (t) => {
  const dbPath = fixture(t);
  const observed = observeInboundMessage({
    messageId: "m-paged-reply",
    threadId: "t-paged-reply",
    internalDate: "1000",
    accountEmail: "alex@example.com",
    dbPath,
  });
  const classified = applyEmailClassification({
    messageId: "m-paged-reply",
    emailItemId: observed.emailItemId,
    threadVersion: observed.threadVersion,
    bucket: "reply",
    summary: "Reply needed.",
    draftBody: "I will take a look.",
    modelVersion: "test",
    dbPath,
  });
  const operationKey = row(
    dbPath,
    "SELECT operation_key FROM cove_gmail_operations WHERE id = ?",
    classified.operationId,
  ).operation_key;
  const pageTokens = [];
  let creates = 0;
  const handler = createGmailOperationHandler({
    dbPath,
    gateway: {
      listDrafts: async ({ pageToken }) => {
        pageTokens.push(pageToken);
        return pageToken
          ? {
            drafts: [{
              id: "d-cove",
              messageId: "dm-cove",
              threadId: "t-paged-reply",
            }],
          }
          : {
            drafts: [{
              id: "d-manual",
              messageId: "dm-manual",
              threadId: "t-paged-reply",
            }],
            nextPageToken: "page-2",
          };
      },
      getMessage: async ({ messageId }) => ({
        id: messageId,
        threadId: "t-paged-reply",
        labelIds: ["DRAFT"],
        internalDate: "1000",
        headers: messageId === "dm-cove"
          ? [{ name: "X-Cove-Operation-Id", value: operationKey }]
          : [{ name: "Subject", value: "Manual draft" }],
        snippet: "",
        text: "",
      }),
      createReplyDraft: async () => {
        creates += 1;
        return { id: "unexpected", messageId: "unexpected", threadId: "t-paged-reply" };
      },
    },
  });
  await handler(fakeJob(classified.operationId));
  assert.deepEqual(pageTokens, [undefined, "page-2"]);
  assert.equal(creates, 0);
  assert.equal(
    row(dbPath, "SELECT gmail_draft_id FROM email_items WHERE id = ?", observed.emailItemId)
      .gmail_draft_id,
    "d-cove",
  );
});

test("a newer inbound refreshes Cove's existing draft instead of creating another", async (t) => {
  const dbPath = fixture(t);
  const first = observeInboundMessage({
    messageId: "m-refresh-1",
    threadId: "t-refresh",
    internalDate: "1000",
    accountEmail: "alex@example.com",
    dbPath,
  });
  const firstClassification = applyEmailClassification({
    messageId: "m-refresh-1",
    emailItemId: first.emailItemId,
    threadVersion: first.threadVersion,
    bucket: "reply",
    summary: "Reply to the first message.",
    draftBody: "First draft.",
    modelVersion: "test",
    dbPath,
  });
  let creates = 0;
  let draftExists = false;
  const gateway = {
    listDrafts: async () => ({
      drafts: draftExists
        ? [{ id: "d-refresh", messageId: "dm-refresh", threadId: "t-refresh" }]
        : [],
    }),
    getMessage: async ({ messageId }) => ({
      id: messageId,
      threadId: "t-refresh",
      labelIds: ["DRAFT"],
      internalDate: "1000",
      headers: [{ name: "X-Cove-Operation-Id", value: "old-operation" }],
      snippet: "",
      text: "Alex may have edited this draft.",
    }),
    createReplyDraft: async () => {
      creates += 1;
      draftExists = true;
      return { id: "d-refresh", messageId: "dm-refresh", threadId: "t-refresh" };
    },
  };
  await createGmailOperationHandler({ dbPath, gateway })(
    fakeJob(firstClassification.operationId),
  );

  const second = observeInboundMessage({
    messageId: "m-refresh-2",
    threadId: "t-refresh",
    internalDate: "2000",
    accountEmail: "alex@example.com",
    dbPath,
  });
  const secondClassification = applyEmailClassification({
    messageId: "m-refresh-2",
    emailItemId: second.emailItemId,
    threadVersion: second.threadVersion,
    bucket: "reply",
    summary: "Refresh the reply.",
    draftBody: "Updated draft.",
    modelVersion: "test",
    dbPath,
  });
  await createGmailOperationHandler({ dbPath, gateway })(
    fakeJob(secondClassification.operationId),
  );
  assert.equal(creates, 1);
  assert.deepEqual(
    row(
      dbPath,
      `SELECT gmail_draft_id, draft_body_hash, recommended_action
       FROM email_items WHERE id = ?`,
      first.emailItemId,
    ),
    {
      gmail_draft_id: "d-refresh",
      draft_body_hash: null,
      recommended_action: "Review the existing Gmail draft against the latest message",
    },
  );
});
