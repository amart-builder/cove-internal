import assert from 'node:assert/strict';
import test from 'node:test';
import { componentHarness, findElement } from './helpers/component-hooks.mjs';

const chips = Symbol('ReceiptChips');
const session = Symbol('SessionLinkCard');
function setup() {
  return componentHarness('src/components/buddy/BuddyMessage.tsx', { mocks: {
    '@/lib/buddy/errors': { isClaudeNotSignedIn: () => false },
    './ReceiptChips': { default: chips },
    './SessionLinkCard': { default: session },
  } });
}
const turn = { id: 'turn', user_text: 'Create two tasks', state: 'failed',
  assistant_text: 'Some changes were completed.', error_code: 'context_overflow_after_changes',
  receipts: { changes: [{ table: 'tasks', id: 'saved-task', action: 'create' }], pendingDeletes: [],
    sessions: [{ sessionId: 'saved-session' }] } };
test('partial overflow preserves receipts and asks for remaining work without replaying the request', () => {
  let retries = 0;
  const tree = setup().render({ turn, onRetry: () => { retries++; } });
  assert.equal(findElement(tree, 'button'), undefined);
  assert.match(JSON.stringify(tree), /ask Buddy for the remaining work/i);
  assert.deepEqual(findElement(tree, chips).props.changes, turn.receipts.changes);
  assert.equal(findElement(tree, session).props.session.sessionId, 'saved-session');
  assert.equal(retries, 0);
});
test('work-free failures retain the explicit retry action', () => {
  const sent = [];
  const tree = setup().render({ turn: { ...turn, error_code: 'spawn_failed', receipts: undefined }, onRetry: text => sent.push(text) });
  findElement(tree, 'button').props.onClick();
  assert.deepEqual(sent, ['Create two tasks']);
});
