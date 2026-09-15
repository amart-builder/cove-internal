import assert from 'node:assert/strict';
import test from 'node:test';
import { componentHarness, tick } from './helpers/component-hooks.mjs';

function elements(node, type) {
  if (!node || typeof node !== 'object') return [];
  return [...(node.type === type ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap(child => elements(child, type))];
}
const modal = Symbol('ModalScrim');
const path = 'src/components/tasks/arrival/PlanningFollowUp.tsx';
function setup(mutate = async () => {}) {
  return componentHarness(path, { mocks: {
    './ModalScrim': { default: modal },
    '@/lib/data/day-plan': { mutateDayPlan: mutate, newDayPlanMutationId: () => 'review-once' },
    '@/lib/data/refresh-bus': { emitDataChanged() {} },
  } });
}
const props = { plan: { id: 'plan', version: 4, state: 'active' }, brief: {
  proposalId: 'reviewed-proposal', statusNote: 'Your current choices are preserved.',
  proposedActions: [{ title: 'Prepare a carefully scoped proposal', reason: 'A long explanation. '.repeat(100) }],
} };
test('plan review details open in a scrollable modal without replacing the current plan', () => {
  let calls = 0;
  const h = setup(async () => { calls++; });
  let tree = h.render(props);
  assert.equal(elements(tree, 'ol').length, 0);
  elements(tree, 'button')[0].props.onClick(); tree = h.render(props);
  assert.equal(elements(tree, modal).length, 1);
  assert.match(elements(tree, modal)[0].props.panelClassName, /overflow-y-auto/);
  assert.equal(elements(tree, 'li').length, 1);
  elements(tree, modal)[0].props.onClose();
  assert.equal(elements(h.render(props), modal).length, 0);
  assert.equal(calls, 0);
});
test('plan acceptance uses the exact reviewed version and suppresses a duplicate click', async () => {
  const writes = []; let finish;
  const h = setup(input => { writes.push(input); return new Promise(resolve => { finish = resolve; }); });
  elements(h.render(props), 'button')[0].props.onClick();
  const changed = { ...props, plan: { ...props.plan, version: 9 }, brief: { ...props.brief, proposalId: 'unseen-new-proposal' } };
  const buttons = elements(h.render(changed), 'button');
  const accept = buttons[buttons.length - 1].props.onClick;
  accept(); accept();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].expectedVersion, 4);
  assert.equal(writes[0].briefId, 'reviewed-proposal');
  finish(); await tick();
  assert.equal(elements(h.render(changed), modal).length, 0);
});
test('status-only planning guidance remains reachable without an acceptance control', () => {
  const status = { ...props, brief: { statusNote: 'The earlier plan needs a refresh.' } };
  const h = setup();
  elements(h.render(status), 'button')[0].props.onClick();
  const tree = h.render(status);
  assert.equal(elements(tree, modal).length, 1);
  assert.equal(elements(tree, 'button').length, 2);
});
test('suggestion review keeps proposals unaccepted until an explicit action and blocks rapid repeat', async () => {
  const h = componentHarness('src/components/tasks/QuietCurrentInbox.tsx', { mocks: { './arrival/ModalScrim': { default: modal } } });
  let calls = 0; let finish;
  const p = { loading: false, suggestions: [{ id: 'suggestion', kind: 'create_task', title: 'Prepare next week', reason: 'Upcoming work', source: 'calendar' }],
    onAccept: async () => { calls++; await new Promise(resolve => { finish = resolve; }); }, onRetry: async () => {}, onDefer: async () => {}, onDismiss: async () => {}, onRefine: async () => {},
  };
  elements(h.render(p), 'button')[0].props.onClick();
  let tree = h.render(p); assert.equal(calls, 0);
  const accept = elements(tree, 'button').find(button => button.props.children === 'Accept');
  accept.props.onClick(); accept.props.onClick();
  assert.equal(calls, 1); finish(); await tick();
  tree = h.render(p); assert.equal(elements(tree, modal).length, 0);
});

test('failed suggestion acceptance keeps the review open', async () => {
  const h = componentHarness('src/components/tasks/QuietCurrentInbox.tsx', { mocks: { './arrival/ModalScrim': { default: modal } } });
  const p = { loading: false, suggestions: [{ id: 'suggestion', kind: 'create_task', title: 'Prepare next week', reason: 'Upcoming work', source: 'calendar' }],
    onAccept: async () => false, onRetry: async () => {}, onDefer: async () => {}, onDismiss: async () => {}, onRefine: async () => {},
  };
  elements(h.render(p), 'button')[0].props.onClick();
  elements(h.render(p), 'button').find(button => button.props.children === 'Accept').props.onClick();
  await tick();
  assert.equal(elements(h.render(p), modal).length, 1);
});
