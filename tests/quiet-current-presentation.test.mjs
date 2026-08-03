import assert from 'node:assert/strict';
import test from 'node:test';
import { realTimeLabel } from '../src/lib/quiet-current/presentation.ts';

test('UTC midnight stays an un-timed date', () => {
  assert.equal(realTimeLabel('2026-07-15T00:00:00.000Z'), undefined);
});

test('a date-only deadline never fabricates a local clock time', () => {
  assert.equal(realTimeLabel('2026-07-15'), undefined);
});

test('a supplied clock time remains visible', () => {
  assert.match(realTimeLabel('2026-07-15T18:30:00.000Z') ?? '', /\d/);
});
