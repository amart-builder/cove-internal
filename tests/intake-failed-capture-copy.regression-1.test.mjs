import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// A capture that never became a card is the one case where the person has
// nothing to look at, so the Issues row is all they get. It used to carry the
// thrown diagnostic verbatim, which for a model that answered in prose meant a
// JSON parser error and a fragment of the model's reply on their screen.

async function failedCaptureMessage(rawError) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-failed-capture-'));
  process.env.COVE_RUNTIME_MODE = 'local';
  process.env.COVE_DATA_DIR = dir;
  process.env.COVE_DB_PATH = path.join(dir, 'cove.db');
  const { resolveLocalInboundEvent } = await import('../src/lib/local/db.ts');
  const { openLocalDatabase } = await import('../src/lib/local/database.ts');
  const db = openLocalDatabase(process.env.COVE_DB_PATH);
  const now = new Date().toISOString();
  const id = `evt-${Math.random().toString(16).slice(2)}`;
  db.prepare(
    `INSERT INTO inbound_events
       (id, source, source_id, raw_text, state, attempts, created_at, updated_at)
     VALUES (?, 'imessage', ?, 'call the accountant about the Q3 filing', 'pending', 4, ?, ?)`,
  ).run(id, id, now, now);
  resolveLocalInboundEvent({ id, state: 'failed', taskId: null, error: rawError, updatedAt: now });
  const row = db.prepare(
    "SELECT message, details_json FROM cove_failure_inbox WHERE source='inbound-event' AND source_id=?",
  ).get(id);
  return row;
}

test('a capture that never became a card reports it in the person\'s words', async () => {
  const row = await failedCaptureMessage(
    `Unexpected token 'I', "I'll help "... is not valid JSON`,
  );
  assert.ok(row, 'an exhausted capture must leave a row the person can find');
  assert.doesNotMatch(row.message, /is not valid JSON|Unexpected token|SyntaxError/);
  assert.doesNotMatch(row.message, /I'll help/);
  assert.match(row.message, /not on your board/i);
});

test('the diagnostic is kept for whoever has to fix it', async () => {
  const raw = 'triage_project_invalid';
  const row = await failedCaptureMessage(raw);
  assert.match(row.details_json, /triage_project_invalid/);
  assert.doesNotMatch(row.message, /triage_project_invalid/);
});

test('no internal error code of any shape reaches the message', async () => {
  for (const raw of ['ECONNREFUSED 127.0.0.1:3200', 'intake_capture_failed', 'fetch failed']) {
    const row = await failedCaptureMessage(raw);
    assert.doesNotMatch(row.message, new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
