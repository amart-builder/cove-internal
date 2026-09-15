import assert from 'node:assert/strict';
import test from 'node:test';
import { componentHarness, tick } from './helpers/component-hooks.mjs';

function find(node, matches) {
  if (!node || typeof node !== 'object') return undefined;
  if (matches(node)) return node;
  for (const child of [node.props?.children].flat(Infinity)) {
    const result = find(child, matches);
    if (result) return result;
  }
}
function fixture() {
  let completed = 0; let edited; let focused;
  const ref = { current: null };
  const h = componentHarness('src/components/tasks/TodayRiverStageV2.tsx', {
    mocks: {
      '@dnd-kit/core': { useSensor: () => ({}), useSensors: () => [] },
      './today2/motion': { boundToday2MotionData: value => Promise.resolve(value), prefersToday2ReducedMotion: () => true },
    },
    globals: { window: { requestAnimationFrame: callback => callback() } },
  });
  const props = {
    ref,
    model: { timeLabel: '4:00 PM', timeIso: '2026-09-15T23:00:00Z', greeting: 'Day closed', sunPoint: { x: 0, y: 0 },
      doneCount: 1, doneTitles: ['Finished task'], focusCount: 1, orderedTasks: [{ id: 'carry', itemId: 'carry-item', title: 'Retained work', description: 'Continue tomorrow', owner: 'You', sessionBusy: false }],
      notTodayCount: 0, activeRunCount: 0, localMode: true, reorderEnabled: false, focusCountBusy: false, rhythmCount: 0, secondCurrentItems: [], ritualOpen: false, dayClosed: true },
    callbacks: { onCompleteTask: async () => { completed++; }, onFocusTask: id => { focused = id; }, onEditTask: id => { edited = id; }, onMotionDataFailure: () => assert.fail('no completion should fail') },
  };
  const card = tree => find(tree, node => node.type?.name === 'FocusCard');
  return { h, props, ref, card, counts: () => ({ completed, edited, focused }) };
}

test('closed Today retains its card and editable details while completion is visibly disabled', async () => {
  const {h,props,card,counts} = fixture();
  let tree = h.render(props);
  assert.match(JSON.stringify(tree), /This day is closed.*All Work/);
  let focus = card(tree);
  assert.ok(focus, 'retained work stays visible');
  assert.equal(focus.props.dayClosed, true);
  let renderedCard = focus.type(focus.props);
  const complete = find(renderedCard, node => node.props?.['aria-label'] === 'Complete Retained work');
  assert.equal(complete.props.disabled, true);
  assert.match(complete.props.title, /This day is closed/);
  complete.props.onClick({ stopPropagation() {} });
  await tick();
  assert.equal(counts().completed, 0);
  find(renderedCard, node => node.props?.['aria-label'] === 'Open details for Retained work').props.onClick();
  tree = h.render(props); focus = card(tree);
  assert.equal(focus.props.detailOpen, true);
  assert.equal(counts().focused, 'carry');
  renderedCard = focus.type(focus.props);
  find(renderedCard, node => node.type === 'button' && node.props.children === 'More').props.onClick({ currentTarget: {} });
  tree = h.render(props);
  find(tree, node => node.type?.name === 'FocusRichSheet').props.onEdit();
  assert.equal(counts().edited, 'carry', 'task detail editing stays reachable');
});

test('closing Today also blocks captured completion and Undo callbacks; active completion still works', async () => {
  const {h,props,ref,card,counts} = fixture();
  props.model.dayClosed = false;
  let tree = h.render(props);
  const openCard = card(tree);
  assert.equal(find(openCard.type(openCard.props), node => node.props?.['aria-label'] === 'Complete Retained work').props.disabled, false);
  openCard.props.onComplete(); await tick();
  assert.equal(counts().completed, 1);
  const previousUndo = ref.current.runUndo;
  props.model = { ...props.model, dayClosed: true };
  tree = h.render(props);
  assert.equal(card(tree).props.dayClosed, true);
  openCard.props.onComplete();
  let undos = 0;
  await previousUndo('carry', 0, async () => { undos++; });
  await tick();
  assert.equal(counts().completed, 1);
  assert.equal(undos, 0);
});
