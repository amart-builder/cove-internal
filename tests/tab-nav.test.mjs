import assert from 'node:assert/strict';
import test from 'node:test';
import {
  preferredDarkTheme,
  tabNavItems,
  shouldAutoHideMainNav,
} from '../src/components/layout/TabNav.tsx';
import { requestedTaskWorkspaceView, requestedTaskLink } from '../src/components/tasks/task-workspace-view.ts';

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


test('notification task links wait for loaded tasks and match only the exact task', () => {
 const tasks=[{_id:'carlo-task'},{_id:'other'}];
 assert.equal(requestedTaskLink('?task=carlo-task',[]),undefined);
 assert.equal(requestedTaskLink('?task=carlo-task',tasks),'carlo-task');
 assert.equal(requestedTaskLink('?view=all-work&task=carlo%2Dtask',tasks),'carlo-task');
 assert.equal(requestedTaskLink('?task=missing',tasks),undefined);
 assert.equal(requestedTaskLink('?task=',tasks),undefined);
});

test('only Today hides navigation, while All Work and other screens keep it visible', () => {
  assert.equal(shouldAutoHideMainNav('/tasks', 'today'), true);
  assert.equal(shouldAutoHideMainNav('/tasks', 'all-work'), false);
  for (const path of ['/crm', '/failures', '/guide', '/settings', '/tasks/new']) {
    assert.equal(shouldAutoHideMainNav(path, 'today'), false);
  }
});
