import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveLocalEmailContact,
} from '../scripts/lib/email-triage-contact.mjs';

test('local contact resolution failure is recorded and continues unlinked', async () => {
  const failures = [];
  const result = await resolveLocalEmailContact(
    {
      sender_name: 'Sender Person',
      sender_email: 'sender@example.com',
      message_id: 'message-1',
      thread_id: 'thread-1',
    },
    {
      crmRequest: async () => {
        throw new Error('Next server is unavailable');
      },
      recordFailure: async (failure) => failures.push(failure),
    },
  );

  assert.equal(result, null);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].senderEmail, 'sender@example.com');
  assert.equal(failures[0].messageId, 'message-1');
  assert.equal(failures[0].threadId, 'thread-1');
  assert.match(failures[0].error.message, /server is unavailable/);
});

test('local contact resolution returns a resolved contact without a failure receipt', async () => {
  const failures = [];
  const result = await resolveLocalEmailContact(
    {
      sender_name: 'Known Person',
      sender_email: 'known@example.com',
    },
    {
      crmRequest: async () => ({
        resolution: {
          status: 'matched',
          contact: { id: 'contact-1', company_id: null },
        },
      }),
      recordFailure: async (failure) => failures.push(failure),
    },
  );

  assert.equal(result.id, 'contact-1');
  assert.deepEqual(failures, []);
});

test('ambiguous local contact resolution records candidates and continues unlinked', async () => {
  const failures = [];
  const candidates = [
    { id: 'candidate-1', name: 'Sarah Chen', email: 'one@example.com' },
    { id: 'candidate-2', name: 'Sarah Chen', email: 'two@example.com' },
  ];
  const result = await resolveLocalEmailContact(
    {
      sender_name: 'Sarah Chen',
      sender_email: 'new@example.com',
      message_id: 'message-2',
    },
    {
      crmRequest: async () => ({
        resolution: { status: 'ambiguous', candidates },
      }),
      recordFailure: async (failure) => failures.push(failure),
    },
  );

  assert.equal(result, null);
  assert.equal(failures.length, 1);
  assert.match(failures[0].error.message, /identity is ambiguous/);
  assert.deepEqual(failures[0].candidates, candidates);
  assert.equal(failures[0].messageId, 'message-2');
});

test('a failure-recorder outage still lets contact resolution continue unlinked', async () => {
  const result = await resolveLocalEmailContact(
    {
      sender_name: 'Sender Person',
      sender_email: 'sender@example.com',
    },
    {
      crmRequest: async () => {
        throw new Error('Next server is unavailable');
      },
      recordFailure: async () => {
        throw new Error('receipt database is unavailable');
      },
    },
  );

  assert.equal(result, null);
});
