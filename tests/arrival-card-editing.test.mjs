import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tagsWithBlockedFlag, visibleTags } from '../src/lib/tasks/tags.ts';

const componentPath = (...parts) => path.join(
  process.cwd(),
  'src',
  'components',
  'tasks',
  ...parts,
);

test('Not today expands in place and persists only the expanded day', () => {
  const source = readFileSync(componentPath('arrival', 'ArrivalPlanGrid.tsx'), 'utf8');

  assert.match(source, /cove\.arrival\.not-today-expanded\./);
  assert.match(source, /window\.localStorage\.getItem\(`\$\{EXPANSION_KEY_PREFIX\}\$\{localDate\}`\) === '1'/);
  assert.match(source, /window\.localStorage\.setItem\(key, '1'\)/);
  assert.match(source, /window\.localStorage\.removeItem\(key\)/);
  assert.match(source, /const boardTasks = expanded \? notTodayTasks : notTodayTasks\.slice\(0, BOARD_TASK_LIMIT\)/);
  assert.match(source, /const allWorkTileLabel = expanded \? 'Show fewer'/);
  assert.match(source, /aria-expanded=\{expanded\}/);
  assert.match(source, /onClick=\{toggleExpanded\}/);
});

test('Arrival and closeout expose the shared task fields editor', () => {
  const taskSheet = readFileSync(componentPath('arrival', 'TaskSheet.tsx'), 'utf8');
  const arrivalGrid = readFileSync(componentPath('arrival', 'ArrivalPlanGrid.tsx'), 'utf8');
  const settlement = readFileSync(componentPath('DaySettlement.tsx'), 'utf8');

  assert.match(taskSheet, /<TaskFieldsEditor/);
  assert.match(taskSheet, /task=\{taskRecord\}/);
  assert.match(taskSheet, /today\?\.task \?\? \(task \? tasksById\.get\(task\.id\) : undefined\)/);
  assert.match(taskSheet, /onSaveTask\(taskRecord\._id, patch\)/);
  assert.match(arrivalGrid, /tasksById=\{tasksById\}/);
  assert.match(settlement, /aria-label=\{`Edit \$\{item\.title\}`\}/);
  assert.match(settlement, /aria-label=\{`Edit \$\{view\.title\}`\}/);
  assert.match(settlement, /<TaskFieldsEditor/);
  assert.match(settlement, /<ModalScrim/);
});

test('Arrival cards and closeout prefer live task data over the plan snapshot', () => {
  const source = readFileSync(componentPath('TodayView.tsx'), 'utf8');

  assert.match(source, /sourceTask\?\.dueAt \?\? sourceTask\?\.dueDate \?\? item\.dueAt/);
  assert.match(source, /helpfulProjectLabel\(sourceTask\?\.project\) \?\? helpfulProjectLabel\(item\.project\)/);
  assert.match(source, /const task = tasksById\.get\(item\.taskId\);/);
});

test('every task editor shows and edits the reason the task was added', () => {
  const fields = readFileSync(componentPath('TaskFieldsEditor.tsx'), 'utf8');
  const detail = readFileSync(componentPath('TaskDetail.tsx'), 'utf8');
  const sheet = readFileSync(componentPath('arrival', 'TaskSheet.tsx'), 'utf8');
  const today = readFileSync(componentPath('TodayView.tsx'), 'utf8');
  const board = readFileSync(componentPath('KanbanBoard.tsx'), 'utf8');

  assert.match(fields, /Reason this task was added/);
  assert.match(fields, /taskEditorPatch\(/);
  assert.match(detail, /Reason this task was added/);
  assert.match(detail, /taskEditorPatch\(/);
  assert.match(sheet, /aria-label="Reason this task was added"/);
  assert.match(sheet, /const origin = taskRecord\?\.origin\?\.trim\(\);/);
  assert.match(today, /origin: task\.origin \?\? undefined/);
  assert.match(today, /origin: patch\.origin,/);
  assert.match(board, /origin: task\.origin \?\? undefined/);
  assert.match(board, /origin: patch\.origin,/);
  for (const site of [
    /You typed this into the Today capture box on/,
    /A Quiet Current suggestion you accepted on/,
    /Buddy added this while replanning your day in Morning Arrival on/,
  ]) assert.match(today, site);
  assert.match(board, /You added this by hand on the All Work board on/);
});

test('both task editors share the blocked tag helpers', () => {
  const fields = readFileSync(componentPath('TaskFieldsEditor.tsx'), 'utf8');
  const detail = readFileSync(componentPath('TaskDetail.tsx'), 'utf8');
  const helpers = readFileSync(
    path.join(process.cwd(), 'src', 'lib', 'tasks', 'tags.ts'),
    'utf8',
  );

  assert.match(fields, /taskEditorPatch\(/);
  assert.match(detail, /taskEditorPatch\(/);
  assert.doesNotMatch(fields, /function visibleTags/);
  assert.doesNotMatch(detail, /function visibleTags/);
  assert.match(helpers, /const visible = visibleTags\(tags\)/);
  assert.deepEqual(visibleTags(['client', ' BLOCKED ', 'follow-up']), ['client', 'follow-up']);
  assert.deepEqual(tagsWithBlockedFlag(['client', 'blocked'], false), ['client']);
  assert.deepEqual(tagsWithBlockedFlag(['client', 'blocked'], true), ['client', 'blocked']);
});

test('the removed All Work picker has no remaining import or file', () => {
  const source = readFileSync(componentPath('arrival', 'ArrivalPlanGrid.tsx'), 'utf8');

  assert.doesNotMatch(source, /AllWorkPicker/);
  assert.equal(existsSync(componentPath('arrival', 'AllWorkPicker.tsx')), false);
});
