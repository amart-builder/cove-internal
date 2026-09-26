import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// The Rhythms panel lists recurring commitments, ordered active first. That
// ordering is what made a double click dangerous: stopping a rhythm drops it
// down the list and pulls the next one up into the place it left, and a round
// trip here takes about 60ms -- inside the gap between the two halves of one
// double click.
//
// Measured in a browser with three rhythms seeded: double-clicking Stop on the
// first rhythm stopped that rhythm and the one below it, and the API confirmed
// both. This panel has no undo. Double-clicking Pause was the same fault in
// reverse -- it paused and then resumed, so nothing was paused and the panel
// said nothing about it.
//
// Guarding by row id cannot catch either, because the second click lands on a
// different row's button, or on the same button after its label has flipped.
// The guard has to be the whole panel, and has to outlive the re-render.

const source = readFileSync(
  new URL('../src/components/tasks/RhythmManager.tsx', import.meta.url), 'utf8');

const change = source.slice(
  source.indexOf('async function change('),
  source.indexOf('return (', source.indexOf('async function change(')));

test('every control in the panel waits, not just the row that was pressed', () => {
  assert.doesNotMatch(source, /disabled=\{busyId === template\.id\}/,
    'a row is guarded by its own id again, so the row that slides up into its '
    + 'place takes the second half of a double click');
  const guards = source.match(/disabled=\{busyId !== undefined\}/g) ?? [];
  assert.equal(guards.length, 4,
    `${guards.length} of the panel's controls wait on a change; Stop, Restart, the `
    + 'cadence select and Pause all have to');
});

test('the guard outlives the re-render that re-sorts the list', () => {
  assert.ok(change, 'change() is no longer where this test looks for it');
  const reload = change.indexOf('await onChanged()');
  assert.notEqual(reload, -1, 'change() no longer reloads the list after a change');
  assert.match(change.slice(reload), /setTimeout\(\(\) => setBusyId\(undefined\), \d+\)/,
    'the guard is cleared the moment the list reloads again, so a double click '
    + 'acts on whatever has moved under the cursor');
  assert.doesNotMatch(change, /finally\s*\{[^}]*setBusyId\(undefined\)/,
    'change() clears the guard in a finally again, which defeats the wait on the '
    + 'success path that needs it');
});

test('a rhythm that could not be changed can be tried again at once', () => {
  const errorPath = change.slice(change.indexOf('catch'));
  assert.match(errorPath, /setBusyId\(undefined\)/,
    'a failed change no longer re-enables the panel, so it cannot be retried');
  assert.doesNotMatch(errorPath, /setTimeout/,
    'a failed change now waits before it can be retried, which it should not: '
    + 'nothing moved, so there is nothing to wait for');
});

test('the wait is short enough not to be felt', () => {
  const ms = Number(change.match(/setBusyId\(undefined\), (\d+)\)/)?.[1]);
  assert.ok(Number.isFinite(ms), 'no wait is set at all');
  assert.ok(ms >= 250 && ms <= 600,
    `the wait is ${ms}ms; under 250 it stops covering a double click, over 600 it `
    + 'starts to feel like the panel is stuck');
});

test('the pending timer is cleared when the panel goes away', () => {
  assert.match(source, /clearTimeout\(settleTimer\.current\)/,
    'the settle timer is no longer cleared on unmount, so closing the Second '
    + 'Current mid-change leaves a timer setting state on a gone component');
});

// Stop, Restart and Pause were 18px tall, measured in a browser: under the
// 24px minimum, in a panel where Stop ends a recurring commitment for good.
// The negative margin keeps each label exactly where it was -- the panel
// measured 376px tall before and after -- so only the pressable area changed.
test('the panel\'s three text buttons are big enough to hit', () => {
  for (const [label, needle, expected] of [
    ['Restart', '>\n                      Restart', '-my-1.5 py-1.5'],
    ['Stop', '>\n                      Stop', '-my-1.5 py-1.5'],
    ['Pause', "{template.pausedUntil ? 'Resume' : 'Pause'}", 'mt-0.5 py-1.5'],
  ]) {
    const at = source.indexOf(needle);
    assert.notEqual(at, -1, `the ${label} button is no longer where this test looks for it`);
    const markup = source.slice(source.lastIndexOf('<button', at), at);
    assert.ok(markup.includes(expected),
      `the ${label} button lost "${expected}", so it is back to an 18px target`);
  }
});
