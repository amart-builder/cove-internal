import assert from 'node:assert/strict';
import test from 'node:test';
import { validateChiefOfStaffDueAt } from '../src/lib/chief-of-staff/driver.ts';

// The wake loop writes deadlines onto the person's real tasks. Its check was
// "matches YYYY-MM-DD, or Date.parse understands it", and those are joined by
// OR, so anything ten characters long with two dashes got in without ever
// being parsed.

test('the dates the contract is for still pass', () => {
  for (const value of [
    '2026-09-22',
    '2026-09-22T17:00:00Z',
    '2026-09-22T17:00:00-07:00',
    '2028-02-29',
    null,
    undefined,
    '',
  ]) {
    assert.doesNotThrow(() => validateChiefOfStaffDueAt(value, 'due_at'), String(value));
  }
});

test('a date-shaped string the calendar does not have is rejected', () => {
  for (const value of ['2026-13-45', '9999-99-99', '0000-00-00', '2026-02-30', '2026-02-29']) {
    assert.throws(
      () => validateChiefOfStaffDueAt(value, 'due_at'),
      /due_at must be a calendar date or timestamp/,
      value,
    );
  }
});

test('a format the rest of Cove cannot read is rejected', () => {
  // Date.parse turns this into the year 2001, so it passed and set a deadline
  // twenty-five years in the past.
  assert.throws(() => validateChiefOfStaffDueAt('Dec 25', 'due_at'), /calendar date or timestamp/);
  assert.throws(() => validateChiefOfStaffDueAt('tomorrow', 'due_at'), /calendar date or timestamp/);
});

test('the field name in the message is the caller\'s', () => {
  assert.throws(() => validateChiefOfStaffDueAt('2026-13-45', 'remind_at'), /remind_at must be/);
});
