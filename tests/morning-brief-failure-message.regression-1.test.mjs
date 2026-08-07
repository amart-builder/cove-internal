import assert from 'node:assert/strict';
import test from 'node:test';
import { morningBriefFailureMessage } from '../src/lib/claude-execution/worker.ts';

test('morning brief failures keep internal error codes out of the user-facing message', () => {
  const message = morningBriefFailureMessage('required_source_missing:goals');

  assert.match(message, /required setup information is missing/i);
  assert.match(message, /profile and goals/i);
  assert.doesNotMatch(message, /required_source_missing|goals:/i);
});

test('writer availability and timeout failures give a useful recovery action', () => {
  assert.match(morningBriefFailureMessage('codex_unavailable'), /signed in/i);
  assert.match(morningBriefFailureMessage('codex_timeout'), /try again from Morning Arrival/i);
});
