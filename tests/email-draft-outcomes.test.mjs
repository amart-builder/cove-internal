import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGmailOperationHandler } from "../src/lib/email/gmail-outbox.ts";
import {
  applyEmailClassification,
  observeInboundMessage,
} from "../src/lib/email/state-machine.ts";
import { openLocalDatabase } from "../src/lib/local/database.ts";

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cove-draft-outcomes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, "cove.db");
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

function setupReply(dbPath, suffix) {
  const observed = observeInboundMessage({
    messageId: `message-${suffix}`,
    threadId: `thread-${suffix}`,
    internalDate: "1000",
    accountEmail: "alex@example.com",
    dbPath,
  });
  const body = `A normalized reply for ${suffix}.`;
  const classified = applyEmailClassification({
    messageId: `message-${suffix}`,
    emailItemId: observed.emailItemId,
    threadVersion: observed.threadVersion,
    bucket: "reply",
    summary: "Reply needed.",
    draftBody: body,
    voiceJudgeScore: 88,
    voiceJudgeVerdict: "The greeting is slightly too formal.",
    modelVersion: "test",
    dbPath,
  });
  return { observed, classified, body };
}

test("migration 20 creates draft outcome history and successful outbox writes append a row", async (t) => {
  const dbPath = await fixture(t);
  const db = openLocalDatabase(dbPath);
  try {
    assert.equal(
      db.prepare("SELECT name FROM cove_schema_migrations WHERE version = 20").pluck().get(),
      "email-draft-outcomes",
    );
    assert.ok(db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'email_draft_outcomes'",
    ).get());
  } finally {
    db.close();
  }

  const { observed, classified, body } = setupReply(dbPath, "success");
  await createGmailOperationHandler({
    dbPath,
    cachedSignature: null,
    warn: () => {},
    gateway: {
      accountEmail: "alex@example.com",
      listDrafts: async () => ({ drafts: [] }),
      createReplyDraft: async (input) => ({
        id: "gmail-draft-1",
        messageId: "gmail-message-1",
        threadId: input.threadId,
      }),
    },
  })(fakeJob(classified.operationId));

  const verify = openLocalDatabase(dbPath);
  try {
    const outcome = verify.prepare(
      `SELECT email_item_id, thread_id, gmail_draft_id, draft_body,
              draft_body_hash, judge_score, judge_verdict, outcome
       FROM email_draft_outcomes`,
    ).get();
    assert.deepEqual(outcome, {
      email_item_id: observed.emailItemId,
      thread_id: "thread-success",
      gmail_draft_id: "gmail-draft-1",
      draft_body: body,
      draft_body_hash: createHash("sha256").update(body).digest("hex"),
      judge_score: 88,
      judge_verdict: "The greeting is slightly too formal.",
      outcome: "pending",
    });
  } finally {
    verify.close();
  }
});

test("outcome insert failure warns but does not fail the Gmail outbox operation", async (t) => {
  const dbPath = await fixture(t);
  const { classified } = setupReply(dbPath, "insert-failure");
  const breakTracking = openLocalDatabase(dbPath);
  breakTracking.exec("DROP TABLE email_draft_outcomes");
  breakTracking.close();
  const warnings = [];
  const result = await createGmailOperationHandler({
    dbPath,
    cachedSignature: null,
    warn: (message) => warnings.push(message),
    gateway: {
      accountEmail: "alex@example.com",
      listDrafts: async () => ({ drafts: [] }),
      createReplyDraft: async (input) => ({
        id: "gmail-draft-failure",
        messageId: "gmail-message-failure",
        threadId: input.threadId,
      }),
    },
  })(fakeJob(classified.operationId));
  assert.equal(result.actions.status, undefined);
  assert.match(result.summary, /Prepared reply draft/);
  assert.ok(warnings.some((message) => /could not record the email draft outcome/i.test(message)));

  const verify = openLocalDatabase(dbPath);
  try {
    assert.equal(
      verify.prepare("SELECT status FROM cove_gmail_operations WHERE id = ?").pluck()
        .get(classified.operationId),
      "succeeded",
    );
  } finally {
    verify.close();
  }
});
