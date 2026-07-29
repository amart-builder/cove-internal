import { openLocalDatabase } from "../local/database";
import {
  createWorkSuggestion,
  getQuietCurrentSnapshot,
} from "../quiet-current/store";
import { taskColumnKeyForName } from "./columns";
import { readTaskSettings } from "./settings";

export type StaleTask = {
  id: string;
  title: string;
  column: "not-started" | "in-progress";
  ageDays: number;
  lastTouchedAt: string;
};

export function detectStaleTasks(input: {
  dbPath?: string;
  dataDir?: string;
  now?: Date;
  staleAfterDays?: number;
} = {}): StaleTask[] {
  const now = input.now ?? new Date();
  const staleAfterDays = Math.max(
    1,
    Math.trunc(
      input.staleAfterDays ?? readTaskSettings(input.dataDir).stale_after_days,
    ),
  );
  const db = openLocalDatabase(input.dbPath);
  try {
    const columns = new Map(
      (db.prepare(
        "SELECT id, name FROM task_columns ORDER BY position, id",
      ).all() as Array<{ id: string; name: string }>).map((column) => [
        column.id,
        taskColumnKeyForName(column.name),
      ]),
    );
    return (db.prepare(
      `SELECT id, column_id, title, created_at, updated_at
       FROM tasks
       WHERE status = 'open' AND archived_at IS NULL
       ORDER BY COALESCE(updated_at, created_at), id`,
    ).all() as Array<{
      id: string;
      column_id: string | null;
      title: string;
      created_at: string | null;
      updated_at: string | null;
    }>).flatMap((task) => {
      const column = task.column_id ? columns.get(task.column_id) : undefined;
      if (column !== "not-started" && column !== "in-progress") return [];
      const lastTouchedAt = task.updated_at ?? task.created_at;
      const touched = lastTouchedAt ? Date.parse(lastTouchedAt) : Number.NaN;
      if (!Number.isFinite(touched) || touched > now.getTime()) return [];
      const ageDays = Math.floor((now.getTime() - touched) / 86_400_000);
      if (ageDays < staleAfterDays) return [];
      return [{
        id: task.id,
        title: task.title,
        column,
        ageDays,
        lastTouchedAt: lastTouchedAt!,
      }];
    });
  } finally {
    db.close();
  }
}

export function fileStaleTaskSuggestions(input: {
  dbPath?: string;
  dataDir?: string;
  now?: Date;
  staleAfterDays?: number;
} = {}): { stale: StaleTask[]; suggested: number } {
  const stale = detectStaleTasks(input);
  const existingIds = new Set(
    getQuietCurrentSnapshot().suggestions.map((suggestion) => suggestion.id),
  );
  let suggested = 0;
  for (const task of stale) {
    const id = `stale-task:${task.id}:${task.lastTouchedAt}`;
    createWorkSuggestion({
      id,
      kind: "stale_task",
      title: `Still want “${task.title}”?`,
      description: `This task has not moved in ${task.ageDays} days.`,
      reason: "A quiet check before old work disappears from attention.",
      source: "stale-task-watchdog",
      priority: "low",
      targetTaskId: task.id,
    });
    if (!existingIds.has(id)) suggested += 1;
  }
  return { stale, suggested };
}
