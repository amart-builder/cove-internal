import assert from 'node:assert/strict';
import test from 'node:test';
import { taskSaveUnavailableReason } from '../src/lib/tasks/editor-patch.ts';

test('a dimmed Save always has a sentence, and an active one never does', () => {
  // The button is disabled on exactly this condition, so the two can never
  // disagree: no silent dimming, and no reason printed beside a live button.
  for (const title of ['', '   ', '\n\t ']) {
    assert.equal(taskSaveUnavailableReason({ title }), 'Give this task a title first.');
  }
  for (const title of ['A', ' a task ', 'Draft the one-pager']) {
    assert.equal(taskSaveUnavailableReason({ title }), undefined);
  }
});

test('a save in flight explains itself through the button, not a reason', () => {
  // "Saving..." is already on the button; a second sentence would just repeat it.
  assert.equal(taskSaveUnavailableReason({ title: '', saving: true }), undefined);
  assert.equal(taskSaveUnavailableReason({ title: 'A task', saving: true }), undefined);
});
