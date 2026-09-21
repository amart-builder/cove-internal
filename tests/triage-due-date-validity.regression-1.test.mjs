import assert from 'node:assert/strict';
import test from 'node:test';
import { validateTriageOutput } from '../src/lib/triage/protocol.ts';

// due_at is the one free-form value in the triage contract that drives
// scheduling: the column a card lands in, when a reminder fires, whether the
// card reads as overdue. The rest of the contract is exact-key and enum
// checked, so a date the calendar does not have should not be the way through.

const base = {
  title: 'Call the accountant',
  description: 'Q3 filing',
  project: 'Atlas',
  priority: 'medium',
  due_at: '2026-09-22T17:00:00Z',
  autonomy: 'none',
  groundwork_notes: null,
  surface: 'board',
  surface_at: null,
  urgency_reason: 'Filing deadline',
  offer: 'Want the numbers pulled?',
};

function validate(overrides) {
  return validateTriageOutput({ ...base, ...overrides }, []);
}

test('a real timestamp still passes, in Z and in an offset', () => {
  assert.equal(validate({}).due_at, '2026-09-22T17:00:00Z');
  assert.equal(
    validate({ due_at: '2026-09-22T17:00:00-07:00' }).due_at,
    '2026-09-22T17:00:00-07:00',
  );
  // 2028 is a leap year; 2026 and 2027 are not, and appear below as rejects.
  assert.equal(validate({ due_at: '2028-02-29T09:00:00Z' }).due_at, '2028-02-29T09:00:00Z');
  assert.equal(validate({ due_at: '2026-09-22T17:00Z' }).due_at, '2026-09-22T17:00Z');
  assert.equal(
    validate({ due_at: '2026-09-22T17:00:00.123Z' }).due_at,
    '2026-09-22T17:00:00.123Z',
  );
});

test('a day the calendar does not have is rejected, not rolled forward', () => {
  // Date.parse takes these and silently rolls them over, so the card lands on
  // a date nobody chose.
  for (const due of [
    '2026-02-30T17:00:00Z',
    '2027-02-29T17:00:00Z',
    '2026-02-29T17:00:00Z',
    '2026-04-31T17:00:00Z',
    '2026-13-01T17:00:00Z',
    '2026-00-10T17:00:00Z',
    '2026-09-00T17:00:00Z',
  ]) {
    assert.throws(() => validate({ due_at: due }), /triage_due_at_invalid/, due);
  }
});

test('a clock reading the day does not have is rejected', () => {
  for (const due of [
    '2026-09-22T24:00:00Z',
    '2026-09-22T17:60:00Z',
    '2026-09-22T17:00:60Z',
  ]) {
    assert.throws(() => validate({ due_at: due }), /triage_due_at_invalid/, due);
  }
});

test('an impossible UTC offset is rejected', () => {
  assert.throws(() => validate({ due_at: '2026-09-22T17:00:00+23:59' }), /triage_due_at_invalid/);
  assert.throws(() => validate({ due_at: '2026-09-22T17:00:00+00:60' }), /triage_due_at_invalid/);
  assert.equal(
    validate({ due_at: '2026-09-22T17:00:00+14:00' }).due_at,
    '2026-09-22T17:00:00+14:00',
  );
});

test('surface_at is checked the same way', () => {
  assert.throws(
    () => validate({ surface: 'scheduled', surface_at: '2026-02-30T17:00:00Z' }),
    /triage_surface_at_invalid/,
  );
});
