import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLocalDatabase } from '../src/lib/local/database.ts';
import { recordFailureInDatabase } from '../src/lib/reliability/failures.ts';

test('saved reminder failures distinguish a failed connection from an uncertain send', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-reminder-copy-'));
  const db = openLocalDatabase(path.join(dir, 'cove.db'));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const record = (id, error, channel = 'imessage') => recordFailureInDatabase(db, {
    source: 'reminder-delivery', sourceId: id, message: 'Old technical message',
    details: { title: 'Review the proposal', channel, error },
  }).message;
  const unavailable = record('connection', 'ssh: connect to host fixture.invalid port 22: Operation timed out');
  assert.match(unavailable, /Review the proposal/);
  assert.match(unavailable, /could not connect.*text was not sent/);
  assert.doesNotMatch(unavailable, /could not confirm|Mini/);
  const uncertain = record('timeout', 'spawnSync ssh ETIMEDOUT');
  assert.match(uncertain, /could not confirm whether the text was sent/);
  assert.match(uncertain, /Check Messages before sending it again/);
  assert.doesNotMatch(uncertain, /was not sent|Mini/);
  assert.match(record('telegram', 'request timed out', 'telegram'), /Check Telegram before sending it again/);
  assert.match(record('unknown', 'request timed out', 'text'), /Check your messaging app before sending it again/);
  assert.match(record('local', 'Messages is unavailable'), /could not send the text reminder/);
  assert.doesNotMatch(record('local-again', 'Messages is unavailable'), /Mini|connect/);
  assert.match(record('mac', 'ETIMEDOUT', 'native'), /could not confirm the Mac notification/);
  assert.doesNotMatch(record('mac-again', 'ETIMEDOUT', 'native'), /text was|Messages/);
});
