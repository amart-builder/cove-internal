import assert from 'node:assert/strict';
import test from 'node:test';
import { taskEditorDraft, taskEditorPatch } from '../src/lib/tasks/editor-patch.ts';

const original = {
  title: 'Write brief', description: 'Original notes', priority: 'medium',
  dueDate: '2026-09-04', origin: 'Asked during meeting', tags: ['client'],
  columnId: 'today', blocked: false,
};

test('editing a title preserves concurrent changes to every untouched field', () => {
  const baseline = taskEditorDraft(original);
  const latest = {
    ...original, description: 'Buddy added research', dueDate: '2026-09-08',
    priority: 'high', origin: 'Updated evidence', tags: ['client', 'blocked'],
    columnId: 'later',
  };
  const patch = taskEditorPatch(baseline, { ...baseline, title: 'Send brief' }, latest.tags);
  assert.deepEqual(patch, { title: 'Send brief' });
  assert.deepEqual({ ...latest, ...patch }, { ...latest, title: 'Send brief' });
});

test('unchanged fields and edits reverted to the original value produce no writes', () => {
  const baseline = taskEditorDraft(original);
  assert.deepEqual(taskEditorPatch(baseline, { ...baseline }, ['new-tag']), {});
});

test('clearing origin, date, and description survives JSON serialization', () => {
  const baseline = taskEditorDraft(original);
  const patch = taskEditorPatch(baseline, {
    ...baseline, origin: '  ', dueDate: '', description: '',
  }, original.tags);
  assert.deepEqual(JSON.parse(JSON.stringify(patch)), {
    origin: '', dueDate: null, description: '',
  });
});

test('editing visible tags preserves a concurrently changed blocked flag', () => {
  const baseline = taskEditorDraft(original);
  assert.deepEqual(taskEditorPatch(baseline, {
    ...baseline, tagsText: 'client, follow-up',
  }, ['client', 'blocked']), { tags: ['client', 'follow-up', 'blocked'] });
});

test('changing only blocked preserves concurrently added visible tags', () => {
  const baseline = taskEditorDraft(original);
  assert.deepEqual(taskEditorPatch(baseline, {
    ...baseline, blocked: true,
  }, ['client', 'new-tag']), { tags: ['client', 'new-tag', 'blocked'] });
});

test('an intentional column move includes only the column', () => {
  const baseline = taskEditorDraft(original);
  assert.deepEqual(taskEditorPatch(baseline, {
    ...baseline, columnId: 'later',
  }, original.tags), { columnId: 'later' });
});
