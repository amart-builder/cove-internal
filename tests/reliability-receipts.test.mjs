import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
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
  listRecentReceipts,
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
