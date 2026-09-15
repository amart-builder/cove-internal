import assert from 'node:assert/strict';
import test from 'node:test';
import { componentHarness, findElement, tick } from './helpers/component-hooks.mjs';

function buddyHarness(send, busy = false) {
  return componentHarness('src/components/buddy/BuddyPanel.tsx', { mocks: {
    './BuddyProvider': { useBuddy: () => ({ open: false, turns: [], send, busy }), useBuddyStream: () => ({}) },
  }});
}
test('Buddy retains an unsent prompt after the request fails before claiming a turn', async () => {
  const harness = buddyHarness(async () => { throw new Error('Connection unavailable'); });
  let tree = harness.render();
  findElement(tree, 'textarea').props.onChange({ target: { value: 'Please preserve these detailed instructions' }, currentTarget: { style: {}, scrollHeight: 40 } });
  tree = harness.render();
  findElement(tree, 'form').props.onSubmit({ preventDefault() {} });
  await tick();
  tree = harness.render();
  assert.equal(findElement(tree, 'textarea').props.value, 'Please preserve these detailed instructions');
});
test('Buddy ignores a second submit before its first request claims a turn', async () => {
  let calls = 0;
  let finish;
  const harness = buddyHarness(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  let tree = harness.render();
  findElement(tree, 'textarea').props.onChange({ target: { value: 'One request' }, currentTarget: { style: {}, scrollHeight: 40 } });
  tree = harness.render();
  const submit = findElement(tree, 'form').props.onSubmit;
  submit({ preventDefault() {} }); submit({ preventDefault() {} });
  assert.equal(calls, 1);
  finish({ state: 'succeeded' }); await tick();
});
test('Buddy disables its composer while a turn is starting', () => {
  const harness = buddyHarness(async () => undefined, true);
  assert.equal(findElement(harness.render(), 'textarea').props.disabled, true);
});
test('All Work keeps the editor-bearing board mounted during refresh and refresh failure', async () => {
  let loadTasks = async () => [];
  const harness = componentHarness('src/components/tasks/KanbanBoard.tsx', {
    exportName: 'SupabaseKanbanBoard', mocks: {
      '@/lib/runtime/mode': { getRuntimeMode: () => 'local' },
      '@/lib/data/refresh-bus': { useDataChanged() {} },
      '@/lib/data/tasks': { listTasks: () => loadTasks(), listTaskColumns: async () => [] },
    },
  });
  harness.render(); await harness.effects();
  let tree = harness.render(); assert.equal(tree.props.loading, false);
  let fail;
  loadTasks = () => new Promise((resolve, reject) => { fail = reject; });
  const refresh = tree.props.onRetry();
  tree = harness.render(); assert.equal(tree.props.loading, false, 'background refresh must retain TaskDetail mount');
  fail(new Error('temporary failure')); await refresh;
  tree = harness.render();
  assert.equal(tree.props.error, undefined, 'background error must not replace board with full-page error');
  assert.match(tree.props.refreshError, /temporary failure/);
});

test('Buddy clears delivered text but preserves text typed while the send finishes', async () => {
  let finish;
  const harness = buddyHarness(() => new Promise(resolve => { finish = resolve; }));
  const type = value => findElement(harness.render(), 'textarea').props.onChange({ target: { value }, currentTarget: { style: {}, scrollHeight: 40 } });
  type('First request');
  findElement(harness.render(), 'form').props.onSubmit({ preventDefault() {} });
  type('A newer draft');
  finish({ state: 'succeeded' }); await tick();
  assert.equal(findElement(harness.render(), 'textarea').props.value, 'A newer draft');
});

function closeoutHarness(storage) {
  return componentHarness('src/components/tasks/useCloseoutDraft.ts', { globals: { window: { localStorage: storage, setTimeout, clearTimeout } } });
}
function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
test('closeout note survives unmount and reload and remains isolated by plan', async () => {
  const storage = memoryStorage();
  let harness = closeoutHarness(storage);
  harness.render('plan-one'); await harness.effects();
  harness.render('plan-one').setNote('Call happened. Keep these 8,000 character notes.');
  harness = closeoutHarness(storage);
  assert.equal(harness.render('plan-one').note, ''); // hydration matches server
  await harness.effects();
  assert.equal(harness.render('plan-one').note, 'Call happened. Keep these 8,000 character notes.');
  assert.equal(harness.render('plan-two').note, '');
  await harness.effects();
  harness.render('plan-two').setNote('Different day');
  harness.render('plan-two').clearSavedDraft('plan-one', 'Call happened. Keep these 8,000 character notes.');
  assert.equal(harness.render('plan-two').note, 'Different day', 'late previous-day completion cannot erase current draft');
  const reloaded = closeoutHarness(storage);
  reloaded.render('plan-one'); await reloaded.effects();
  assert.equal(reloaded.render('plan-one').note, '');
  reloaded.render('plan-two'); await reloaded.effects();
  assert.equal(reloaded.render('plan-two').note, 'Different day');
});
test('closeout keeps text and surfaces unavailable browser persistence', async () => {
  const storage = { getItem() { throw Error('blocked'); }, setItem() { throw Error('full'); }, removeItem() { throw Error('blocked'); } };
  const harness = closeoutHarness(storage);
  harness.render('plan-one'); await harness.effects();
  harness.render('plan-one').setNote('Do not lose current typing');
  const state = harness.render('plan-one');
  assert.equal(state.note, 'Do not lose current typing');
  assert.match(state.error, /Keep this page open/);
});

test('closeout completion cannot erase newer same-plan typing or another tab draft', async () => {
  const storage = memoryStorage();
  const harness = closeoutHarness(storage);
  harness.render('plan-one'); await harness.effects();
  harness.render('plan-one').setNote('Submitted note');
  const pendingClear = harness.render('plan-one').clearSavedDraft;
  harness.render('plan-one').setNote('A new detail after submission');
  pendingClear('plan-one', 'Submitted note');
  assert.equal(harness.render('plan-one').note, 'A new detail after submission');
  const otherTab = closeoutHarness(storage);
  otherTab.render('plan-one'); await otherTab.effects();
  assert.equal(otherTab.render('plan-one').note, 'A new detail after submission');
  otherTab.render('plan-one').setNote('An even newer detail in another tab');
  pendingClear('plan-one', 'A new detail after submission');
  const reloaded = closeoutHarness(storage);
  reloaded.render('plan-one'); await reloaded.effects();
  assert.equal(reloaded.render('plan-one').note, 'An even newer detail in another tab');
});
