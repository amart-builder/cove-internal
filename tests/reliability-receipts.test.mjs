import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';
import {
  GET,
  POST,
  parseFailureDismissBody,
} from '../src/app/api/failures/route.ts';
import {
  dismissFailure,
  listFailures,
  recordFailure,
} from '../src/lib/reliability/failures.ts';
import {
  ACTIVITY_SOURCES,
  buildReceiptDigest,
  listRecentReceiptActivity,
  listRecentReceipts,
  receiptActivity,
  recordReceipt,
} from '../src/lib/reliability/receipts.ts';

function tempDatabase(t) {
  const file = path.join(
    os.tmpdir(),
    `cove-receipts-${process.pid}-${Date.now()}-${Math.random()}.db`,
  );
  t.after(() => {
    rmSync(file, { force: true });
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
  });
  return file;
}

test('receipts preserve plain-English and structured action summaries', (t) => {
  const dbPath = tempDatabase(t);
  recordReceipt({
    dbPath,
    source: 'triage',
    startedAt: '2026-07-28T12:00:00.000Z',
    finishedAt: '2026-07-28T12:00:01.000Z',
    summary: 'Reviewed three inbox items.',
    actions: { reviewed: 3, drafted: 1, sent: 0 },
    retryCount: 1,
    outcome: 'success',
  });
  recordReceipt({
    dbPath,
    source: 'meeting-watch',
    startedAt: '2026-07-28T12:01:00.000Z',
    finishedAt: '2026-07-28T12:01:02.000Z',
    summary: 'Processed one note with one error.',
    actions: { processed: 1, errors: 1 },
    outcome: 'partial',
  });

  const receipts = listRecentReceipts({ dbPath });
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].summary, 'Processed one note with one error.');
  assert.deepEqual(receipts[1].actions, { reviewed: 3, drafted: 1, sent: 0 });
  assert.equal(receipts[1].retryCount, 1);
});

test('recent activity turns known receipts into calm plain-English rows', (t) => {
  const dbPath = tempDatabase(t);
  recordReceipt({
    dbPath,
    source: 'email-triage',
    startedAt: '2026-07-29T09:00:00.000Z',
    finishedAt: '2026-07-29T09:01:00.000Z',
    summary: 'Internal inbox summary.',
    actions: { needYou: 3, action: 7, fyi: 2 },
    outcome: 'success',
  });
  recordReceipt({
    dbPath,
    source: 'meeting-intake',
    startedAt: '2026-07-29T10:00:00.000Z',
    finishedAt: '2026-07-29T10:01:00.000Z',
    summary: 'Internal meeting summary.',
    actions: { processed: 1, tasks: 2 },
    outcome: 'success',
  });
  const page = listRecentReceiptActivity({ dbPath, limit: 1 });
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.activities[0], {
    id: page.activities[0].id,
    title: 'Meeting notes',
    detail: '1 meeting processed, 2 tasks.',
    occurredAt: '2026-07-29T10:01:00.000Z',
    needsAttention: false,
  });
  assert.deepEqual(page.nextCursor, {
    finishedAt: page.activities[0].occurredAt,
    id: page.activities[0].id,
  });
  assert.equal(
    listRecentReceiptActivity({
      dbPath,
      limit: 1,
      cursor: page.nextCursor,
    }).activities[0].detail,
    '12 messages checked, 3 items need you.',
  );
});

test('every recent activity source has a dedicated plain-English branch', () => {
  const titles = {
    'email-triage': 'Inbox check',
    'meeting-intake': 'Meeting notes',
    'meeting-watch': 'Meeting notes',
    backup: 'Backup',
    'morning-brief': 'Morning brief',
    'buddy-feedback': 'Feedback',
    'email-gmail-to-card': 'Gmail follow-through',
    'email-card-to-gmail': 'Email card sync',
    'task-session': 'Claude session',
    'email-commitments': 'Promises captured from email',
    'email-correspondence': 'People history updated',
    'claude-child-reaper': 'Background cleanup',
    'health-collector': 'Health check',
    'recurring-task-spawn': 'Recurring tasks',
    'stale-task-watchdog': 'Stale-task check',
    'archived-task-purge': 'Old task cleanup',
  };
  assert.deepEqual([...ACTIVITY_SOURCES].sort(), Object.keys(titles).sort());
  for (const source of ACTIVITY_SOURCES) {
    const activity = receiptActivity({
      id: `receipt-${source}`,
      source,
      startedAt: '2026-07-29T10:00:00.000Z',
      finishedAt: '2026-07-29T10:01:00.000Z',
      summary: `${source} finished.`,
      actions: source === 'task-session'
        ? { taskTitle: 'Prepare the launch package', status: 'output_ready' }
        : {},
      retryCount: 0,
      outcome: 'success',
    });
    assert.equal(activity.title, titles[source]);
    assert.notEqual(activity.title, 'Email and Cove sync');
  }
  assert.equal(
    receiptActivity({
      id: 'task-session-title',
      source: 'task-session',
      startedAt: '2026-07-29T10:00:00.000Z',
      finishedAt: '2026-07-29T10:01:00.000Z',
      summary: 'finished',
      actions: { taskTitle: 'Prepare the launch package' },
      retryCount: 0,
      outcome: 'success',
    }).detail,
    '"Prepare the launch package" is ready.',
  );
});

test('recent activity cursor is stable when a newer receipt arrives between pages', (t) => {
  const dbPath = tempDatabase(t);
  const add = (finishedAt, summary) => recordReceipt({
    dbPath,
    source: 'backup',
    startedAt: finishedAt,
    finishedAt,
    summary,
    outcome: 'success',
  });
  add('2026-07-29T10:01:00.000Z', 'oldest');
  add('2026-07-29T10:02:00.000Z', 'middle');
  add('2026-07-29T10:03:00.000Z', 'newest');

  const first = listRecentReceiptActivity({ dbPath, limit: 2 });
  assert.equal(first.activities.length, 2);
  assert.equal(first.hasMore, true);
  add('2026-07-29T10:04:00.000Z', 'arrived between pages');
  const second = listRecentReceiptActivity({
    dbPath,
    limit: 2,
    cursor: first.nextCursor,
  });

  assert.equal(second.activities.length, 1);
  assert.equal(second.activities[0].occurredAt, '2026-07-29T10:01:00.000Z');
  assert.equal(
    new Set([...first.activities, ...second.activities].map((item) => item.id)).size,
    3,
    'no row from the original window is duplicated or hidden',
  );
});

test('receipt digest counts successful work since the last morning brief', (t) => {
  const dbPath = tempDatabase(t);
  const add = (source, finishedAt, outcome = 'success') => recordReceipt({
    dbPath,
    source,
    startedAt: finishedAt,
    finishedAt,
    summary: `${source} finished.`,
    outcome,
  });
  add('email-triage', '2026-07-28T07:00:00.000Z');
  add('morning-brief', '2026-07-28T08:00:00.000Z');
  add('email-triage', '2026-07-28T09:00:00.000Z');
  add('email-triage', '2026-07-28T15:00:00.000Z', 'partial');
  add('meeting-intake', '2026-07-28T16:00:00.000Z');
  add('backup', '2026-07-29T02:00:00.000Z');
  add('email-triage', '2026-07-29T03:00:00.000Z', 'failed');

  assert.deepEqual(buildReceiptDigest({ dbPath }), {
    since: '2026-07-28T08:00:00.000Z',
    inboxChecks: 2,
    meetingsProcessed: 1,
    backupOk: true,
    content: 'Since the last brief: 2 inbox checks, 1 meeting, backup ok.',
  });
});

test('processing failures appear in one dismissible inbox', (t) => {
  const dbPath = tempDatabase(t);
  let receipt;
  for (let index = 0; index < 5; index += 1) {
    receipt = recordReceipt({
      dbPath,
      source: 'meeting-watch',
      startedAt: `2026-07-28T12:0${index}:00.000Z`,
      summary: 'Meeting notes processing failed.',
      actions: { error: 'Parser unavailable', attempt: index + 1 },
      outcome: 'failed',
    });
  }
  const failures = listFailures({ dbPath });
  assert.equal(failures.length, 1);
  assert.equal(failures[0].details.receiptId, receipt.id);
  assert.equal(failures[0].sourceId, 'meeting-watch:meeting-watch');
  assert.equal(dismissFailure(failures[0].id, { dbPath }), true);
  assert.equal(listFailures({ dbPath }).length, 0);
  assert.equal(listFailures({ dbPath, includeDismissed: true }).length, 1);
});

test('caller-supplied receipt failure keys separate independent failures', (t) => {
  const dbPath = tempDatabase(t);
  for (const failureKey of ['message-1', 'message-2']) {
    recordReceipt({
      dbPath,
      source: 'meeting-watch',
      failureKey,
      startedAt: '2026-07-28T12:00:00.000Z',
      summary: `Could not process ${failureKey}.`,
      outcome: 'failed',
    });
  }
  assert.deepEqual(
    listFailures({ dbPath }).map((failure) => failure.sourceId).sort(),
    ['meeting-watch:message-1', 'meeting-watch:message-2'],
  );
});

test('failure API accepts only a bounded id', () => {
  assert.deepEqual(parseFailureDismissBody({ id: 'failure-1' }), {
    id: 'failure-1',
  });
  assert.throws(() => parseFailureDismissBody({}), /valid failure id/);
  assert.throws(() => parseFailureDismissBody({ id: 'x'.repeat(201) }), /valid failure id/);
});

test('failure API stays disabled outside local mode without creating local data', {
  concurrency: false,
}, async (t) => {
  const root = path.join(
    os.tmpdir(),
    `cove-failure-disabled-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  const dbPath = path.join(root, 'forge.db');
  const previousRuntime = process.env.NEXT_PUBLIC_FORGE_RUNTIME;
  const previousDb = process.env.COVE_DB_PATH;
  const previousData = process.env.COVE_DATA_DIR;
  process.env.NEXT_PUBLIC_FORGE_RUNTIME = 'supabase';
  process.env.COVE_DB_PATH = dbPath;
  process.env.COVE_DATA_DIR = root;
  t.after(() => {
    if (previousRuntime === undefined) delete process.env.NEXT_PUBLIC_FORGE_RUNTIME;
    else process.env.NEXT_PUBLIC_FORGE_RUNTIME = previousRuntime;
    if (previousDb === undefined) delete process.env.COVE_DB_PATH;
    else process.env.COVE_DB_PATH = previousDb;
    if (previousData === undefined) delete process.env.COVE_DATA_DIR;
    else process.env.COVE_DATA_DIR = previousData;
    rmSync(root, { recursive: true, force: true });
  });

  const listed = await GET(new NextRequest('http://localhost/api/failures'));
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), { enabled: false, failures: [] });
  const dismissed = await POST(new NextRequest('http://localhost/api/failures', {
    method: 'POST',
    body: JSON.stringify({ id: 'failure-1' }),
    headers: { 'Content-Type': 'application/json' },
  }));
  assert.equal(dismissed.status, 200);
  assert.deepEqual(await dismissed.json(), { enabled: false, failures: [] });
  assert.equal(existsSync(dbPath), false);
  assert.equal(existsSync(`${path.join(root, 'quiet-current.json')}.token`), false);
});

test('failure API enforces trusted hosts and CSRF before dismissing', async (t) => {
  const root = path.join(
    os.tmpdir(),
    `cove-failure-route-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  const dbPath = path.join(root, 'forge.db');
  const previousDb = process.env.COVE_DB_PATH;
  const previousData = process.env.COVE_DATA_DIR;
  process.env.COVE_DB_PATH = dbPath;
  process.env.COVE_DATA_DIR = root;
  t.after(() => {
    if (previousDb === undefined) delete process.env.COVE_DB_PATH;
    else process.env.COVE_DB_PATH = previousDb;
    if (previousData === undefined) delete process.env.COVE_DATA_DIR;
    else process.env.COVE_DATA_DIR = previousData;
    rmSync(root, { recursive: true, force: true });
  });
  const failure = recordFailure({
    dbPath,
    source: 'test',
    sourceId: 'route-test',
    message: 'Visible route failure.',
  });

  const hostile = await GET(new NextRequest('http://hostile.example/api/failures'));
  assert.equal(hostile.status, 403);
  const listed = await GET(new NextRequest('http://localhost/api/failures'));
  assert.equal(listed.status, 200);
  const payload = await listed.json();
  assert.equal(payload.failures[0].id, failure.id);
  assert.ok(payload.csrfToken);

  const missingToken = await POST(new NextRequest('http://localhost/api/failures', {
    method: 'POST',
    body: JSON.stringify({ id: failure.id }),
    headers: { 'Content-Type': 'application/json' },
  }));
  assert.equal(missingToken.status, 403);
  const dismissed = await POST(new NextRequest('http://localhost/api/failures', {
    method: 'POST',
    body: JSON.stringify({ id: failure.id }),
    headers: {
      'Content-Type': 'application/json',
      'X-Forge-CSRF': payload.csrfToken,
    },
  }));
  assert.equal(dismissed.status, 200);
  assert.equal(listFailures({ dbPath }).length, 0);
});
