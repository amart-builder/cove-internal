import assert from 'node:assert/strict';
import test from 'node:test';
import { arrivalDropOutcome } from '../src/lib/day-plan/presentation.ts';

const drop = (over, extra = {}) => arrivalDropOutcome({
  origin: 'today', startedInFocus: false, focusCount: 2, over, ...extra,
});

test('a drop outside every column moves nothing', () => {
  assert.deepEqual(drop(undefined), { kind: 'unchanged' });
});

test('a task from Not today joins the column it was dropped on', () => {
  assert.deepEqual(drop('priority', { origin: 'not-today' }), { kind: 'moved', zone: 'priority' });
  assert.deepEqual(drop('also-today', { origin: 'not-today' }), { kind: 'moved', zone: 'also-today' });
  // Back where it came from is not a move.
  assert.deepEqual(drop('not-today', { origin: 'not-today' }), { kind: 'unchanged' });
});

test('a full priorities column refuses, and says so once', () => {
  // The refusal used to be announced as "Dropped X in Initial priorities." and
  // then contradicted by the note beside it. One rule, one sentence.
  const note = 'Initial priorities are full at three. Move one down first.';
  assert.deepEqual(drop('priority', { origin: 'not-today', focusCount: 3 }), { kind: 'refused', note });
  assert.deepEqual(drop('priority', { focusCount: 3 }), { kind: 'refused', note });
});

test('the last priority cannot be demoted', () => {
  assert.deepEqual(
    drop('also-today', { startedInFocus: true, focusCount: 1 }),
    { kind: 'refused', note: 'Keep at least one initial priority.' },
  );
  assert.deepEqual(
    drop('also-today', { startedInFocus: true, focusCount: 2 }),
    { kind: 'moved', zone: 'also-today' },
  );
});

test('dropping a task back on the column it is already in changes nothing', () => {
  assert.deepEqual(drop('priority', { startedInFocus: true }), { kind: 'unchanged' });
  assert.deepEqual(drop('also-today', { startedInFocus: false }), { kind: 'unchanged' });
});

test('anything can be set down in Not today', () => {
  assert.deepEqual(drop('not-today', { startedInFocus: true, focusCount: 1 }), { kind: 'moved', zone: 'not-today' });
  assert.deepEqual(drop('not-today'), { kind: 'moved', zone: 'not-today' });
});
