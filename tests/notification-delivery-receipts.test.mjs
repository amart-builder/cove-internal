import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { executeNotificationDelivery, pruneNotificationReceipts } from '../src/lib/notifications/delivery-receipts.mjs';

function fixture(t) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'cove-delivery-receipt-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const directory = path.join(dataDir, 'notification-deliveries');
  const receipts = () => readdirSync(directory).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(path.join(directory, name), 'utf8')));
  return { dataDir, directory, receipts };
}
const attempt = { channel: 'native', reference: 'task:example', content: 'A useful reminder.', now: new Date('2026-09-15T20:00:00Z') };

test('notification records a private durable claim before handoff and only claims transport acceptance', t => {
  const { dataDir, directory, receipts } = fixture(t);
  const result = executeNotificationDelivery({ ...attempt, dataDir }, () => {
    const [claim] = receipts();
    assert.equal(claim.status, 'claimed');
    assert.equal(claim.content, attempt.content);
    assert.equal(claim.claimedAt, '2026-09-15T20:00:00.000Z');
    return 'transport-result';
  });
  assert.equal(result, 'transport-result');
  const [receipt] = receipts();
  assert.equal(receipt.status, 'accepted');
  assert.equal(receipt.result, 'transport_accepted_not_delivery_confirmed');
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(directory, `${receipt.id}.json`)).mode & 0o777, 0o600);
  assert.match(receipt.id, /^[a-f0-9-]{36}$/);
  assert.equal(readdirSync(directory).length, 1);
});

test('known rejection and uncertain timeout remain distinct without storing raw transport secrets', t => {
  const { dataDir, receipts } = fixture(t);
  const cases = [
    [new Error('Provider rejected request with credential=SECRET'), 'failed'],
    [new Error('spawnSync ssh ETIMEDOUT credential=SECRET'), 'uncertain'],
    [new Error('ssh: connect to host private-host port 22: Connection timed out'), 'failed'],
  ];
  for (const [error] of cases) {
    assert.throws(() => executeNotificationDelivery({ ...attempt, dataDir, channel: 'imessage', recipient: 'PRIVATE_RECIPIENT', token: 'PRIVATE_TOKEN' }, () => { throw error; }), candidate => candidate === error);
  }
  const records = receipts();
  assert.deepEqual(records.map(row => row.status).sort(), ['failed', 'failed', 'uncertain']);
  const serialized = JSON.stringify(records);
  assert.doesNotMatch(serialized, /SECRET|PRIVATE_RECIPIENT|PRIVATE_TOKEN|private-host|credential/);
});

test('a process interrupted during delivery retains its claim and is never automatically resent', t => {
  const { dataDir, receipts } = fixture(t);
  const moduleUrl = new URL('../src/lib/notifications/delivery-receipts.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { executeNotificationDelivery, pruneNotificationReceipts } from ${JSON.stringify(moduleUrl)}; executeNotificationDelivery({dataDir:process.argv[1],channel:'native',reference:'task:interrupted',content:'Reminder'},()=>process.exit(23));`, dataDir], { encoding: 'utf8' });
  assert.equal(child.status, 23, child.stderr);
  assert.equal(receipts().length, 1);
  assert.equal(receipts()[0].status, 'claimed');
  assert.equal(receipts()[0].finishedAt, undefined);
});

test('receipt creation failure prevents sending and content storage is bounded', t => {
  const { dataDir, receipts } = fixture(t);
  const badDir = path.join(dataDir, 'file-instead-of-directory');
  writeFileSync(badDir, 'occupied');
  let called = false;
  assert.throws(() => executeNotificationDelivery({ ...attempt, dataDir: badDir }, () => { called = true; }));
  assert.equal(called, false);
  executeNotificationDelivery({ ...attempt, dataDir, content: 'x'.repeat(2200) }, () => {});
  assert.equal(receipts()[0].content.length, 2000);
  assert.equal(receipts()[0].contentTruncated, true);
  assert.equal(receipts()[0].contentHash.length, 64);
});


test('receipt retention prunes old attempts while preserving current evidence and unrelated files', t => {
  const { dataDir, directory, receipts } = fixture(t);
  executeNotificationDelivery({ ...attempt, dataDir }, () => {});
  const old = receipts()[0];
  writeFileSync(path.join(directory, 'operator-note.txt'), 'keep');
  pruneNotificationReceipts(dataDir, new Date('2026-12-13T20:00:00Z'));
  assert.equal(receipts().length, 1);
  executeNotificationDelivery({ ...attempt, dataDir, now: new Date('2026-12-15T20:00:00Z') }, () => {});
  assert.equal(receipts().length, 1);
  assert.notEqual(receipts()[0].id, old.id);
  assert.equal(readFileSync(path.join(directory, 'operator-note.txt'), 'utf8'), 'keep');
});
