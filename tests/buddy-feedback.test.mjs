import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buddyFeedbackAssistantText,
  composeFeedbackMessage,
  prepareBuddyFeedback,
} from '../src/lib/buddy/feedback.ts';

function fixture(t) {
  const dir = path.join(
    os.tmpdir(),
    `cove-feedback-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    dbPath: path.join(dir, 'forge.db'),
  };
}

test('feedback copy includes version, view, recipient, and the user note', () => {
  const composed = composeFeedbackMessage({
    message: '  The card   is hard to read. ',
    pageContext: { view: 'tasks' },
    supportEmail: 'help@example.test',
    now: new Date('2026-07-29T18:00:00.000Z'),
  });
  assert.equal(composed.to, 'help@example.test');
  assert.match(composed.subject, /^Cove feedback: The card is hard to read\./);
  assert.match(composed.body, /^Context: Cove 0\.1\.0, view tasks, 2026-07-29T18:00:00\.000Z/m);
  assert.match(composed.body, /The card is hard to read\.$/);
});

test('feedback falls back to a copyable message when email is not connected', async (t) => {
  const { dir, dbPath } = fixture(t);
  writeFileSync(
    path.join(dir, 'cove-support.json'),
    JSON.stringify({ support_email: 'support@example.test' }),
  );
  const feedback = await prepareBuddyFeedback({
    message: 'The button did not respond.',
    pageContext: { view: 'tasks' },
    dataDir: dir,
    dbPath,
    now: new Date('2026-07-29T18:00:00.000Z'),
  });
  assert.equal(feedback.mode, 'copy');
  assert.equal(feedback.fallbackReason, 'email_not_connected');
  assert.equal(feedback.to, 'support@example.test');
  assert.match(feedback.body, /The button did not respond\./);
  assert.equal(
    buddyFeedbackAssistantText(feedback),
    'Email is not connected, so I made a message you can copy.',
  );
});

test('feedback uses the connected Gmail draft lane but never a send lane', async (t) => {
  const { dir, dbPath } = fixture(t);
  writeFileSync(
    path.join(dir, 'cove-support.json'),
    JSON.stringify({ support_email: 'support@example.test' }),
  );
  writeFileSync(
    path.join(dir, 'cove-workspace.json'),
    JSON.stringify({
      provider: 'google-api',
      account_email: 'owner@example.test',
    }),
  );
  let captured;
  const feedback = await prepareBuddyFeedback({
    message: 'I found a small layout bug.',
    dataDir: dir,
    dbPath,
    createDraft: async (connection, message) => {
      captured = { connection, message };
      return 'draft_123';
    },
  });
  assert.equal(feedback.mode, 'gmail_draft');
  assert.equal(feedback.draftId, 'draft_123');
  assert.equal(captured.connection.accountEmail, 'owner@example.test');
  assert.match(captured.message.body, /small layout bug/);
});

test('feedback with no configured support address never attempts a Gmail draft', async (t) => {
  const { dir, dbPath } = fixture(t);
  writeFileSync(
    path.join(dir, 'cove-workspace.json'),
    JSON.stringify({
      provider: 'google-api',
      account_email: 'owner@example.test',
    }),
  );
  let attempted = false;
  const feedback = await prepareBuddyFeedback({
    message: 'The button did not respond.',
    dataDir: dir,
    dbPath,
    createDraft: async () => {
      attempted = true;
      return 'draft_should_not_exist';
    },
  });
  assert.equal(attempted, false);
  assert.equal(feedback.mode, 'copy');
  assert.equal(feedback.to, '');
  assert.equal(feedback.fallbackReason, 'support_not_configured');
  assert.equal(
    buddyFeedbackAssistantText(feedback),
    'No feedback address is set up, so here is the message to copy.',
  );
});

test('a failed Gmail draft is distinguished from a disconnected inbox', async (t) => {
  const { dir, dbPath } = fixture(t);
  writeFileSync(
    path.join(dir, 'cove-support.json'),
    JSON.stringify({ support_email: 'support@example.test' }),
  );
  writeFileSync(
    path.join(dir, 'cove-workspace.json'),
    JSON.stringify({
      provider: 'google-api',
      account_email: 'owner@example.test',
    }),
  );
  const feedback = await prepareBuddyFeedback({
    message: 'Draft creation should fail safely.',
    dataDir: dir,
    dbPath,
    createDraft: async () => {
      throw new Error('Google unavailable');
    },
  });
  assert.equal(feedback.mode, 'copy');
  assert.equal(feedback.fallbackReason, 'draft_failed');
  assert.equal(
    buddyFeedbackAssistantText(feedback),
    "I couldn't create the Gmail draft, so here is the message to copy.",
  );
});
