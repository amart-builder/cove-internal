import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalCRMBackend } from "../src/lib/crm/index.ts";
import { createEmailClassificationHandler } from "../src/lib/email/classification-job.ts";
import { observeInboundMessage } from "../src/lib/email/state-machine.ts";
import { openLocalDatabase } from "../src/lib/local/database.ts";
import { listFailures } from "../src/lib/reliability/failures.ts";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-email-crm-context-"));
  const previousDataDir = process.env.COVE_DATA_DIR;
  process.env.COVE_DATA_DIR = dir;
  t.after(() => {
    if (previousDataDir === undefined) delete process.env.COVE_DATA_DIR;
    else process.env.COVE_DATA_DIR = previousDataDir;
    // The OS temporary directory is left for its normal cleanup policy.
  });
  return { dir, dbPath: path.join(dir, "cove.db") };
}

function job(observed, messageId) {
  return {
    id: `job-${messageId}`,
    type: "email-classify",
    payload: {
      messageId,
      emailItemId: observed.emailItemId,
      threadVersion: observed.threadVersion,
    },
    priority: 0,
    runAfter: new Date(0).toISOString(),
    leaseUntil: null,
    attempts: 1,
    maxAttempts: 5,
    status: "leased",
    idempotencyKey: `email-classify:${messageId}`,
    createdAt: new Date(0).toISOString(),
    finishedAt: null,
    lastError: null,
  };
}

function handlerFor({ dbPath, dataDir, messageId, threadId, from, captured, reply = false }) {
  return createEmailClassificationHandler({
    dbPath,
    dataDir,
    accountEmail: "alex@example.com",
    gateway: {
      getMessage: async () => ({
        id: messageId,
        threadId,
        historyId: "10",
        labelIds: ["INBOX"],
        internalDate: "1000",
        headers: [
          { name: "From", value: from },
          { name: "Subject", value: "Checking in" },
        ],
        snippet: "Quick question.",
        text: "Quick question about the pilot.",
      }),
      modifyThreadLabels: async () => {},
    },
    classifier: async (input) => {
      captured.push(input.recentContext);
      return {
        bucket: reply ? "reply" : "fyi",
        summary: "A quick question about the pilot.",
        recommendedAction: null,
        draftBody: reply ? "Thanks for checking in." : null,
        commitments: [],
        recordCorrespondence: false,
        modelVersion: "test",
      };
    },
  });
}

test("a known sender's CRM context reaches the classifier", async (t) => {
  const { dbPath } = fixture(t);
  const crm = new LocalCRMBackend({ dbPath });
  const created = crm.resolveOrCreateContact({
    name: "Sarah Chen",
    email: "sarah@work.com",
    role: "CTO",
    source: "manual",
  });
  crm.appendActivity({
    contactId: created.contact.id,
    activityType: "meeting_summary",
    title: "Pilot kickoff",
    content: "Agreed on the scope.",
    source: "manual",
  });
  crm.close();
  const db = openLocalDatabase(dbPath);
  try {
    db.prepare(
      `INSERT INTO pipeline_deals
         (id, contact_id, stage, next_action, next_follow_up_at, source, notes,
          stage_changed_at, created_at, updated_at)
       VALUES ('deal-context', ?, 'proposal', 'Wait for approval', '2026-08-05', '', '',
               '2026-08-03T12:00:00.000Z', '2026-08-03T12:00:00.000Z', '2026-08-03T12:00:00.000Z')`,
    ).run(created.contact.id);
    db.prepare(
      `INSERT INTO commitments
         (id, kind, title, source_kind, contact_id, status, created_at, updated_at)
       VALUES ('context-commitment', 'waiting_on', 'Their signed SOW', 'detector',
               ?, 'open', '2026-08-03T12:00:00.000Z', '2026-08-03T12:00:00.000Z')`,
    ).run(created.contact.id);
  } finally {
    db.close();
  }

  const observed = observeInboundMessage({
    messageId: "m-context",
    threadId: "t-context",
    internalDate: "1000",
    accountEmail: "alex@example.com",
    dbPath,
  });
  const captured = [];
  const result = await handlerFor({
    dbPath,
    messageId: "m-context",
    threadId: "t-context",
    from: '"Sarah Chen" <sarah@work.com>',
    captured,
  })(job(observed, "m-context"));

  assert.equal(result.actions.applied, true);
  assert.equal(captured.length, 1);
  assert.match(captured[0], /Cove records for Sarah Chen/);
  assert.match(captured[0], /Pilot kickoff/);
  assert.match(captured[0], /stage=Proposal out/);
  assert.match(captured[0], /Their signed SOW/);
  assert.ok(captured[0].length <= 6_000);
});

test("an unknown sender classifies without context", async (t) => {
  const { dbPath } = fixture(t);
  const observed = observeInboundMessage({
    messageId: "m-unknown",
    threadId: "t-unknown",
    internalDate: "1000",
    accountEmail: "alex@example.com",
    dbPath,
  });
  const captured = [];
  const result = await handlerFor({
    dbPath,
    messageId: "m-unknown",
    threadId: "t-unknown",
    from: "Stranger Person <stranger@example.com>",
    captured,
  })(job(observed, "m-unknown"));

  assert.equal(result.actions.applied, true);
  assert.deepEqual(captured, [undefined]);
});

test("a CRM exception still classifies but withholds a reply draft and records a failure", async (t) => {
  const { dir, dbPath } = fixture(t);
  // An external CRM configuration makes every CRM call throw.
  writeFileSync(
    path.join(dir, "cove-crm.json"),
    JSON.stringify({ backend: "external" }),
  );
  const observed = observeInboundMessage({
    messageId: "m-crm-down",
    threadId: "t-crm-down",
    internalDate: "1000",
    accountEmail: "alex@example.com",
    dbPath,
    dataDir: dir,
  });
  const captured = [];
  const result = await handlerFor({
    dbPath,
    messageId: "m-crm-down",
    threadId: "t-crm-down",
    from: '"Sarah Chen" <sarah@work.com>',
    captured,
    reply: true,
  })(job(observed, "m-crm-down"));

  assert.equal(result.actions.applied, true);
  assert.equal(result.actions.bucket, "action");
  assert.deepEqual(captured, [undefined]);
  const db = openLocalDatabase(dbPath);
  try {
    const item = db.prepare("SELECT bucket, draft_response, recommended_action FROM email_items").get();
    assert.equal(item.bucket, "action");
    assert.equal(item.draft_response, null);
    assert.match(item.recommended_action, /Cove records were unavailable/);
    assert.equal(db.prepare("SELECT count(*) AS count FROM cove_gmail_operations").get().count, 0);
  } finally {
    db.close();
  }
  assert.equal(listFailures({ dbPath }).some((failure) => failure.sourceId === "gmail:t-crm-down"), true);
});

test("an ambiguous sender still classifies but receives no draft and a visible failure", async (t) => {
  const { dbPath } = fixture(t);
  const db = openLocalDatabase(dbPath);
  try {
    const now = new Date().toISOString();
    for (const id of ["duplicate-a", "duplicate-b"]) {
      db.prepare(
        `INSERT INTO contacts
           (id, name, email, normalized_email, tags, notes, created_at, updated_at)
         VALUES (?, ?, 'same@example.com', 'same@example.com', '[]', '', ?, ?)`,
      ).run(id, id, now, now);
    }
  } finally {
    db.close();
  }
  const observed = observeInboundMessage({
    messageId: "m-ambiguous", threadId: "t-ambiguous", internalDate: "1000",
    accountEmail: "alex@example.com", dbPath,
  });
  const captured = [];
  const result = await handlerFor({
    dbPath, messageId: "m-ambiguous", threadId: "t-ambiguous",
    from: "Duplicate <same@example.com>", captured, reply: true,
  })(job(observed, "m-ambiguous"));
  assert.equal(result.actions.bucket, "action");
  const check = openLocalDatabase(dbPath);
  try {
    const item = check.prepare("SELECT bucket, draft_response, recommended_action FROM email_items").get();
    assert.equal(item.bucket, "action");
    assert.equal(item.draft_response, null);
    assert.match(item.recommended_action, /ambiguous \(2 candidates\)/);
  } finally {
    check.close();
  }
  assert.equal(listFailures({ dbPath }).some((failure) => failure.sourceId === "gmail:t-ambiguous"), true);
});

test("a missing sender address classifies without context", async (t) => {
  const { dbPath } = fixture(t);
  const observed = observeInboundMessage({
    messageId: "m-no-sender",
    threadId: "t-no-sender",
    internalDate: "1000",
    accountEmail: "alex@example.com",
    dbPath,
  });
  const captured = [];
  const result = await handlerFor({
    dbPath,
    messageId: "m-no-sender",
    threadId: "t-no-sender",
    from: "",
    captured,
  })(job(observed, "m-no-sender"));

  assert.equal(result.actions.applied, true);
  assert.deepEqual(captured, [undefined]);
});
