import assert from 'node:assert/strict';
import test from 'node:test';
import { buddyFailureMessage, isClaudeNotSignedIn } from '../src/lib/buddy/errors.ts';

test('detects Claude not-signed-in messages', () => {
  assert.equal(isClaudeNotSignedIn('Not logged in · Please run /login'), true);
  assert.equal(isClaudeNotSignedIn('NOT LOGGED IN'), true);
  assert.equal(isClaudeNotSignedIn('Claude says: please run /login to continue.'), true);
});

test('ignores unrelated and empty errors', () => {
  assert.equal(isClaudeNotSignedIn('timeout'), false);
  assert.equal(isClaudeNotSignedIn('context window exceeded'), false);
  assert.equal(isClaudeNotSignedIn(''), false);
  assert.equal(isClaudeNotSignedIn(null), false);
});

test('detects an expired or revoked Claude OAuth session', () => {
  assert.equal(
    isClaudeNotSignedIn('Failed to authenticate: OAuth session expired and could not be refreshed'),
    true,
  );
  assert.equal(isClaudeNotSignedIn('FAILED TO AUTHENTICATE'), true);
  assert.equal(isClaudeNotSignedIn('error: OAuth Session Expired'), true);
  assert.equal(isClaudeNotSignedIn('token could not be refreshed'), true);
  assert.equal(isClaudeNotSignedIn('{"type":"authentication_error","message":"invalid x-api-key"}'), true);
});

test('a failure with no text still names what happened', () => {
  // The sign-in card above this matches on the turn's text, so a turn that dies
  // before the model writes anything can never reach it. What it reaches must
  // not be a dead end.
  assert.match(buddyFailureMessage('interrupted'), /stopped before it finished/);
  assert.match(buddyFailureMessage('timeout'), /too long/);
  assert.match(buddyFailureMessage('server_restart'), /Cove restarted/);
  assert.match(buddyFailureMessage('persist_failed'), /could not save/);
  assert.match(buddyFailureMessage('command_failed'), /partway/);
});

test('a failure to start names the agent it could not start', () => {
  assert.match(buddyFailureMessage('spawn_failed'), /could not start Claude/);
  assert.match(buddyFailureMessage('spawn_failed', 'codex'), /could not start Codex/);
});

test('an unknown cause is vague rather than wrong', () => {
  for (const code of [null, undefined, '', 'something_new']) {
    const message = buddyFailureMessage(code);
    assert.match(message, /could not finish/);
    assert.doesNotMatch(message, /interrupted|timed out|restarted/);
  }
});
