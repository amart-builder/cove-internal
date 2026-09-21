import assert from 'node:assert/strict';
import test from 'node:test';
import { componentHarness } from './helpers/component-hooks.mjs';

// Walks a rendered tree and returns every node of the given intrinsic type.
const elements = (node, type) => !node || typeof node !== 'object'
  ? []
  : [...(node.type === type ? [node] : []),
     ...[node.props?.children].flat(Infinity).flatMap((child) => elements(child, type))];

const CONTROLS = ['input', 'select', 'textarea'];

// A visible caption that is not tied to its field announces nothing, and
// clicking it does not focus the field. Either the label wraps the control or
// it names it by id; a bare sibling <label> is the defect.
function labelling(tree) {
  const labels = elements(tree, 'label');
  const controls = CONTROLS.flatMap((type) => elements(tree, type));
  const ids = new Set(controls.map((node) => node.props?.id).filter(Boolean));
  return {
    unattached: labels.filter((label) => {
      if (label.props?.htmlFor) return false;
      return elements(label, 'input').length + elements(label, 'select').length
        + elements(label, 'textarea').length === 0;
    }).length,
    dangling: labels
      .map((label) => label.props?.htmlFor)
      .filter((target) => target && !ids.has(target)),
    named: controls.filter((node) => node.props?.id || node.props?.['aria-label']).length,
    total: controls.length,
  };
}

test('the task editor ties every caption to its field', () => {
  const harness = componentHarness('src/components/tasks/TaskFieldsEditor.tsx', {
    mocks: {
      '@/lib/tasks/tags': { visibleTags: (tags) => tags ?? [] },
      '@/lib/tasks/editor-patch': {
        taskEditorDraft: (task) => task,
        taskEditorPatch: () => ({}),
        taskEditorExpected: () => ({}),
        taskSaveUnavailableReason: () => undefined,
      },
    },
  });
  const tree = harness.render({
    task: { _id: 'task-a', title: 'A task', description: '', priority: 'medium', dueDate: null, tags: [], origin: '' },
    onSave: async () => {},
    onCancel: () => {},
  });
  const result = labelling(tree);
  assert.equal(result.unattached, 0);
  assert.deepEqual(result.dangling, []);
  assert.equal(result.named, result.total);
  assert.ok(result.total >= 6, `expected the editor's fields, saw ${result.total}`);
});

test('the pipeline deal and add-lead panels tie every caption to its field', () => {
  const globals = { window: { setTimeout: (fn, delay) => { const timer = setTimeout(fn, delay); timer.unref(); return timer; }, clearTimeout } };
  const deal = {
    contact_id: 'person-a', name: 'Person A', stage: 'reach_out', notes: '', next_action: '',
    source: '', monthly_value: null, discovery_price: null, next_follow_up_at: null,
  };
  const panels = [
    ['DealDetailPanel', { deal, stages: [], onClose() {}, onMove() {}, onWritten() {} }],
    ['AddLeadPanel', { stages: [], pipelineContactIds: new Set(), onClose() {}, onCreated() {} }],
  ];
  for (const [exportName, props] of panels) {
    const harness = componentHarness('src/components/crm/PipelineView.tsx', { exportName, globals });
    const result = labelling(harness.render(props));
    assert.equal(result.unattached, 0, `${exportName} has an unattached caption`);
    assert.deepEqual(result.dangling, [], `${exportName} names a field that is not there`);
    assert.equal(result.named, result.total, `${exportName} has an unnamed control`);
  }
});

test('the contact detail ties every caption to its field', () => {
  const harness = componentHarness('src/components/crm/LocalCRMView.tsx', {
    exportName: 'ContactDetailPanel',
    mocks: {
      '@/lib/data/crm': {},
      '@/lib/data/refresh-bus': { useDataChanged: () => {} },
      './CrmSubNav': {},
    },
  });
  const result = labelling(harness.render({
    contact: { id: 'person-a', name: 'Dana', notes: '', location: '', how_we_met: '', tier: 'C', tags: [] },
    companyName: 'Acme',
    onSaveContact: async () => ({}),
    onDeleteContact: async () => {},
    onClose: () => {},
  }));
  assert.equal(result.unattached, 0, 'a caption on the contact detail names no field');
  assert.deepEqual(result.dangling, []);
  assert.equal(result.named, result.total, 'a field on the contact detail has no name');
  assert.ok(result.total >= 5, `expected the detail's fields, saw ${result.total}`);
});

test('the activity form names its fields even with no captions to tie', () => {
  // Kind, title and details show placeholders only, so each carries its own
  // name rather than a caption; a placeholder is not a label.
  const harness = componentHarness('src/components/crm/LocalCRMView.tsx', {
    exportName: 'ActivityTimeline',
    mocks: {
      '@/lib/data/crm': { listContactActivities: async () => [] },
      '@/lib/data/refresh-bus': { useDataChanged: () => {} },
      './CrmSubNav': {},
    },
  });
  const result = labelling(harness.render({ contactId: 'person-a', onActivityAdded: () => {} }));
  assert.equal(result.named, result.total, 'an activity field has no name');
  assert.ok(result.total >= 3, `expected the activity fields, saw ${result.total}`);
});
