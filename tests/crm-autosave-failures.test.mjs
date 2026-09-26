import assert from 'node:assert/strict';
import test from 'node:test';
import { componentHarness, tick } from './helpers/component-hooks.mjs';

const elements = (node, type) => !node || typeof node !== 'object' ? [] : [...(node.type === type ? [node] : []), ...[node.props?.children].flat(Infinity).flatMap(child => elements(child, type))];
// The field alerts build their sentence out of several JSX children, so the
// serialised tree splits "Could not save" from the field's name. Read the
// alerts as the sentences a person sees instead.
const fieldAlerts = node => elements(node, 'p')
  .filter(n => n.props?.role === 'alert')
  .map(n => [n.props.children].flat(Infinity).filter(c => typeof c === 'string').join(''));
const contact = { id: 'person-a', name: 'Person A', tier: 'C', tags: [], notes: '', location: '', how_we_met: '' };
const deal = { contact_id: 'person-a', name: 'Person A', stage: 'reach_out', notes: '', next_action: '', source: '', monthly_value: null, discovery_price: null, next_follow_up_at: null };
const globals = { window: { setTimeout: (fn, delay) => { const timer = setTimeout(fn, delay); timer.unref(); return timer; }, clearTimeout } };
function setup(kind, save, identity = 'person-a') {
  const pipeline = kind === 'pipeline';
  const props = pipeline
    ? { deal: { ...deal, contact_id: identity }, stages: [], onClose() {}, onMove() {}, onWritten() {} }
    : { contact: { ...contact, id: identity }, companyName: '', onClose() {}, onSaveContact: save, onDeleteContact() {} };
  const h = componentHarness(pipeline ? 'src/components/crm/PipelineView.tsx' : 'src/components/crm/LocalCRMView.tsx', {
    exportName: pipeline ? 'DealDetailPanel' : 'ContactDetailPanel', globals,
    mocks: { '@/lib/data/crm': { upsertDeal: input => save(input.patch) } },
  });
  const render = () => h.render(props);
  function edit(field, value) {
    const get = () => field === 'notes' ? elements(render(), 'textarea').find(n => n.props.value === undefined ? false : n.props.rows === (pipeline ? 5 : 4))
      : elements(render(), 'input').find(n => n.props.placeholder === (pipeline ? 'Who referred them or where they came from' : 'City, region'));
    get().props.onChange({ target: { value } });
    get().props.onBlur();
  }
  return { render, edit };
}
for (const kind of ['people', 'pipeline']) {
  test(`${kind}: earlier notes failure remains visible after a different field succeeds`, async () => {
    let rejectNotes;
    let failNotes = true;
    const h = setup(kind, patch => patch.notes !== undefined && failNotes
      ? new Promise((resolve, reject) => { rejectNotes = reject; })
      : Promise.resolve(kind === 'pipeline' ? deal : contact));
    h.edit('notes', 'Important notes');
    h.edit('other', 'Santa Monica');
    await tick();
    rejectNotes(new Error('Notes were not saved')); await tick();
    assert.ok(fieldAlerts(h.render()).some(t => t.startsWith('Could not save notes')),
      `no alert about notes; saw ${JSON.stringify(fieldAlerts(h.render()))}`);
    assert.doesNotMatch(JSON.stringify(h.render()), /Notes were not saved/,
      'the thrown message belongs in the console, not on the screen');
    h.edit('other', 'Los Angeles'); await tick();
    assert.ok(fieldAlerts(h.render()).some(t => t.startsWith('Could not save notes')),
      'unrelated save must not hide failed notes');
    assert.ok(elements(h.render(), 'textarea').some(n => n.props.value === 'Important notes'));
    failNotes = false; h.edit('notes', 'Important notes corrected'); await tick();
    assert.ok(!fieldAlerts(h.render()).some(t => t.startsWith('Could not save notes')));
  });
  test(`${kind}: obsolete same-field failure cannot replace a newer successful save`, async () => {
    let rejectOld;
    const h = setup(kind, patch => patch.notes === 'Old draft'
      ? new Promise((resolve, reject) => { rejectOld = reject; })
      : Promise.resolve(kind === 'pipeline' ? deal : contact));
    h.edit('notes', 'Old draft'); h.edit('notes', 'New draft'); await tick();
    rejectOld(new Error('Obsolete request failed')); await tick();
    assert.ok(!fieldAlerts(h.render()).some(t => t.startsWith('Could not save notes')));
    assert.ok(elements(h.render(), 'textarea').some(n => n.props.value === 'New draft'));
    const otherContact = setup(kind, async () => contact, 'person-b');
    assert.ok(elements(otherContact.render(), 'textarea').some(n => n.props.value === ''));
  });
}
