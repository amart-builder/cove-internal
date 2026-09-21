import assert from 'node:assert/strict';
import test from 'node:test';
import { componentHarness, findElement } from './helpers/component-hooks.mjs';
import { fakeDocument } from './helpers/board-harness.mjs';

// The Rhythms panel opens over the Today screen and covers the third focus
// card while it is there. Measured in a browser before this: Escape did not
// close it -- the Second Current drawer's own Escape handler took the drawer
// down instead, which hid the panel without closing it, so the panel came back
// over that card the next time the drawer was opened, unasked. A pointer press
// outside did the same thing.
//
// Everything else on this screen closes on Escape and on an outside press, so
// this was the one disclosure that did not.

function panelHarness() {
  const doc = fakeDocument();
  const harness = componentHarness('src/components/tasks/RhythmManager.tsx', {
    globals: { document: doc },
    mocks: { '@/lib/data/recurrence': { updateRecurringTemplate: async () => {} } },
  });
  const props = { templates: [], onChanged: async () => {} };
  const render = () => harness.render(props);
  return {
    doc,
    render,
    panel: () => findElement(render(), 'div', (n) => n.props?.id === 'second-current-rhythms'),
    trigger: () => findElement(render(), 'button', (n) => n.props?.['aria-expanded'] !== undefined),
    async open() {
      this.trigger().props.onClick();
      render();            // the effect that registers the listeners runs on the render after the click
      await harness.effects();
      return this;
    },
    async settle() {
      render();
      await harness.effects();
      return this;
    },
  };
}

test('Escape closes the panel and leaves the drawer open', async () => {
  const h = await panelHarness().open();
  assert.ok(h.panel(), 'the panel did not open');

  const keydown = h.doc.find('keydown');
  assert.ok(keydown, 'the panel listens for no key while it is open');
  assert.equal(keydown.capture, true,
    'the listener is not in the capture phase, so the drawer closes before the panel sees the key');

  let stopped = false;
  keydown.handler({ key: 'Escape', stopPropagation: () => { stopped = true; } });
  assert.equal(h.panel(), undefined, 'Escape left the panel open');
  assert.ok(stopped, 'Escape was allowed through to the drawer, which closes the pair at once');
});

test('a key that is not Escape is left alone', async () => {
  const h = await panelHarness().open();
  let stopped = false;
  h.doc.find('keydown').handler({ key: 'g', stopPropagation: () => { stopped = true; } });
  assert.ok(h.panel(), 'another key closed the panel');
  assert.equal(stopped, false, 'the panel swallowed a key that was not its own');
});

test('a press outside closes the panel, a press inside does not', async () => {
  const h = await panelHarness().open();
  const wrapper = findElement(h.render(), 'div', (n) => n.props?.className === 'relative');
  const inside = { id: 'inside' };
  wrapper.props.ref.current = { contains: (node) => node === inside };

  h.doc.find('pointerdown').handler({ target: inside });
  assert.ok(h.panel(), 'a press on the panel itself closed it');

  h.doc.find('pointerdown').handler({ target: { id: 'somewhere else' } });
  assert.equal(h.panel(), undefined, 'a press outside left the panel open');
});

test('closing with Escape puts the keyboard back on the button that opened it', async () => {
  const h = await panelHarness().open();
  let focused = 0;
  h.trigger().props.ref.current = { focus: () => { focused += 1; } };
  h.doc.find('keydown').handler({ key: 'Escape', stopPropagation: () => {} });
  assert.equal(h.panel(), undefined, 'Escape left the panel open');
  assert.equal(focused, 1, 'the keyboard was dropped on the page instead of returning to the Rhythms button');
});

test('the closed panel listens for nothing', async () => {
  const h = await panelHarness().settle();
  assert.equal(h.doc.listeners.length, 0,
    'a panel that is not open is still listening, so it can swallow keys meant for the page');
});
