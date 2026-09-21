import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const setupPath = fileURLToPath(new URL('../SETUP.md', import.meta.url));
const agentsPath = fileURLToPath(new URL('../AGENTS.md', import.meta.url));

// Regression: a Google OAuth client left in `Testing` publishing status
// authorizes normally and then stops about seven days later, when Google
// expires the refresh token. Nothing in Cove can read that setting, so the
// first symptom is every Gmail lane failing with a sign-in error that reads
// like a Cove fault, long after the setup agent is gone. The only place this
// can be caught is before the first authorization, so the setup playbook has
// to stop there and the handoff notes have to say so too.
test('the mail setup blocks on the OAuth publishing status before authorizing', () => {
  const setup = readFileSync(setupPath, 'utf8');
  const email = setup.slice(setup.indexOf('\n### Email'), setup.indexOf('\n### People'));
  assert.ok(email.length > 0, 'SETUP.md no longer has an Email section');

  const gate = email.indexOf('publishing status');
  const connect = email.indexOf('cove-google-connect.ts connect');
  assert.ok(gate !== -1, 'the mail setup no longer checks the OAuth publishing status');
  assert.ok(connect !== -1, 'the mail setup no longer runs the connect command');
  assert.ok(gate < connect, 'the publishing-status check must come before the first authorization');

  // Both readings of a safe status, and the one that has to stop the setup.
  assert.match(email, /In production/);
  assert.match(email, /Internal/);
  assert.match(email, /Testing/);
  assert.match(email, /Publish app/);
  // Where to look, in either console layout.
  assert.match(email, /OAuth consent screen/);
  assert.match(email, /Audience/);
  // Why it cannot be left until later.
  assert.match(email, /seven days/);
});

test('the agent handoff notes carry the same stop', () => {
  const agents = readFileSync(agentsPath, 'utf8');
  assert.match(agents, /publishing status/);
  assert.match(agents, /Testing/);
});
