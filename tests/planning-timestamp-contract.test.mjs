import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDailyDecision } from '../src/lib/chief-of-staff/daily-planning.ts';

const source = { kind: 'task', id: 'proposal', version: 'current', revision: 0 };
const context = { plan: null, references: [source], text: '', now: '2026-09-15T15:00:00.000Z' };
const decision = () => ({
  narrativeParagraphs: ['Prepare the known scope while the delivery capacity decision remains open.'],
  actions: [{ source, proposal: null, nextAction: 'Prepare known scope', rationale: 'Use what is already known without promising delivery.', assumptions: [], owner: 'me', state: 'ready', plannedFor: null, nextCheckAt: '2026-09-15T16:00:00Z' }],
  watches: [], questions: [],
});
test('model date-only and event-text scheduling fails closed, with timezone-explicit checks accepted', () => {
  for (const value of ['2026-09-15', 'after capacity is decided', '2026-09-15T16:00:00', '2026-09-15T14:59:59Z', '2026-09-23T16:00:00Z']) {
    for (const field of ['plannedFor', 'nextCheckAt']) {
      const raw = decision(); raw.actions[0][field] = value;
      assert.throws(() => validateDailyDecision(raw, context, { requireNarrative: true }), /planning_check_invalid/);
    }
  }
  const raw = decision(); raw.actions[0].nextCheckAt = '2026-09-15T09:00:00-07:00';
  assert.equal(validateDailyDecision(raw, context).actions[0].nextCheckAt, '2026-09-15T16:00:00.000Z');
  assert.equal(validateDailyDecision(raw, context).actions[0].plannedFor, null);
});
