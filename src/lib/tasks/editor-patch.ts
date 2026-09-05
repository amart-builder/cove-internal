import { isBlockedTag, tagsWithBlockedFlag, visibleTags } from './tags';

type EditableTask = {
  title: string;
  description?: string;
  priority: 'low' | 'medium' | 'high';
  dueDate?: string | null;
  origin?: string;
  tags: string[];
  columnId?: string;
  blocked: boolean;
};

export type TaskEditorDraft = {
  title: string;
  description: string;
  priority: EditableTask['priority'];
  dueDate: string;
  origin: string;
  tagsText: string;
  columnId?: string;
  blocked: boolean;
};

export function taskEditorDraft(task: EditableTask): TaskEditorDraft {
  return {
    title: task.title,
    description: task.description ?? '',
    priority: task.priority,
    dueDate: task.dueDate ?? '',
    origin: task.origin ?? '',
    tagsText: visibleTags(task.tags).join(', '),
    columnId: task.columnId,
    blocked: task.blocked || task.tags.some(isBlockedTag),
  };
}

// Compare with the editor-open snapshot, not refreshed props: background writes
// must neither erase typing nor turn untouched draft fields into stale writes.
// The caller also supplies an edit guard so same-field changes can be rejected
// atomically without blocking unrelated background changes.
export function taskEditorPatch(
  baseline: TaskEditorDraft,
  draft: TaskEditorDraft,
  latestTags: string[],
): Partial<EditableTask> {
  const patch: Partial<EditableTask> = {};
  if (draft.title !== baseline.title) patch.title = draft.title.trim();
  if (draft.description !== baseline.description) patch.description = draft.description;
  if (draft.priority !== baseline.priority) patch.priority = draft.priority;
  if (draft.dueDate !== baseline.dueDate) patch.dueDate = draft.dueDate || null;
  // Empty string is an explicit clear; undefined disappears from JSON patches.
  if (draft.origin !== baseline.origin) patch.origin = draft.origin.trim();
  if (draft.columnId !== baseline.columnId) patch.columnId = draft.columnId;
  const tagsChanged = draft.tagsText !== baseline.tagsText;
  const blockedChanged = draft.blocked !== baseline.blocked;
  if (tagsChanged || blockedChanged) {
    const tags = tagsChanged
      ? draft.tagsText.split(',').map((tag) => tag.trim()).filter(Boolean)
      : visibleTags(latestTags);
    const blocked = blockedChanged ? draft.blocked : latestTags.some(isBlockedTag);
    patch.tags = [...new Set(tagsWithBlockedFlag(tags, blocked))];
  }
  return patch;
}


export function taskEditorExpected(baseline: TaskEditorDraft, patch: Partial<EditableTask>, latestTags: string[]): Record<string, unknown> {
  const expected: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    if (key === 'tags') {
      const blocked = patch.tags?.some(isBlockedTag) !== latestTags.some(isBlockedTag) ? baseline.blocked : latestTags.some(isBlockedTag);
      const currentVisible = visibleTags(latestTags);
      const nextVisible = visibleTags(patch.tags ?? []);
      const originalVisible = baseline.tagsText.split(',').map(tag => tag.trim()).filter(Boolean);
      expected.tags = tagsWithBlockedFlag(JSON.stringify(nextVisible) === JSON.stringify(currentVisible) ? currentVisible : originalVisible, blocked);
    } else if (key !== 'blocked') expected[key] = baseline[key as keyof TaskEditorDraft] ?? '';
  }
  return expected;
}
