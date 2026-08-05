import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Today2MotionDataTimeoutError,
  boundToday2MotionData,
  createToday2MotionWatchdog,
} from '../src/components/tasks/today2/motion.ts';

test('Today motion watchdog leaves an on-time visual transaction unchanged', async () => {
  let watchdogCalls = 0;
  const run = createToday2MotionWatchdog(
    Promise.resolve(),
    () => { watchdogCalls += 1; },
    10,
  );

  assert.equal(await run.finished, 'finished');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(watchdogCalls, 0);
});

test('Today motion watchdog expires a stalled visual transaction once', async () => {
  let watchdogCalls = 0;
  const run = createToday2MotionWatchdog(
    new Promise(() => undefined),
    () => { watchdogCalls += 1; },
    5,
  );

  assert.equal(await run.finished, 'watchdog');
  assert.equal(watchdogCalls, 1);
  run.expire();
  assert.equal(watchdogCalls, 1);
});

test('cancelling Today motion resolves without invoking watchdog cleanup', async () => {
  let watchdogCalls = 0;
  const run = createToday2MotionWatchdog(
    new Promise(() => undefined),
    () => { watchdogCalls += 1; },
    20,
  );

  run.cancel();
  assert.equal(await run.finished, 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(watchdogCalls, 0);
});

test('Today motion data watchdog preserves an on-time result', async () => {
  assert.equal(await boundToday2MotionData(Promise.resolve('saved'), 20), 'saved');
});

test('Today motion data watchdog rejects a stalled operation without cancelling its source', async () => {
  let resolveSource;
  const source = new Promise((resolve) => { resolveSource = resolve; });
  await assert.rejects(
    boundToday2MotionData(source, 5),
    (error) => error instanceof Today2MotionDataTimeoutError,
  );
  resolveSource('late success');
  assert.equal(await source, 'late success');
});
