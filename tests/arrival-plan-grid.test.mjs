import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  addNotTodayDropToToday,
  TODAY_ZONE_ID,
} from '../src/components/tasks/arrival/ArrivalPlanGrid.tsx';

test('a Not today drag ending over the Today drop zone calls the add handler', () => {
  const calls = [];
  const handled = addNotTodayDropToToday(
    'not-today:task-a',
    TODAY_ZONE_ID,
    [{ id: 'task-a', title: 'Task A' }],
    (task) => {
      calls.push(task.id);
      return true;
    },
  );

  assert.equal(handled, true);
  assert.deepEqual(calls, ['task-a']);
});

test('the Today drop zone registers from a child rendered inside DndContext', () => {
  const source = readFileSync(
    new URL('../src/components/tasks/arrival/ArrivalPlanGrid.tsx', import.meta.url),
    'utf8',
  );
  const childStart = source.indexOf('function TodayDropZone');
  const gridStart = source.indexOf('export default function ArrivalPlanGrid');
  const contextRender = source.indexOf('<DndContext', gridStart);
  const dropZoneRender = source.indexOf('<TodayDropZone>', contextRender);

  assert.ok(childStart >= 0);
  assert.ok(source.indexOf('useDroppable({ id: TODAY_ZONE_ID })', childStart) < gridStart);
  assert.ok(contextRender >= 0 && dropZoneRender > contextRender);
});
