import assert from 'node:assert/strict';
import test from 'node:test';
import { morningBriefFailureMessage } from '../src/lib/claude-execution/worker.ts';

test('morning brief failures keep internal error codes out of the user-facing message', () => {
  // A source that can fail once and read fine next time keeps its retry.
  const message = morningBriefFailureMessage('required_source_missing:task_snapshot');

  assert.match(message, /could not load all the information/i);
  assert.doesNotMatch(message, /profile and goals/i);
  assert.match(message, /try again/i);
  assert.doesNotMatch(message, /required_source_missing|task_snapshot/i);

  // A missing goals file is not that: there is no screen for it and no read to
  // repeat, so the message says what is missing instead of promising a retry.
  // It must still carry no internal identifier.
  const goals = morningBriefFailureMessage('required_source_missing:goals');
  assert.doesNotMatch(goals, /try again/i);
  assert.doesNotMatch(goals, /required_source_missing|goals:|task_snapshot/i);
});

test('writer availability and timeout failures give a useful recovery action', () => {
  assert.match(morningBriefFailureMessage('codex_unavailable'), /signed in/i);
  assert.match(morningBriefFailureMessage('codex_timeout'), /try again from Morning Arrival/i);
});
