import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BOARD_FETCH_RETRY_DELAYS_MS,
  retryBoardRequest,
} from '../src/lib/data/board-refresh.ts';

test('board requests retry twice with the intended backoff before succeeding', async () => {
  let attempts = 0;
  const waits = [];
  const result = await retryBoardRequest(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('transient');
      return 'ready';
    },
    async (milliseconds) => waits.push(milliseconds),
  );
  assert.equal(result, 'ready');
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [...BOARD_FETCH_RETRY_DELAYS_MS]);
});

test('board requests stop after the initial attempt and two retries', async () => {
  let attempts = 0;
  await assert.rejects(
    retryBoardRequest(
      async () => {
        attempts += 1;
        throw new Error('still down');
      },
      async () => undefined,
    ),
    /still down/,
  );
  assert.equal(attempts, 3);
});
