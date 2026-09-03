import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  detectCalendarNotice,
  summarizeCalendarNotice,
} from '../src/lib/email/calendar-notice.ts';
import { createEmailClassificationHandler } from '../src/lib/email/classification-job.ts';
import { observeInboundMessage } from '../src/lib/email/state-machine.ts';
import { openLocalDatabase } from '../src/lib/local/database.ts';

const cases = [
  {
    subject: 'Accepted: Edge AI review @ Tue Sep 2, 2026 10am - 10:30am (PDT)',
    kind: 'accepted',
    eventTitle: 'Edge AI review',
    responder: 'Jordan Lee',
    summary: 'Accepted: Edge AI review (Jordan Lee)',
  },
  {
    subject: 'Declined: Edge AI review - 10am (PDT)',
    kind: 'declined',
    eventTitle: 'Edge AI review',
    responder: 'Jordan Lee',
    summary: 'Declined: Edge AI review (Jordan Lee)',
  },
  {
    subject: 'Tentatively accepted: Edge AI review',
    kind: 'tentative',
    eventTitle: 'Edge AI review',
    responder: 'Jordan Lee',
    summary: 'Tentative: Edge AI review (Jordan Lee)',
  },
  {
    subject: 'Tentatively Accepted: Edge AI review',
    kind: 'tentative',
    eventTitle: 'Edge AI review',
    responder: 'Jordan Lee',
    summary: 'Tentative: Edge AI review (Jordan Lee)',
  },
  {
    subject: 'Invitation: Edge AI review',
    kind: 'invitation',
    eventTitle: 'Edge AI review',
    responder: 'Jordan Lee',
    summary: 'Invitation: Edge AI review from Jordan Lee',
  },
  {
    subject: 'Updated invitation: Edge AI review',
    kind: 'updated',
    eventTitle: 'Edge AI review',
    responder: 'Jordan Lee',
    summary: 'Updated: Edge AI review',
  },
  {
    subject: 'Canceled event: Edge AI review',
    kind: 'canceled',
    eventTitle: 'Edge AI review',
    responder: 'Jordan Lee',
    summary: 'Canceled: Edge AI review',
  },
  {
    subject: 'Cancelled event: Edge AI review',
    kind: 'canceled',
    eventTitle: 'Edge AI review',
    responder: 'Jordan Lee',
    summary: 'Canceled: Edge AI review',
  },
  {
    subject: 'New Event: Casey Morgan - Intro call @ Tue Sep 2, 2026 10am',
    kind: 'new_event',
    eventTitle: 'Intro call',
    responder: 'Casey Morgan',
    summary: 'Booked: Intro call',
  },
];

test('calendar notices produce deterministic kinds and summary shapes', () => {
  for (const expected of cases) {
    const notice = detectCalendarNotice({
      sender: 'Jordan Lee <calendar-notification@google.com>',
      subject: expected.subject,
    });
    assert.deepEqual(notice, {
      kind: expected.kind,
      eventTitle: expected.eventTitle,
      responder: expected.responder,
    });
    assert.equal(summarizeCalendarNotice(notice), expected.summary);
  }
});

test('an ordinary accepted subject is not a calendar notice', () => {
  assert.equal(detectCalendarNotice({
    sender: 'Jordan Lee <jordan@example.com>',
    subject: 'Accepted the offer',
  }), null);
  assert.equal(detectCalendarNotice({
    sender: 'Jordan Lee <jordan@example.com>',
    subject: 'Accepted: Lunch @ Soho House',
  }), null);
  assert.equal(detectCalendarNotice({
    sender: 'Jane Smith <jane@example.com>',
    subject: 'Accepted: Statement of Work',
  }), null);
  for (const subject of [
    'Accepted: Deal review @ March Capital',
    'Accepted: Team offsite @ Friday Beers',
    'Accepted: Lease @ 12-14 Berkeley St',
  ]) {
    assert.equal(detectCalendarNotice({ sender: 'Jane <jane@example.com>', subject }), null, subject);
  }
});

test('a dated RSVP from the responder address is a calendar notice', () => {
  assert.deepEqual(detectCalendarNotice({
    sender: 'Ger Dwyer <gdwyer@rivian.com>',
    subject: 'Accepted: Ger Dwyer and Edge AI @ Thu Sep 24, 2026 3pm - 3:30pm (PDT) (alex@joinedgeai.com)',
  }), {
    kind: 'accepted',
    eventTitle: 'Ger Dwyer and Edge AI',
    responder: 'Ger Dwyer',
  });
});

test('Google calendar senders can match without a date suffix', () => {
  assert.deepEqual(detectCalendarNotice({
    sender: 'Jordan Lee <calendar-notification@google.com>',
    subject: 'Accepted: Planning session',
  }), {
    kind: 'accepted',
    eventTitle: 'Planning session',
    responder: 'Jordan Lee',
  });
  assert.deepEqual(detectCalendarNotice({
    sender: 'Jordan Lee <abc@calendar-server.bounces.google.com>',
    subject: 'Tentatively accepted: Planning session',
  }), {
    kind: 'tentative',
    eventTitle: 'Planning session',
    responder: 'Jordan Lee',
  });
});

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-calendar-notice-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'cove.db');
}

function classificationJob(observed, messageId) {
  return {
    id: `job-${messageId}`,
    type: 'email-classify',
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
    status: 'leased',
    idempotencyKey: `email-classify:${messageId}`,
    createdAt: new Date(0).toISOString(),
    finishedAt: null,
    lastError: null,
  };
}

function storedEmail(dbPath, id) {
  const db = openLocalDatabase(dbPath);
  try {
    return db.prepare('SELECT bucket, summary FROM email_items WHERE id = ?').get(id);
  } finally {
    db.close();
  }
}

async function classifyFixture(t, { messageId, sender, subject, classifier }) {
  const dbPath = fixture(t);
  const observed = observeInboundMessage({
    messageId,
    threadId: `thread-${messageId}`,
    internalDate: '1000',
    accountEmail: 'alex@example.com',
    dbPath,
  });
  const handler = createEmailClassificationHandler({
    dbPath,
    accountEmail: 'alex@example.com',
    gateway: {
      getMessage: async () => ({
        id: messageId,
        threadId: `thread-${messageId}`,
        historyId: '10',
        labelIds: ['INBOX'],
        internalDate: '1000',
        headers: [
          { name: 'From', value: sender },
          { name: 'Subject', value: subject },
        ],
        snippet: subject,
        text: subject,
      }),
      modifyThreadLabels: async () => {},
    },
    classifier,
  });
  await handler(classificationJob(observed, messageId));
  return storedEmail(dbPath, observed.emailItemId);
}

test('accepted and tentative notices bypass the model and become fyi', async (t) => {
  let modelCalls = 0;
  for (const [messageId, subject, expected] of [
    ['accepted', 'Accepted: Planning session', 'Accepted: Planning session (Jordan Lee)'],
    ['tentative', 'Tentatively accepted: Planning session', 'Tentative: Planning session (Jordan Lee)'],
  ]) {
    const row = await classifyFixture(t, {
      messageId,
      sender: 'Jordan Lee <calendar-notification@google.com>',
      subject,
      classifier: async () => {
        modelCalls += 1;
        throw new Error('calendar response should not invoke the model');
      },
    });
    assert.deepEqual(row, { bucket: 'fyi', summary: expected });
  }
  assert.equal(modelCalls, 0);
});

test('declined notices keep the model bucket and append its summary', async (t) => {
  let modelCalls = 0;
  const row = await classifyFixture(t, {
    messageId: 'declined',
    sender: 'Jordan Lee <calendar-notification@google.com>',
    subject: 'Declined: Planning session',
    classifier: async () => {
      modelCalls += 1;
      return {
        bucket: 'action',
        summary: 'Generic calendar update.',
        recommendedAction: 'Reschedule',
        draftBody: null,
        commitments: [],
        recordCorrespondence: false,
        modelVersion: 'test',
      };
    },
  });
  assert.equal(modelCalls, 1);
  assert.deepEqual(row, {
    bucket: 'action',
    summary: 'Declined: Planning session (Jordan Lee). Generic calendar update.',
  });
});
