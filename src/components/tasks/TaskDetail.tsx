'use client';
import PlanningQuestion from './arrival/PlanningQuestion';

import { useEffect, useRef, useState } from 'react';
import { getRuntimeMode } from '@/lib/runtime/mode';
import type {
  LaunchTaskSessionInput,
  TaskSessionRun,
} from '@/lib/task-sessions/types';
import EmailCardDetail from './EmailCardDetail';
import ModalScrim from './arrival/ModalScrim';
import { TaskSessionLauncher } from './TaskSessionLauncher';
import { visibleTags } from '@/lib/tasks/tags';
import { taskEditError, type TaskEditGuard } from '@/lib/tasks/edit-conflict';
import { taskEditorDraft, taskEditorPatch, taskEditorExpected } from '@/lib/tasks/editor-patch';

interface ColumnData {
  _id: string;
  name: string;
  position: number;
}

interface TaskData {
  _id: string;
  columnId: string;
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high';
  dueDate?: string;
  tags: string[];
  origin?: string;
  status?: 'open' | 'done' | 'archived';
  proposedRecurrenceCadence?: string;
  recurringTemplateId?: string;
  occurrenceLocalDate?: string;
  blocked: boolean;
  position: number;
  createdAt: number;
  updatedAt: number;
}

type UpdateTaskInput = TaskEditGuard & {
  columnId?: string | null;
  title?: string;
  description?: string;
  origin?: string;
  priority?: 'low' | 'medium' | 'high';
  dueDate?: string | null;
  tags?: string[];
  position?: number;
  status?: 'open' | 'done' | 'archived';
};

interface TaskDetailProps {
  taskId: string;
  returnFocusId?: string;
  task: TaskData;
  columns: ColumnData[];
  onClose: () => void;
  onDeleted: (id: string) => void;
  onSaveTask: (patch: UpdateTaskInput) => Promise<void>;
  onDeleteTask: () => Promise<void>;
  onConfirmRecurrence?: (cadence: string) => Promise<void>;
  sessionRun?: TaskSessionRun;
  sessionBusy?: boolean;
  sessionError?: string;
  onLaunchSession?: (input: LaunchTaskSessionInput) => void | Promise<unknown>;
}

function formatTimestamp(epoch: number): string {
  return new Date(epoch).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function TaskDetail({
  taskId,
  returnFocusId,
  task,
  columns,
  onClose,
  onDeleted,
  onSaveTask,
  onDeleteTask,
  onConfirmRecurrence,
  sessionRun,
  sessionBusy,
  sessionError,
  onLaunchSession,
}: TaskDetailProps) {
  const [returnFocus] = useState<HTMLElement | null>(() => typeof document === 'undefined' ? null : (returnFocusId ? document.getElementById(returnFocusId) : null) ?? document.activeElement as HTMLElement);
  const baselineRef = useRef(taskEditorDraft(task));
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? '');
  const [origin, setOrigin] = useState(task.origin ?? '');
  const [priority, setPriority] = useState(task.priority);
  const [dueDate, setDueDate] = useState(task.dueDate ?? '');
  const [tagsStr, setTagsStr] = useState(visibleTags(task.tags).join(', '));
  const [columnId, setColumnId] = useState(task.columnId);
  const [blocked, setBlocked] = useState(() => taskEditorDraft(task).blocked);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [confirmingRecurrence, setConfirmingRecurrence] = useState(false);
  const localMode = getRuntimeMode() === 'local';


  // Re-seed the draft fields only when a different task is opened.
  //
  // Depending on `task` instead of `taskId` loses the operator's typing: every
  // board reload builds fresh task objects, so the identity changes even when
  // nothing about this task did, and each Buddy write triggers exactly that
  // reload through the refresh bus. Someone mid-sentence in the description
  // would watch it revert.
  useEffect(() => {
    baselineRef.current = taskEditorDraft(task);
    setTitle(task.title);
    setDescription(task.description ?? '');
    setOrigin(task.origin ?? '');
    setPriority(task.priority);
    setDueDate(task.dueDate ?? '');
    setTagsStr(visibleTags(task.tags).join(', '));
    setColumnId(task.columnId);
    setBlocked(taskEditorDraft(task).blocked);
  }, [taskId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    setSaving(true);
    setActionError(undefined);
    try {
      const patch = taskEditorPatch(baselineRef.current, {
        title,
        description,
        priority,
        dueDate,
        origin,
        tagsText: tagsStr,
        columnId,
        blocked,
      }, task.tags);
      if (Object.keys(patch).length > 0) await onSaveTask({ ...patch, _expected: taskEditorExpected(baselineRef.current, patch, task.tags) });

      onClose();
    } catch (error) {
      setActionError(taskEditError(error));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!localMode && !window.confirm('Delete this task? This cannot be undone.')) {
      return;
    }
    setActionError(undefined);
    try {
      await onDeleteTask();
      onDeleted(taskId);
    } catch {
      setActionError(
        localMode
          ? "Cove couldn't move that task to Recently deleted. Refresh All Work to check it, then try again."
          : "Cove couldn't delete that task. Refresh All Work to check it, then try again.",
      );
    }
  }

  async function handleConfirmRecurrence() {
    if (!task.proposedRecurrenceCadence || !onConfirmRecurrence) return;
    setConfirmingRecurrence(true);
    setActionError(undefined);
    try {
      await onConfirmRecurrence(task.proposedRecurrenceCadence);
    } catch {
      setActionError("Cove couldn't make that rhythm. The task is unchanged.");
    } finally {
      setConfirmingRecurrence(false);
    }
  }

  function recurrenceLabel(cadence: string): string {
    if (cadence === 'daily') return 'daily';
    if (cadence === 'weekdays') return 'weekday';
    if (cadence.startsWith('weekly:')) return `weekly on ${cadence.slice(7)}`;
    if (cadence.startsWith('monthly:')) return `monthly on day ${cadence.slice(8)}`;
    return cadence;
  }

  // Only the stable rolling card renders live email. Historical daily cards and
  // older per-email tasks remain ordinary task records.
  const isEmailCard = task.tags.includes('email-current');

  if (isEmailCard) {
    return (
      <ModalScrim labelledBy="email-review-title" returnFocus={returnFocus} onClose={onClose} panelClassName="email-review-panel">
        <header className="email-review-header">
          <div><h2 id="email-review-title">Email needs you</h2><p>Read here. Reply in Gmail.</p></div>
          <button type="button" data-modal-initial-focus aria-label="Close email" onClick={onClose}>&times;</button>
        </header>
        <EmailCardDetail onClose={onClose} />
      </ModalScrim>
    );
  }

  return (
    <ModalScrim labelledBy="task-detail-title" returnFocus={returnFocus} onClose={onClose}
      panelClassName="bg-card rounded-lg border w-full max-w-lg p-5 max-h-[90vh] overflow-y-auto transition-colors duration-200">
        <div className="flex items-start justify-between mb-4">
          <h2 id="task-detail-title" className="text-sm font-semibold">Edit Task</h2>
          <button
            type="button" data-modal-initial-focus aria-label="Close task"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-lg leading-none"
          >
            &times;
          </button>
        </div>

        <div className="space-y-3">
          {localMode && task.proposedRecurrenceCadence && !task.recurringTemplateId && (
            <div className="rounded-md border border-accent-blue/20 bg-accent-blue/5 px-3 py-2.5">
              <p className="text-xs font-medium text-foreground">
                Make this a {recurrenceLabel(task.proposedRecurrenceCadence)} rhythm?
              </p>
              <p className="mt-1 text-[13.5px] leading-[1.55] text-muted-foreground">
                Cove created only today&apos;s task. This starts future copies.
              </p>
              <button
                type="button"
                disabled={confirmingRecurrence}
                onClick={() => void handleConfirmRecurrence()}
                className="mt-2 rounded-full border border-accent-blue/30 px-2.5 py-1 text-[12px] font-medium text-accent-blue disabled:opacity-50"
              >
                {confirmingRecurrence ? 'Making rhythm…' : 'Make rhythm'}
              </button>
            </div>
          )}
          <div>
            <label htmlFor="task-detail-title-field" className="mb-1 block text-[10.5px] font-[650] uppercase tracking-[.24em] text-muted-foreground">Title</label>
            <input
              id="task-detail-title-field"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-2.5 py-2 text-sm border rounded-md outline-none focus:ring-1 focus:ring-accent-blue/40 bg-background text-foreground"
            />
          </div>

          <div>
            <label htmlFor="task-detail-description" className="mb-1 block text-[10.5px] font-[650] uppercase tracking-[.24em] text-muted-foreground">Description</label>
            <textarea
              id="task-detail-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              className="w-full px-2.5 py-2 text-sm border rounded-md outline-none focus:ring-1 focus:ring-accent-blue/40 resize-y bg-background text-foreground"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="task-detail-priority" className="mb-1 block text-[10.5px] font-[650] uppercase tracking-[.24em] text-muted-foreground">Priority</label>
              <select
                id="task-detail-priority"
                value={priority}
                onChange={(e) =>
                  setPriority(e.target.value as 'low' | 'medium' | 'high')
                }
                className="w-full px-2.5 py-2 text-sm border rounded-md outline-none focus:ring-1 focus:ring-accent-blue/40 bg-background text-foreground"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <div>
              <label htmlFor="task-detail-status" className="mb-1 block text-[10.5px] font-[650] uppercase tracking-[.24em] text-muted-foreground">Status</label>
              <select
                id="task-detail-status"
                value={columnId}
                onChange={(e) => setColumnId(e.target.value)}
                className="w-full px-2.5 py-2 text-sm border rounded-md outline-none focus:ring-1 focus:ring-accent-blue/40 bg-background text-foreground"
              >
                {columns.map((col) => (
                  <option key={col._id} value={col._id}>
                    {col.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="task-detail-due" className="mb-1 block text-[10.5px] font-[650] uppercase tracking-[.24em] text-muted-foreground">Due Date</label>
            <input
              id="task-detail-due"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full px-2.5 py-2 text-sm border rounded-md outline-none focus:ring-1 focus:ring-accent-blue/40 bg-background text-foreground"
            />
          </div>

          <label className="flex items-center gap-2 rounded-md border bg-background px-2.5 py-2 text-sm">
            <input
              type="checkbox"
              checked={blocked}
              onChange={(e) => setBlocked(e.target.checked)}
              className="h-4 w-4 accent-[var(--accent-orange)]"
            />
            <span className="text-foreground">Blocked</span>
          </label>

          <div>
            <label htmlFor="task-detail-origin" className="mb-1 block text-[10.5px] font-[650] uppercase tracking-[.24em] text-muted-foreground">Reason this task was added</label>
            <textarea
              id="task-detail-origin"
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              rows={3}
              placeholder="Where this came from: who asked, where, when, and their words."
              className="w-full px-2.5 py-2 text-sm border rounded-md outline-none focus:ring-1 focus:ring-accent-blue/40 resize-y bg-background text-foreground"
            />
          </div>

          <div>
            <label htmlFor="task-detail-tags" className="mb-1 block text-[10.5px] font-[650] uppercase tracking-[.24em] text-muted-foreground">Tags (comma-separated)</label>
            <input
              id="task-detail-tags"
              type="text"
              value={tagsStr}
              onChange={(e) => setTagsStr(e.target.value)}
              placeholder="design, frontend, urgent"
              className="w-full px-2.5 py-2 text-sm border rounded-md outline-none focus:ring-1 focus:ring-accent-blue/40 bg-background text-foreground"
            />
          </div>

          <div className="flex gap-4 pt-1 text-[12px] font-medium text-muted-foreground">
            <span>Created: {formatTimestamp(task.createdAt)}</span>
            <span>Updated: {formatTimestamp(task.updatedAt)}</span>
          </div>
        </div>

        {localMode && onLaunchSession && (
          <section className="mt-3 rounded-xl border bg-muted/40 p-3" aria-label="Agent session">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-xs font-medium text-foreground">Agent session</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Start this task with your agent, or open its latest session.
                </p>
              </div>
              <TaskSessionLauncher
                input={{
                  taskId: task._id,
                  promptSnapshot: {
                    title: task.title,
                    detail: task.description || task.title,
                    dueAt: task.dueDate,
                  },
                }}
                run={sessionRun}
                busy={sessionBusy}
                onLaunch={onLaunchSession}
              />
            </div>
            {sessionError && (
              <p role="alert" className="mt-2 text-xs text-accent-red">{sessionError}</p>
            )}
          </section>
        )}

        {localMode && <PlanningQuestion key={task._id} taskId={task._id} />}

        {actionError && (
          <p role="alert" className="mt-4 text-xs text-accent-red">
            {actionError}
          </p>
        )}

        <div className="flex items-center justify-between mt-5 pt-3 border-t">
          <button
            onClick={handleDelete}
            className="text-[12px] font-medium text-accent-red hover:underline"
          >
            Delete task
          </button>
          <div className="flex gap-1.5">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors duration-150"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !title.trim()}
              className="px-3 py-1.5 text-xs font-medium bg-accent-blue text-white rounded-md hover:opacity-90 transition-opacity duration-150 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
    </ModalScrim>
  );
}
