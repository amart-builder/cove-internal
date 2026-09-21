'use client';

import { useState } from 'react';
import type { ArrivalTask } from '@/lib/quiet-current/arrival-cache';
import { visibleTags } from '@/lib/tasks/tags';
import { type TaskEditGuard } from '@/lib/tasks/edit-conflict';
import { taskEditorDraft, taskEditorPatch, taskEditorExpected } from '@/lib/tasks/editor-patch';

export type Task = Omit<ArrivalTask, 'dueDate'> & TaskEditGuard & {
  dueDate?: string | null;
};

export default function TaskFieldsEditor({
  task,
  saving = false,
  error,
  onSave,
  onCancel,
}: {
  task: Task;
  saving?: boolean;
  error?: string;
  onSave: (patch: Partial<Task>) => Promise<void>;
  onCancel: () => void;
}) {
  // One editor is open at a time: a settlement row or an arrival sheet, never
  // both, so a fixed prefix is enough to tie each label to its field.
  const fieldId = 'task-fields';
  const [baseline] = useState(() => taskEditorDraft(task));
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? '');
  const [priority, setPriority] = useState(task.priority);
  const [dueDate, setDueDate] = useState(task.dueDate ?? '');
  const [tagsText, setTagsText] = useState(visibleTags(task.tags).join(', '));
  const [origin, setOrigin] = useState(task.origin ?? '');

  async function save() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle || saving) return;
    const patch = taskEditorPatch(baseline, {
      ...baseline,
      title,
      description,
      priority,
      dueDate,
      origin,
      tagsText,
    }, task.tags);
    if (Object.keys(patch).length === 0) {
      onCancel();
      return;
    }
    await onSave({ ...patch, _expected: taskEditorExpected(baseline, patch, task.tags) });
  }

  const fieldClass = 'min-h-11 w-full rounded-xl border bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-accent-blue/40 disabled:opacity-50';

  return (
    <div className="mt-5 space-y-3 border-t pt-5">
      <div>
        <label htmlFor={`${fieldId}-title`} className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Title
        </label>
        <input
          type="text"
          id={`${fieldId}-title`}
          value={title}
          disabled={saving}
          onChange={(event) => setTitle(event.target.value)}
          className={fieldClass}
        />
      </div>
      <div>
        <label htmlFor={`${fieldId}-description`} className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Description
        </label>
        <textarea
          id={`${fieldId}-description`}
          value={description}
          rows={4}
          disabled={saving}
          onChange={(event) => setDescription(event.target.value)}
          className={`${fieldClass} resize-y py-3`}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${fieldId}-priority`} className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Priority
          </label>
          <select
            id={`${fieldId}-priority`}
            value={priority}
            disabled={saving}
            onChange={(event) => setPriority(event.target.value as Task['priority'])}
            className={fieldClass}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
        <div>
          <label htmlFor={`${fieldId}-due`} className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Due date
          </label>
          <input
            type="date"
            id={`${fieldId}-due`}
            value={dueDate}
            disabled={saving}
            onChange={(event) => setDueDate(event.target.value)}
            className={fieldClass}
          />
        </div>
      </div>
      <div>
        <label htmlFor={`${fieldId}-tags`} className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Tags (comma-separated)
        </label>
        <input
          type="text"
          id={`${fieldId}-tags`}
          value={tagsText}
          disabled={saving}
          onChange={(event) => setTagsText(event.target.value)}
          className={fieldClass}
        />
      </div>
      <div>
        <label htmlFor={`${fieldId}-origin`} className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
          Reason this task was added
        </label>
        <textarea
          id={`${fieldId}-origin`}
          value={origin}
          rows={3}
          disabled={saving}
          placeholder="Where this came from: who asked, where, when, and their words."
          onChange={(event) => setOrigin(event.target.value)}
          className={`${fieldClass} resize-y py-3`}
        />
      </div>
      {error && <p role="alert" className="text-xs text-accent-red">{error}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          disabled={saving}
          onClick={onCancel}
          className="min-h-11 rounded-xl px-4 text-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-accent-blue/40 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={saving || !title.trim()}
          onClick={() => void save()}
          className="min-h-11 rounded-xl bg-foreground px-4 text-sm font-medium text-background outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent-blue/40 disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}
