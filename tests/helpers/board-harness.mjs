import * as columns from '../../src/lib/tasks/columns.ts';
import * as editorPatch from '../../src/lib/tasks/editor-patch.ts';
import * as origin from '../../src/lib/tasks/origin.ts';

// KanbanBoardContent pulls in the drag library, the runtime mode and two task
// hooks before it will render at all. The real modules go in where the board
// only reads data from them, stubs where it only needs them not to throw.
export const BOARD_MOCKS = {
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

/** A board with one Not Started column and no tasks, which is enough to render it. */
export function boardProps(overrides = {}) {
  return {
    columnsData: [{ _id: 'col-not-started', name: 'Not Started', position: 0, _creationTime: 0, createdAt: 0 }],
    tasksData: [], loading: false, error: undefined, refreshError: undefined,
    onRetry() {}, onSeed: undefined, onCreateTask: async () => {}, onUpdateTask() {}, onDeleteTask() {},
    onRestoreTask: undefined, onConfirmRecurrence: undefined,
    ...overrides,
  };
}

/** A stand-in for `document` that hands back the listeners a component registers. */
export function fakeDocument(activeElement = null) {
  const listeners = [];
  return {
    activeElement,
    addEventListener: (type, handler, capture) => listeners.push({ type, handler, capture }),
    removeEventListener: (type, handler) => {
      const index = listeners.findIndex((l) => l.type === type && l.handler === handler);
      if (index >= 0) listeners.splice(index, 1);
    },
    listeners,
    find: (type) => listeners.find((l) => l.type === type),
  };
}
