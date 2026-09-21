import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('hydration cannot leave a dark install looking light', () => {
  // The pre-paint script in the root layout sets the class, and on every real
  // screen React leaves it alone. On a page that does not exist it does not:
  // measured in a browser, <html> carried "dark" at paint and had lost it
  // 150ms later, so a mistyped address showed Cove's light body under a dark
  // nav bar. The mount effect now writes the class it just computed, which is
  // a no-op on every screen where the script's value already stands.
  const source = readFileSync(
    new URL('../src/components/layout/TabNav.tsx', import.meta.url), 'utf8');
  // lastIndexOf, because the function itself is declared above the component.
  const at = source.lastIndexOf('preferredDarkTheme(');
  assert.notEqual(at, -1, 'the mount effect no longer reads the stored theme');
  const effect = source.slice(at, source.indexOf('}, []);', at));
  assert.match(effect, /classList\.toggle\('dark',\s*prefersDark\)/,
    'the mount effect no longer restores the class, so a 404 drops the theme again');
  assert.match(effect, /setDark\(prefersDark\)/,
    'the toggle label and the <html> class are computed separately again, so they can disagree');
});

test('an address that does not exist is still a Cove screen', () => {
  // Without this file Next renders its own 404 and styles the page itself.
  const source = readFileSync(
    new URL('../src/app/not-found.tsx', import.meta.url), 'utf8')
    // The comment above the component explains the very thing being asserted.
    .replace(/\/\/.*$/gm, '');
  assert.match(source, /href="\/"/, 'the not-found page offers no way back to Today');
  const at = source.indexOf('Back to Today');
  assert.notEqual(at, -1, 'the not-found page no longer names where it sends you');
  const link = source.slice(source.lastIndexOf('<Link', at), at);
  assert.match(link, /\bpy-\d/, 'the way back is under the 24px a target needs');
  assert.doesNotMatch(source, /\b404\b/, 'the page shows a status code rather than telling you what happened');
});
