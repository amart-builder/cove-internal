import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// Issues has no undo. Dismissing a failure is final, and the screen exists to
// stop a person losing track of something that needs a look -- so dismissing
// one they never chose is the worst thing this screen can do.
//
// It did. Measured in a browser with three failures seeded: double-clicking
// the first Dismiss left only the third, and a reload confirmed the second was
// gone for good. Every Dismiss is already disabled while one is in flight, so
// the author had thought about this; what the guard did not cover is the
// moment the request returns, when the row goes, the row below moves up into
// the same place, and clearing the guard in the same breath hands the second
// half of the double click to a button nobody aimed at.

const source = readFileSync(
  new URL('../src/components/reliability/FailureInbox.tsx', import.meta.url), 'utf8');

const dismiss = source.slice(
  source.indexOf('async function dismiss('),
  source.indexOf('async function loadMoreActivity('));

test('a failure is dismissed while every Dismiss is disabled', () => {
  assert.notEqual(source.indexOf('disabled={dismissingId !== null}'), -1,
    'Dismiss buttons are no longer disabled while a dismissal is in flight, so only '
    + 'the pressed row is guarded and the row that moves into its place is not');
});

test('the guard outlives the re-render that moves the next row up', () => {
  assert.ok(dismiss, 'dismiss() is no longer where this test looks for it');

  const removal = dismiss.indexOf('setItems(');
  assert.notEqual(removal, -1, 'dismiss() no longer removes the row it dismissed');
  const afterRemoval = dismiss.slice(removal);
  assert.match(afterRemoval, /setTimeout\(\(\) => setDismissingId\(null\), \d+\)/,
    'the guard is cleared as soon as the row is removed again, so a double click '
    + 'takes the next failure with it');

  // The old shape. A finally block runs on the success path too, which is
  // exactly the case that must wait.
  assert.doesNotMatch(dismiss, /finally\s*\{[^}]*setDismissingId\(null\)/,
    'dismiss() clears the guard in a finally again, which defeats the wait');
});

test('a failed dismissal can be retried at once', () => {
  // The wait is only worth having on the success path: nothing has moved when
  // the request fails, and making someone wait to try again would be rude.
  const errorPath = dismiss.slice(dismiss.indexOf('catch ('));
  assert.match(errorPath, /setDismissingId\(null\)/,
    'a failed dismissal no longer re-enables the buttons, so it cannot be retried');
  assert.doesNotMatch(errorPath, /setTimeout/,
    'a failed dismissal now waits before it can be retried, which it should not');
});

test('the wait is short enough not to be felt', () => {
  const ms = Number(dismiss.match(/setDismissingId\(null\), (\d+)\)/)?.[1]);
  assert.ok(Number.isFinite(ms), 'no wait is set at all');
  assert.ok(ms >= 250 && ms <= 600,
    `the wait is ${ms}ms; under 250 it stops covering a double click, over 600 it `
    + 'starts to feel like the screen is stuck');
});
