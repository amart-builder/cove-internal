import assert from 'node:assert/strict';
import test from 'node:test';
import { combineSurfaceErrors, readableSurfaceError } from '../src/lib/day-plan/presentation.ts';

test('a dead connection is described in Cove’s words, not the browser’s', () => {
  for (const raw of ['Failed to fetch', 'failed to fetch', 'TypeError: Failed to fetch',
                     'Load failed', 'NetworkError when attempting to fetch resource',
                     'fetch failed', 'ERR_INTERNET_DISCONNECTED']) {
    const readable = readableSurfaceError(raw);
    assert.match(readable, /Cove could not reach its own service/);
    assert.doesNotMatch(readable, /fetch|NetworkError|ERR_/i);
  }
});

test('anything Cove wrote itself is left exactly as written', () => {
  const ours = "Cove couldn't finish completing that task. Refresh the current to confirm its state, then try again.";
  assert.equal(readableSurfaceError(ours), ours);
  assert.equal(readableSurfaceError('Could not reach the task service at 127.0.0.1.'),
               'Could not reach the task service at 127.0.0.1.');
});

test('the surface joins what it has and repeats nothing', () => {
  assert.equal(combineSurfaceErrors(undefined, '  ', undefined), undefined);
  assert.equal(combineSurfaceErrors('One thing.', 'One thing.'), 'One thing.');
  // Two browser errors from two failed calls collapse into one sentence.
  assert.equal(
    combineSurfaceErrors('Failed to fetch', 'Load failed'),
    'Cove could not reach its own service. It may still be starting up, so wait a moment and try again.',
  );
  assert.equal(
    combineSurfaceErrors('Failed to fetch', 'Cove could not save that.'),
    'Cove could not reach its own service. It may still be starting up, so wait a moment and try again. Cove could not save that.',
  );
});
