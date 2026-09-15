import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAttentionTransport } from '../src/lib/attention/transport.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cove-attention-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repoDir = path.join(root, 'repo');
  const dataDir = path.join(root, 'selected');
  const explicitDir = path.join(root, 'explicit');
  for (const dir of [path.join(repoDir, 'data'), dataDir, explicitDir]) mkdirSync(dir, { recursive: true });
  function config(dir, recipient, name = 'cove-reminders.json') {
    const file = path.join(dir, name);
    writeFileSync(file, JSON.stringify({ channel: 'imessage', imessage_to: recipient }));
    return file;
  }
  config(path.join(repoDir, 'data'), 'repository@example.test');
  config(dataDir, 'selected@example.test');
  config(explicitDir, 'explicit@example.test');
  return { root, repoDir, dataDir, explicitDir, config };
}
function recipientCall(input) {
  const calls = [];
  const transport = createAttentionTransport({ ...input, telegramToken: '', execFileSyncImpl: (...args) => { calls.push(args); return ''; } });
  const delivered = transport.text('Synthetic test message');
  assert.equal(delivered, transport.textConfigured);
  return calls;
}
function expectRecipient(input, recipient) {
  const calls = recipientCall(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'osascript');
  assert.match(calls[0][1][1], new RegExp(`buddy "${recipient.replaceAll('.', '\\.') }"`));
}

test('attention text selects configured data directory, never repository recipient', t => {
  const f = fixture(t);
  expectRecipient({ repoDir: f.repoDir, env: { COVE_DATA_DIR: f.dataDir } }, 'selected@example.test');
});
test('explicit data directory wins over environment', t => {
  const f = fixture(t);
  expectRecipient({ repoDir: f.repoDir, dataDir: f.explicitDir, env: { COVE_DATA_DIR: f.dataDir } }, 'explicit@example.test');
});
test('explicit reminder config remains authoritative', t => {
  const f = fixture(t);
  const override = f.config(f.root, 'override@example.test', 'override.json');
  expectRecipient({ repoDir: f.repoDir, dataDir: f.explicitDir, env: { COVE_DATA_DIR: f.dataDir, COVE_REMINDER_CONFIG_PATH: override } }, 'override@example.test');
});
test('legacy environment and config names remain supported', t => {
  const f = fixture(t);
  rmSync(path.join(f.dataDir, 'cove-reminders.json'));
  f.config(f.dataDir, 'legacy@example.test', 'forge-reminders.json');
  expectRecipient({ repoDir: f.repoDir, env: { FORGE_DATA_DIR: f.dataDir } }, 'legacy@example.test');
});
test('canonical environment and filename take precedence', t => {
  const f = fixture(t);
  f.config(f.dataDir, 'legacy@example.test', 'forge-reminders.json');
  expectRecipient({ repoDir: f.repoDir, env: { COVE_DATA_DIR: f.dataDir, FORGE_DATA_DIR: f.explicitDir } }, 'selected@example.test');
});
test('missing selected config never falls back to another recipient', t => {
  const f = fixture(t);
  rmSync(path.join(f.dataDir, 'cove-reminders.json'));
  assert.deepEqual(recipientCall({ repoDir: f.repoDir, env: { COVE_DATA_DIR: f.dataDir } }), []);
});
test('repository default remains available when no directory is selected', t => {
  const f = fixture(t);
  expectRecipient({ repoDir: f.repoDir, env: {} }, 'repository@example.test');
});
