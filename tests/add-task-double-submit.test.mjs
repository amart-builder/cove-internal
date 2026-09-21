import assert from 'node:assert/strict';
import test from 'node:test';
import { componentHarness, findElement, tick } from './helpers/component-hooks.mjs';
import * as columns from '../src/lib/tasks/columns.ts';
import * as editorPatch from '../src/lib/tasks/editor-patch.ts';
import * as origin from '../src/lib/tasks/origin.ts';

// One genuine double-click on Add Task made two identical tasks, and two fast
// Enter presses did the same. Measured in a browser before the guard:
// "Genuine double click" appeared twice and "Double enter" appeared twice. For
// an app whose job is keeping track of what you have committed to, an
// impatient click should not quietly commit you to a thing twice.
//
// Buddy has been guarded against this since it was written — see "Buddy
// ignores a second submit before its first request claims a turn" in
// screen-draft-preservation.test.mjs — and so has completing a task, via
// completingTaskId. Adding one was the form that was not.

// The real modules where the component only reads data from them, stubs where
// it only needs them not to throw.
const MOCKS = {
  '@/lib/runtime/mode': { getRuntimeMode: () => 'local' },
  '@/lib/data/refresh-bus': { useDataChanged() {} },
  '@/lib/tasks/columns': columns,
  '@/lib/tasks/editor-patch': editorPatch,
  '@/lib/tasks/origin': origin,
  './useTaskLink': { useTaskLink() {} },
  './useTaskSessionRuns': { default: () => ({ runs: [], startRun() {}, cancelRun() {} }) },
  '@dnd-kit/core': {
    DndContext: 'DndContext', DragOverlay: 'DragOverlay', KeyboardSensor: 'KeyboardSensor',
    PointerSensor: 'PointerSensor', closestCorners: () => [], pointerWithin: () => [],
    useSensor: () => ({}), useSensors: (...sensors) => sensors,
  },
  '@dnd-kit/sortable': {
    SortableContext: 'SortableContext', verticalListSortingStrategy: 'vertical',
    sortableKeyboardCoordinates: () => ({}), arrayMove: (list) => list,
    useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef() {}, transform: null, transition: null, isDragging: false }),
  },
  '@dnd-kit/utilities': { CSS: { Transform: { toString: () => '' }, Translate: { toString: () => '' } } },
};

function boardHarness(onCreateTask) {
  const harness = componentHarness('src/components/tasks/KanbanBoard.tsx', {
    exportName: 'KanbanBoardContent', mocks: MOCKS,
  });
  const props = {
    // The handler needs somewhere to put the task, so the board has to have
    // its Not Started column.
    columnsData: [{ _id: 'col-not-started', name: 'Not Started', position: 0, _creationTime: 0, createdAt: 0 }],
    tasksData: [], loading: false, error: undefined, refreshError: undefined,
    onRetry() {}, onSeed: undefined, onCreateTask, onUpdateTask() {}, onDeleteTask() {},
    onRestoreTask: undefined, onConfirmRecurrence: undefined,
  };
  return { render: () => harness.render(props) };
}

/** Open the add form and type a title, the way the screen is used. */
function openAndType(h, title) {
  findElement(h.render(), 'button', (n) => /open add task form/i.test(n.props?.['aria-label'] ?? '')).props.onClick();
  const form = findElement(h.render(), 'form');
  const field = findElement(form, 'input', (n) => n.props?.placeholder && n.props.value === '');
  field.props.onChange({ target: { value: title } });
}

const submitOf = (h) => findElement(h.render(), 'form').props.onSubmit;
const addButton = (h) =>
  findElement(h.render(), 'button', (n) => n.props?.type === 'submit'
    && /Add Task|Adding/.test([n.props?.children].flat(Infinity).join('')));

test('a second submit is ignored while the first is still saving', async () => {
  let calls = 0;
  let finish;
  const h = boardHarness(() => { calls += 1; return new Promise((resolve) => { finish = resolve; }); });
  openAndType(h, 'Genuine double click');
  // Two submits with a render between them, which is what a real double click
  // gets: React has re-rendered by the time the second one lands.
  submitOf(h)({ preventDefault() {} });
  submitOf(h)({ preventDefault() {} });
  assert.equal(calls, 1, 'the second submit made a second task');
  finish(); await tick();
});

test('the button says it is working and cannot be pressed again', async () => {
  let finish;
  const h = boardHarness(() => new Promise((resolve) => { finish = resolve; }));
  openAndType(h, 'Genuine double click');
  submitOf(h)({ preventDefault() {} });
  const button = addButton(h);
  assert.equal(button.props.disabled, true, 'the submit button stays pressable while the task is saving');
  assert.match([button.props.children].flat(Infinity).join(''), /Adding/, 'the button does not say it is working');
  finish(); await tick();
});

test('a failed save lets you try again', async () => {
  let calls = 0;
  const h = boardHarness(async () => { calls += 1; throw new Error('nope'); });
  openAndType(h, 'Genuine double click');
  submitOf(h)({ preventDefault() {} });
  await tick();
  submitOf(h)({ preventDefault() {} });
  await tick();
  assert.equal(calls, 2, 'the guard stayed on after a failure, so the draft could never be sent');
});
