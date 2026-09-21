'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  hardDeleteTask,
  listArchivedTasks,
  restoreTask,
} from '@/lib/data/tasks';
import type { Task } from '@/lib/data/types';
import { emitDataChanged } from '@/lib/data/refresh-bus';

export default function RecentlyDeleted({ onClose }: { onClose: () => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busyId, setBusyId] = useState<string>();

  const reload = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setTasks(await listArchivedTasks());
    } catch {
      setError("Cove couldn't load Recently deleted.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function restore(id: string) {
    setBusyId(id);
    setError(undefined);
    try {
      await restoreTask(id);
      setTasks((current) => current.filter((task) => task.id !== id));
      emitDataChanged(['tasks']);
    } catch {
      setError("Cove couldn't restore that task.");
    } finally {
      setBusyId(undefined);
    }
  }

  async function permanentlyDelete(task: Task) {
    if (!confirm(`Permanently delete “${task.title}”? This cannot be undone.`)) {
      return;
    }
    setBusyId(task.id);
    setError(undefined);
    try {
      await hardDeleteTask(task.id);
      setTasks((current) => current.filter((item) => item.id !== task.id));
      emitDataChanged(['tasks']);
    } catch {
      setError("Cove couldn't permanently delete that task.");
    } finally {
      setBusyId(undefined);
    }
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex items-center gap-3 border-b px-5 pb-3 pt-[60px]">
        {/* Standing on its own beside the heading rather than inside a
            sentence, so the 24px WCAG 2.2 asks of a target applies. Measured
            at 63x16; the row is set by the taller heading block next to it,
            so the padding does not move anything. */}
        <button
          type="button"
          onClick={onClose}
          className="py-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          ← All Work
        </button>
        <div>
          <h2 className="text-sm font-semibold text-foreground">Recently deleted</h2>
          <p className="text-[12px] text-muted-foreground">
            Tasks stay here for 30 days.
          </p>
        </div>
      </div>
      {error && <p role="alert" className="px-5 pt-4 text-xs text-accent-red">{error}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : tasks.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            Nothing has been deleted recently.
          </div>
        ) : (
          <div className="mx-auto max-w-3xl divide-y rounded-lg border bg-card">
            {tasks.map((task) => (
              <article key={task.id} className="flex items-center gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-medium text-foreground">{task.title}</h3>
                  <p className="mt-0.5 text-[12px] text-muted-foreground">
                    Deleted {task.archived_at
                      ? new Date(task.archived_at).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                        })
                      : 'recently'}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busyId === task.id}
                  onClick={() => void restore(task.id)}
                  className="rounded-full border px-3 py-1.5 text-xs text-foreground disabled:opacity-50"
                >
                  Restore
                </button>
                <button
                  type="button"
                  disabled={busyId === task.id}
                  onClick={() => void permanentlyDelete(task)}
                  className="-my-1.5 py-1.5 text-[12px] text-accent-red hover:underline disabled:opacity-50"
                >
                  Delete forever
                </button>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
