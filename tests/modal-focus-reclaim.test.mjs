import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHarness } from './helpers/component-hooks.mjs';

// A control that removes itself when it is used takes the keyboard with it, and
// the browser drops focus on the document body. The body is outside the modal's
// portal, so the scrim's Escape and Tab handling stops seeing keys and the modal
// cannot be closed from the keyboard. Measured in a browser on the email review
// panel: press Mark handled, then Escape, and the panel stays open.

const { render } = componentHarness('src/components/tasks/arrival/ModalScrim.tsx', {
  exportName: 'shouldReclaimFocus',
  mocks: { 'react-dom': { createPortal: (node) => node } },
});

const state = (overrides) => ({
  dialogConnected: true,
  focusInsideDialog: false,
  focusInsideAnotherModal: false,
  isTopmostModal: true,
  ...overrides,
});

test('the keyboard comes back when a used-up control drops focus on the body', () => {
  assert.equal(render(state()), true);
});

test('moving between controls inside the dialog is left alone', () => {
  assert.equal(render(state({ focusInsideDialog: true })), false);
});

test('a dialog opened on top of this one keeps the keyboard', () => {
  assert.equal(render(state({ focusInsideAnotherModal: true, isTopmostModal: false })), false);
});

test('a dialog underneath another one does not fight for focus', () => {
  assert.equal(render(state({ isTopmostModal: false })), false);
});

test('a dialog on its way out does not pull focus back', () => {
  assert.equal(render(state({ dialogConnected: false })), false);
});

test('a closing dialog stays closing even while it is still topmost', () => {
  assert.equal(render(state({ dialogConnected: false, isTopmostModal: true })), false);
});
