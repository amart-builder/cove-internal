import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const stage = readFileSync(
  new URL('../src/components/tasks/TodayRiverStageV2.tsx', import.meta.url),
  'utf8',
);
const workspace = readFileSync(
  new URL('../src/components/tasks/TaskWorkspace.tsx', import.meta.url),
  'utf8',
);
const nav = readFileSync(
  new URL('../src/components/layout/TabNav.tsx', import.meta.url),
  'utf8',
);
const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');

test('Today focus details use the inline card and shared rich-sheet scrim', () => {
  assert.match(stage, /today2-focus-detail-card/);
  assert.match(stage, /<ModalScrim/);
  assert.match(stage, /aria-label="Close Focus Grid"/);
  assert.doesNotMatch(stage, /today2-task-detail/);
  assert.match(css, /height:\s*158px/);
  assert.match(css, /-webkit-line-clamp:\s*3/);
});

test('the task switcher lives in the fixed auto-hiding main bar only', () => {
  assert.match(nav, /fixed inset-x-0 top-0 z-\[130\]/);
  assert.match(nav, /scheduleHide\(2500\)/);
  assert.match(nav, /quiet-segmented-control/);
  assert.doesNotMatch(workspace, /quiet-workspace-bar|quiet-segmented-control/);
});
