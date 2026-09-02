import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LocalCRMBackend } from '../src/lib/crm/index.ts';
import { reconcileEmailDraftsForContact } from '../src/lib/email/automation.ts';
import { createEmailClassificationHandler } from '../src/lib/email/classification-job.ts';
import { createGmailOperationHandler, reconcileDeadEmailJobs } from '../src/lib/email/gmail-outbox.ts';
import { applyEmailClassification, observeInboundMessage } from '../src/lib/email/state-machine.ts';
import { openLocalDatabase } from '../src/lib/local/database.ts';
import { JobScheduler } from '../src/lib/reliability/jobs.ts';

function scheduled(type, payload, id = `job-${type}`) {
  return {
    id, type, payload, priority: 0, runAfter: new Date(0).toISOString(), leaseUntil: null,
    attempts: 1, maxAttempts: 5, status: 'leased', idempotencyKey: id,
    createdAt: new Date(0).toISOString(), finishedAt: null, lastError: null,
  };
}

function value(dbPath, sql, ...params) {
  const db = openLocalDatabase(dbPath);
  try { return db.prepare(sql).get(...params); } finally { db.close(); }
}

function ownedDraftFixture({
  draftedAt = '2026-09-02T10:30:00Z',
  receivedAt = '2026-09-02T10:00:00Z',
} = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-owned-draft-'));
  const dbPath = path.join(dir, 'cove.db');
  const crm = new LocalCRMBackend({ dbPath });
  const contact = crm.resolveOrCreateContact({
    name: 'Morgan Lee', email: 'morgan@example.com', source: 'manual',
  }).contact;
  crm.close();
  const observed = observeInboundMessage({
    messageId: 'message-owned', threadId: 'thread-owned', internalDate: '1000',
    accountEmail: 'alex@example.com', senderName: 'Morgan Lee', senderEmail: 'morgan@example.com',
    subject: 'Next step', receivedAt, dbPath, now: new Date(receivedAt),
  });
  const db = openLocalDatabase(dbPath);
  try {
    db.prepare(`UPDATE email_items
      SET workflow_state = 'open', gmail_draft_id = 'draft-owned',
          draft_body_hash = 'owned-hash', draft_response = 'Owned draft',
          recommended_action = 'reply'
      WHERE id = ?`).run(observed.emailItemId);
    db.prepare(`UPDATE cove_email_messages SET state = 'processed'
      WHERE message_id = 'message-owned'`).run();
    db.prepare(`UPDATE cove_jobs SET status = 'done', finished_at = ?
      WHERE idempotency_key = 'email-classify:message-owned'`).run(draftedAt);
    db.prepare(`INSERT INTO email_draft_outcomes
      (email_item_id, thread_id, gmail_draft_id, draft_body, draft_body_hash, drafted_at)
      VALUES (?, 'thread-owned', 'draft-owned', 'Owned draft', 'owned-hash', ?)`)
      .run(observed.emailItemId, draftedAt);
  } finally {
    db.close();
  }
  return { dir, dbPath, contact, observed, receivedAt, draftedAt };
}

async function preparedRefresh(editedText) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-draft-refresh-'));
  const dbPath = path.join(dir, 'cove.db');
  const crm = new LocalCRMBackend({ dbPath });
  const contact = crm.resolveOrCreateContact({ name: 'Morgan Lee', email: 'morgan@example.com', source: 'manual' }).contact;
  crm.close();
  const observed = observeInboundMessage({
    messageId: 'message-1', threadId: 'thread-1', internalDate: '1000',
    accountEmail: 'alex@example.com', senderName: 'Morgan Lee', senderEmail: 'morgan@example.com',
    subject: 'Next step', dbPath, now: new Date('2026-09-02T10:00:00Z'),
  });
  let pass = 0;
  const contexts = [];
  const classificationHandler = (now) => createEmailClassificationHandler({
    dbPath, dataDir: dir, accountEmail: 'alex@example.com', now: () => now,
    gateway: {
      getMessage: async () => ({
        id: 'message-1', threadId: 'thread-1', internalDate: '1000', labelIds: ['INBOX'],
        headers: [{ name: 'From', value: 'Morgan Lee <morgan@example.com>' }, { name: 'Subject', value: 'Next step' }],
        snippet: 'What next?', text: 'What should we do next?',
      }),
      modifyThreadLabels: async () => {},
    },
    classifier: async (input) => {
      pass += 1;
      contexts.push(input.recentContext);
      return {
        bucket: 'reply', summary: 'Reply needed.', recommendedAction: 'reply',
        draftBody: pass === 1 ? 'First Cove draft.' : 'Updated from the meeting.',
        commitments: [], recordCorrespondence: false, modelVersion: 'fake',
      };
    },
  });
  const first = await classificationHandler(new Date('2026-09-02T10:01:00Z'))(
    scheduled('email-classify', {
      messageId: 'message-1', emailItemId: observed.emailItemId, threadVersion: 1,
    }),
  );
  await createGmailOperationHandler({
    dbPath, dataDir: dir, cachedSignature: null, now: () => new Date('2026-09-02T10:02:00Z'),
    gateway: {
      listDrafts: async () => ({ drafts: [] }),
      createReplyDraft: async () => ({ id: 'draft-1', messageId: 'draft-message-1', threadId: 'thread-1' }),
    },
  })(scheduled('gmail-operation', { operationId: first.actions.operationId }));
  const crmAfter = new LocalCRMBackend({ dbPath });
  const summary = crmAfter.appendActivity({
    contactId: contact.id, activityType: 'meeting_summary', title: 'Decision meeting',
    content: 'Morgan approved the September 9 launch.', source: 'meeting-notes',
    occurredAt: '2026-09-02T11:00:00Z',
  });
  crmAfter.close();
  const reconciled = reconcileEmailDraftsForContact({
    contactId: contact.id, occurredAt: '2026-09-02T11:00:00Z', reason: summary.id,
    dbPath, now: new Date('2026-09-02T11:01:00Z'),
  });
  assert.deepEqual(reconciled, { queued: 1, skipped: 0 });
  const refreshJob = value(dbPath, "SELECT * FROM cove_jobs WHERE idempotency_key LIKE 'email-draft-refresh:%'");
  const refreshed = await classificationHandler(new Date('2026-09-02T11:02:00Z'))(
    scheduled('email-classify', JSON.parse(refreshJob.payload), refreshJob.id),
  );
  const operation = value(dbPath, 'SELECT * FROM cove_gmail_operations WHERE id = ?', refreshed.actions.operationId);
  const payload = JSON.parse(operation.payload_json);
  assert.equal(payload.existingDraftId, 'draft-1');
  let update;
  await createGmailOperationHandler({
    dbPath, dataDir: dir, cachedSignature: null, now: () => new Date('2026-09-02T11:03:00Z'),
    gateway: {
      listDrafts: async () => ({ drafts: [
        { id: 'unrelated-draft', messageId: 'unrelated-message', threadId: 'thread-1' },
        { id: 'draft-1', messageId: 'draft-message-1', threadId: 'thread-1' },
      ] }),
      getMessage: async ({ format }) => format === 'metadata'
        ? { id: 'draft-message-1', threadId: 'thread-1', headers: [{ name: 'X-Cove-Operation-Id', value: 'old-operation' }], text: '' }
        : { id: 'draft-message-1', threadId: 'thread-1', headers: [], text: editedText ?? 'First Cove draft.' },
      createReplyDraft: async (input) => {
        update = input;
        return { id: 'draft-1', messageId: 'draft-message-2', threadId: 'thread-1' };
      },
    },
  })(scheduled('gmail-operation', { operationId: operation.id }));
  return { dbPath, contexts, update };
}

test('a later meeting queues reclassification and updates the existing Cove draft', async () => {
  const result = await preparedRefresh();
  assert.match(result.contexts[1], /Morgan approved the September 9 launch/);
  assert.equal(result.update.existingDraftId, 'draft-1');
  assert.equal(result.update.body, 'Updated from the meeting.');
});

test('an operator-edited Gmail draft is preserved during refresh', async () => {
  const result = await preparedRefresh('Operator changed this draft.');
  assert.equal(result.update, undefined);
  const item = value(result.dbPath, 'SELECT draft_body_hash, recommended_action FROM email_items');
  assert.equal(item.draft_body_hash, null);
  assert.match(item.recommended_action, /Review the existing Gmail draft/);
});

test('a draft written after note receipt but before summary creation is queued', () => {
  const fixture = ownedDraftFixture({
    receivedAt: '2026-09-02T11:00:00Z',
    draftedAt: '2026-09-02T11:30:00Z',
  });
  const result = reconcileEmailDraftsForContact({
    contactId: fixture.contact.id,
    occurredAt: '2026-09-02T12:00:00Z',
    reason: 'summary-activity',
    dbPath: fixture.dbPath,
    now: new Date('2026-09-02T12:00:01Z'),
  });
  assert.deepEqual(result, { queued: 1, skipped: 0 });
});

test('a draft written after the summary gets an honest skip receipt', () => {
  const fixture = ownedDraftFixture({ draftedAt: '2026-09-02T12:30:00Z' });
  const result = reconcileEmailDraftsForContact({
    contactId: fixture.contact.id,
    occurredAt: '2026-09-02T12:00:00Z',
    reason: 'summary-before-draft',
    dbPath: fixture.dbPath,
    now: new Date('2026-09-02T12:31:00Z'),
  });
  assert.deepEqual(result, { queued: 0, skipped: 1 });
  const receipt = value(
    fixture.dbPath,
    `SELECT summary FROM cove_receipts WHERE source = 'email-surfaced'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  );
  assert.match(receipt.summary, /draft was written at or after the meeting summary landed/i);
  assert.doesNotMatch(receipt.summary, /could not prove/i);
});

test('a dead draft refresh returns the email item to the failed card path', async () => {
  const fixture = ownedDraftFixture();
  reconcileEmailDraftsForContact({
    contactId: fixture.contact.id,
    occurredAt: '2026-09-02T12:00:00Z',
    reason: 'summary-dead-refresh',
    dbPath: fixture.dbPath,
    now: new Date('2026-09-02T12:00:00Z'),
  });
  let clock = new Date('2026-09-02T12:00:01Z');
  const scheduler = new JobScheduler({
    dbPath: fixture.dbPath,
    now: () => clock,
    backoffBaseMs: 1,
    maxBackoffMs: 1,
  });
  scheduler.register('email-classify', createEmailClassificationHandler({
    dbPath: fixture.dbPath,
    dataDir: fixture.dir,
    accountEmail: 'alex@example.com',
    now: () => clock,
    gateway: {
      getMessage: async () => ({
        id: 'message-owned', threadId: 'thread-owned', internalDate: '1000',
        labelIds: ['INBOX'],
        headers: [
          { name: 'From', value: 'Morgan Lee <morgan@example.com>' },
          { name: 'Subject', value: 'Next step' },
        ],
        snippet: 'What next?', text: 'What should we do next?',
      }),
      modifyThreadLabels: async () => {},
    },
    classifier: async () => {
      throw new Error('classifier unavailable');
    },
  }));
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const drained = await scheduler.runAvailable({ concurrency: 1, maxJobs: 1 });
      assert.equal(drained.claimed, 1);
      clock = new Date(clock.getTime() + 1_001);
    }
    const refresh = scheduler.listJobs().find((job) =>
      job.idempotencyKey.startsWith('email-draft-refresh:')
    );
    assert.equal(refresh.status, 'dead');
  } finally {
    scheduler.close();
  }
  assert.equal(reconcileDeadEmailJobs({ dbPath: fixture.dbPath, now: clock }).classifications, 1);
  assert.deepEqual(
    value(fixture.dbPath, 'SELECT workflow_state, status FROM email_items WHERE id = ?', fixture.observed.emailItemId),
    { workflow_state: 'failed', status: 'pending' },
  );
  assert.equal(
    value(fixture.dbPath, `SELECT COUNT(*) AS count FROM email_items
      WHERE id = ? AND status = 'pending'
        AND workflow_state IN ('open','finalizing','failed')`, fixture.observed.emailItemId).count,
    1,
  );
});

test('withholding a replacement warns that the older Cove draft remains in Gmail', () => {
  const fixture = ownedDraftFixture();
  const db = openLocalDatabase(fixture.dbPath);
  try {
    db.prepare(`UPDATE email_items SET workflow_state = 'observed'
      WHERE id = ?`).run(fixture.observed.emailItemId);
    db.prepare(`UPDATE cove_email_messages SET state = 'observed'
      WHERE message_id = 'message-owned'`).run();
  } finally {
    db.close();
  }
  const applied = applyEmailClassification({
    messageId: 'message-owned',
    emailItemId: fixture.observed.emailItemId,
    threadVersion: fixture.observed.threadVersion,
    bucket: 'action',
    summary: 'Reply context is unavailable.',
    recommendedAction: 'Cove withheld the reply draft: Cove records were unavailable. Fix the contact record in CRM, then rerun triage.',
    draftBody: null,
    modelVersion: 'test',
    dbPath: fixture.dbPath,
  });
  assert.equal(applied.applied, true);
  const item = value(fixture.dbPath, 'SELECT gmail_draft_id, recommended_action FROM email_items WHERE id = ?', fixture.observed.emailItemId);
  assert.equal(item.gmail_draft_id, 'draft-owned');
  assert.match(item.recommended_action, /An older Cove draft is still in Gmail; check it before sending\.$/);
});
