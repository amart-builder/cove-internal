import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { helpfulProjectLabel } from '../src/lib/day-plan/presentation.ts';

// 'Atlas' is the tasks table's column default (src/lib/local/migrations.ts:40),
// so on an install where nobody has created a project every task carries it.
// It is a folder name from the machine Cove was built on, not something the
// person chose, and the presentation layer already knows to hide it.

test('the shared project label hides the stored no-project sentinel', () => {
  assert.equal(helpfulProjectLabel('Atlas'), undefined);
  assert.equal(helpfulProjectLabel('atlas'), undefined);
  assert.equal(helpfulProjectLabel(undefined), undefined);
  assert.equal(helpfulProjectLabel('Beacon Engine'), 'Beacon Engine');
});

test('the Today river builds its cards through that label, not the raw column', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'src', 'components', 'tasks', 'TodayView.tsx'),
    'utf8',
  );
  // Only the card model the river renders is in scope here. normalizeRestTask
  // and the session prompt snapshot keep the stored value on purpose: one is
  // the domain record the edit forms write back, the other never reaches a
  // screen.
  const marker = 'useMemo<TodayRiverTaskV2[]>';
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, 'the river card model moved; this guard needs rewriting');
  const block = source.slice(start, source.indexOf('\n  const ', start));
  const projectLine = block
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('project:'));
  assert.ok(projectLine, 'the river card model no longer sets a project');
  assert.match(
    projectLine,
    /helpfulProjectLabel\(/,
    'a card built from the raw project column shows "Atlas" to the person',
  );
});

test('the river stage still has a phrase for a task with no project', () => {
  const stage = readFileSync(
    path.join(process.cwd(), 'src', 'components', 'tasks', 'TodayRiverStageV2.tsx'),
    'utf8',
  );
  assert.match(stage, /'No project'/);
});
