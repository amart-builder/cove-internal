import assert from 'node:assert/strict';
import test from 'node:test';
import { routeBuddyTurn } from '../src/lib/buddy/router.ts';

test('deep override wins over every routing signal', () => {
  assert.deepEqual(routeBuddyTurn('add this', undefined, 'deep'), {
    model: 'opus', effort: 'high', reason: 'Deep override',
  });
});

test('fast override wins over planning cues', () => {
  assert.deepEqual(routeBuddyTurn('help me figure out my quarter?', undefined, 'fast'), {
    model: 'sonnet', effort: 'low', reason: 'Fast override',
  });
});

test('confirmed deletes always use the short action route', () => {
  assert.deepEqual(routeBuddyTurn('CONFIRM_DELETE token=t table=contacts id=c1'), {
    model: 'sonnet', effort: 'low', reason: 'Confirmed delete',
  });
});

test('long requests escalate', () => {
  const route = routeBuddyTurn('Tell me about ' + 'x'.repeat(390));
  assert.equal(route.model, 'opus');
  assert.equal(route.reason, 'Long request');
});

test('two questions escalate', () => {
  assert.equal(routeBuddyTurn('What happened? What next?').reason, 'Multiple questions');
});

test('planning cues are case insensitive and take precedence over imperatives', () => {
  const cues = ['Restructure this', 'plan today', 'STRATEGY', 'prioritize', 're-prioritize',
    'review my day', 'trade-off', 'tradeoff', 'think through this', 'think hard', 'why now',
    'this week', 'next quarter', 'roadmap', 'goals', 'focus', 'organize', 'overwhelmed',
    'decide', 'should I go', 'help me figure this out'];
  for (const cue of cues) assert.equal(routeBuddyTurn(cue).reason, 'Planning request', cue);
  assert.equal(routeBuddyTurn('add this to my roadmap').reason, 'Planning request');
});

test('short first-word imperatives use the fast route', () => {
  const verbs = ['move', 'rename', 'add', 'mark', 'set', 'complete', 'delete', 'schedule',
    'create', 'finish', 'push', 'bump', 'remind', 'check'];
  for (const verb of verbs) {
    assert.equal(routeBuddyTurn(`${verb} the item`).reason, 'Short action', verb);
  }
});

test('long imperatives and general conversation use the default route', () => {
  assert.equal(routeBuddyTurn(`add ${'detail '.repeat(24)}`).reason, 'General conversation');
  assert.deepEqual(routeBuddyTurn('Hello Buddy'), {
    model: 'sonnet', effort: 'medium', reason: 'General conversation',
  });
});
