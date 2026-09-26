import assert from 'node:assert/strict';
import test from 'node:test';
import { componentHarness, findElement } from './helpers/component-hooks.mjs';
import { BOARD_MOCKS, boardProps, fakeDocument } from './helpers/board-harness.mjs';

// The Filter popover floats over the All Work board and covers a task card
// while it is open. It is a native <details>, which closes only when its own
// summary is pressed again, so Escape and a press anywhere else on the board
// both left it hanging there. Measured in a browser: the popover sat over the
// first card in Done through an Escape and an outside click.
//
// Every other floating panel in Cove closes on both -- the Second Current
// drawer, the Rhythms panel (see rhythm-panel-dismiss.test.mjs) and the task
// editor -- so the Filter was the one that did not.

function filterHarness({ open = true, activeElement = null } = {}) {
  const doc = fakeDocument(activeElement);
  const harness = componentHarness('src/components/tasks/KanbanBoard.tsx', {
    exportName: 'KanbanBoardContent', mocks: BOARD_MOCKS, globals: { document: doc },
  });
  const render = () => harness.render(boardProps());
  const tree = render();
  const details = findElement(tree, 'details', (n) => /all-work-filter/.test(n.props?.className ?? ''));
  assert.ok(details, 'the board no longer has a Filter popover, so this test is measuring nothing');
  const summary = { focused: 0 };
  // Stands in for the rendered <details>: React attaches the real element here.
  details.props.ref.current = {
    open,
    contains: (node) => node === INSIDE,
    querySelector: () => ({ focus: () => { summary.focused += 1; } }),
  };
  return { doc, harness, element: details.props.ref.current, summary,
    settle: async () => { render(); await harness.effects(); } };
}

const INSIDE = { id: 'inside the popover' };
const OUTSIDE = { id: 'somewhere else on the board' };

test('Escape closes the Filter popover', async () => {
  const h = filterHarness();
  await h.settle();
  const keydown = h.doc.find('keydown');
  assert.ok(keydown, 'the board listens for no key, so Escape cannot reach the popover');
  keydown.handler({ type: 'keydown', key: 'Escape' });
  assert.equal(h.element.open, false, 'Escape left the Filter popover open over the board');
});

test('a key that is not Escape leaves the popover alone', async () => {
  const h = filterHarness();
  await h.settle();
  h.doc.find('keydown').handler({ type: 'keydown', key: 'f' });
  assert.equal(h.element.open, true, 'typing closed the Filter popover');
});

test('a press outside closes the popover, a press inside does not', async () => {
  const h = filterHarness();
  await h.settle();
  const pointerdown = h.doc.find('pointerdown');
  assert.ok(pointerdown, 'the board does not notice a press outside the popover');
  pointerdown.handler({ type: 'pointerdown', target: INSIDE });
  assert.equal(h.element.open, true, 'using the popover closed it');
  pointerdown.handler({ type: 'pointerdown', target: OUTSIDE });
  assert.equal(h.element.open, false, 'a press on the board left the popover open');
});

test('Escape hands the keyboard back only when it was inside the popover', async () => {
  const inside = filterHarness({ activeElement: INSIDE });
  await inside.settle();
  inside.doc.find('keydown').handler({ type: 'keydown', key: 'Escape' });
  assert.equal(inside.summary.focused, 1,
    'the keyboard was dropped on the page when the popover closed under it');

  // Escape pressed while typing in the board's search box must not snatch focus.
  const elsewhere = filterHarness({ activeElement: OUTSIDE });
  await elsewhere.settle();
  elsewhere.doc.find('keydown').handler({ type: 'keydown', key: 'Escape' });
  assert.equal(elsewhere.element.open, false, 'Escape did not close the popover');
  assert.equal(elsewhere.summary.focused, 0,
    'Escape pulled the keyboard out of whatever the person was typing in');
});

test('a popover that is already closed does not react at all', async () => {
  // INSIDE as the active element is what the board looks like just after the
  // popover was closed some other way: the guard has to be the open flag, not
  // where the keyboard happens to be, or Escape keeps pulling focus onto a
  // Filter button nobody opened.
  const h = filterHarness({ open: false, activeElement: INSIDE });
  await h.settle();
  h.doc.find('keydown').handler({ type: 'keydown', key: 'Escape' });
  h.doc.find('pointerdown').handler({ type: 'pointerdown', target: OUTSIDE });
  assert.equal(h.element.open, false);
  assert.equal(h.summary.focused, 0, 'a closed popover still grabbed the keyboard on Escape');
});
