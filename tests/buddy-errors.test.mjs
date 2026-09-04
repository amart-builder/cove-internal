import assert from 'node:assert/strict';
import test from 'node:test';
import { isClaudeNotSignedIn } from '../src/lib/buddy/errors.ts';

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
