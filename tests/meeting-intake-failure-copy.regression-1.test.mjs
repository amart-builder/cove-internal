import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The Issues screen is product surface. A thrown diagnostic on it tells the
// person nothing they can act on, and a provider error can carry a URL, a host
// name or a fragment of their own note.

const RAW = 'FetchError: request to https://api.granola.ai/v1/transcript/abc failed, reason: ECONNREFUSED';

async function ingestionFailure({ attempts, maxAttempts }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-meeting-intake-'));
  process.env.COVE_RUNTIME_MODE = 'local';
  process.env.COVE_DATA_DIR = dir;
  const dbPath = path.join(dir, 'cove.db');
  process.env.COVE_DB_PATH = dbPath;
  const { claimMessageIngestion, failMessageIngestion } =
    await import('../src/lib/intake/message-ingestion.ts');
  const { openLocalDatabase } = await import('../src/lib/local/database.ts');
  const messageId = `msg-${Math.random().toString(16).slice(2)}`;
  const claim = claimMessageIngestion({
    messageId,
    threadId: 'thread-1',
    sourceDoor: 'watcher',
    detectedTool: 'granola',
    dbPath,
  });
  failMessageIngestion({
    messageId,
    leaseToken: claim.leaseToken,
    startedAt: new Date().toISOString(),
    attempts,
    maxAttempts,
    error: new Error(RAW),
    dbPath,
  });
  const db = openLocalDatabase(dbPath);
  // The retrying branch keys the row on the message id; the terminal branch
  // goes through a receipt, which keys it "meeting-intake:<message id>".
  return db.prepare(
    "SELECT message, details_json FROM cove_failure_inbox WHERE source_id IN (?, ?)",
  ).get(messageId, `meeting-intake:${messageId}`);
}

test('a meeting-notes failure that will retry says so without the diagnostic', async () => {
  const row = await ingestionFailure({ attempts: 1, maxAttempts: 5 });
  assert.ok(row, 'a retrying ingestion must leave a row');
  assert.doesNotMatch(row.message, /FetchError|ECONNREFUSED|api\.granola\.ai|https?:/);
  assert.match(row.message, /meeting notes/i);
  assert.match(row.message, /try again/i);
});

test('a meeting-notes failure that has given up says so without the diagnostic', async () => {
  const row = await ingestionFailure({ attempts: 5, maxAttempts: 5 });
  assert.ok(row, 'a terminal ingestion must leave a row');
  assert.doesNotMatch(row.message, /FetchError|ECONNREFUSED|api\.granola\.ai|https?:/);
  assert.match(row.message, /meeting notes/i);
  assert.doesNotMatch(row.message, /try again/i);
});

test('the diagnostic is kept in details for whoever has to fix it', async () => {
  for (const attempts of [1, 5]) {
    const row = await ingestionFailure({ attempts, maxAttempts: 5 });
    assert.match(row.details_json, /ECONNREFUSED/);
  }
});
