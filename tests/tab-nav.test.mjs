import assert from 'node:assert/strict';
import test from 'node:test';
import {
  preferredDarkTheme,
  tabNavItems,
} from '../src/components/layout/TabNav.tsx';
import { requestedTaskWorkspaceView } from '../src/components/tasks/task-workspace-view.ts';

test('Issues navigation is available only in local runtime mode', () => {
  assert.deepEqual(
    tabNavItems('local').map((item) => item.name),
    ['Today', 'People', 'Issues'],
  );
  assert.deepEqual(
    tabNavItems('supabase').map((item) => item.name),
    ['Today', 'People'],
  );
  assert.deepEqual(
    tabNavItems('convex').map((item) => item.name),
    ['Today', 'People'],
  );
});

test('stored theme preference wins across full page hydration', () => {
  assert.equal(preferredDarkTheme('dark', false), true);
  assert.equal(preferredDarkTheme('light', true), false);
  assert.equal(preferredDarkTheme(null, true), true);
  assert.equal(preferredDarkTheme(null, false), false);
});

test('the merged task switcher preserves direct links to Today and All Work', () => {
  assert.equal(requestedTaskWorkspaceView('?view=all-work', true), 'all-work');
  assert.equal(requestedTaskWorkspaceView('?view=today', true), 'today');
  assert.equal(requestedTaskWorkspaceView('?view=today', false), undefined);
  assert.equal(requestedTaskWorkspaceView('', true), undefined);
});
