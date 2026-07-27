import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_BUDDY_RECEIPTS_BYTES,
  normalizeBuddyReceipts,
  parseBuddyDataToolOutput,
  parseBuddyReceipts,
  reconcileBuddyReceipts,
} from '../src/lib/buddy/receipts.ts';

const valid = 'Done.\n```forge-receipts\n{"changes":[{"table":"tasks","action":"update","id":"t1","summary":"Moved Gym"}],"pendingDeletes":[]}\n```';

test('receipt parser strips a valid block and returns normalized receipts', () => {
  const parsed = parseBuddyReceipts(valid);
  assert.equal(parsed.text, 'Done.');
  assert.deepEqual(parsed.receipts, {
    changes: [{ table: 'tasks', action: 'update', id: 't1', summary: 'Moved Gym' }],
    pendingDeletes: [],
  });
});

test('receipt parser leaves missing and malformed blocks intact', () => {
  assert.deepEqual(parseBuddyReceipts('No receipt'), { text: 'No receipt' });
  const malformed = 'Text\n```forge-receipts\n{bad json}\n```';
  assert.deepEqual(parseBuddyReceipts(malformed), { text: malformed });
});

test('receipt parser strips only the first of multiple blocks', () => {
  const second = '```forge-receipts\n{"changes":[],"pendingDeletes":[]}\n```';
  const parsed = parseBuddyReceipts(`${valid}\n${second}`);
  assert.equal(parsed.text, `Done.\n${second}`);
  assert.equal(parsed.receipts.changes.length, 1);
});

test('receipt parser accepts day-plan changes but never day-plan pending deletes', () => {
  const parsed = parseBuddyReceipts('```forge-receipts\n{"changes":[{"table":"day_plan","action":"update","id":"p1","summary":"Reordered today"}],"pendingDeletes":[{"table":"day_plan","id":"p1","label":"Today"}]}\n```');
  assert.equal(parsed.receipts.changes[0].table, 'day_plan');
  assert.deepEqual(parsed.receipts.pendingDeletes, []);
});

test('receipt normalization caps item counts and encoded payload size', () => {
  const changes = Array.from({ length: 60 }, (_, index) => ({
    table: 'tasks', action: 'update', id: `t${index}`, summary: `Changed ${index}`,
  }));
  const pendingDeletes = Array.from({ length: 60 }, (_, index) => ({
    table: 'contacts', id: `c${index}`, label: `Contact ${index}`,
  }));
  const capped = normalizeBuddyReceipts({ changes, pendingDeletes });
  assert.equal(capped.changes.length, 50);
  assert.equal(capped.pendingDeletes.length, 50);

  const oversized = normalizeBuddyReceipts({
    changes: changes.map((change) => ({ ...change, summary: 'x'.repeat(2_000) })),
    pendingDeletes: [],
  });
  assert.ok(new TextEncoder().encode(JSON.stringify(oversized)).byteLength <= MAX_BUDDY_RECEIPTS_BYTES);
  assert.ok(oversized.changes.length < 50);
});

test('session receipts parse and render only when backed by CLI SESSION output', () => {
  const parsed = parseBuddyReceipts('Started it.\n```forge-receipts\n{"changes":[],"pendingDeletes":[],"sessions":[{"sessionId":"session-1","dir":"/Users/alex/Atlas/demo","title":"Demo"}]}\n```');
  assert.equal(parsed.text, 'Started it.');
  assert.equal(parsed.receipts.sessions[0].sessionId, 'session-1');

  const tool = parseBuddyDataToolOutput(
    'SESSION {"sessionId":"session-1","dir":"/Users/alex/Atlas/demo","title":"Demo"}',
  );
  assert.deepEqual(tool.sessions, [
    { sessionId: 'session-1', dir: '/Users/alex/Atlas/demo', title: 'Demo' },
  ]);
  assert.equal(reconcileBuddyReceipts(parsed.receipts, [], [])?.sessions?.length ?? 0, 0);
  assert.deepEqual(reconcileBuddyReceipts(parsed.receipts, [], tool.sessions).sessions, tool.sessions);
});
