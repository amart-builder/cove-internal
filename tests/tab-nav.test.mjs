import assert from 'node:assert/strict';
import test from 'node:test';
import {
  preferredDarkTheme,
  tabNavItems,
} from '../src/components/layout/TabNav.tsx';

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
