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
