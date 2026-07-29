import { forgeRest } from "../supabase/rest";
import { getRuntimeMode } from "../runtime/mode";
import type { Task, TaskColumn } from "./types";

const PROJECT_COLUMN_REPROBE_MS = 10 * 60_000;
let taskProjectColumnState: {
  available: boolean;
  checkedAt: number;
} | undefined;

function shouldWriteProject(): boolean {
  return !taskProjectColumnState ||
    taskProjectColumnState.available ||
    Date.now() - taskProjectColumnState.checkedAt >= PROJECT_COLUMN_REPROBE_MS;
}

function missingProjectColumn(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("project") && (
    message.includes("column") ||
    message.includes("schema cache") ||
    message.includes("pgrst204")
  );
}

export async function createTaskColumn(input: {
  name: string;
  position: number;
  is_default?: boolean;
}): Promise<TaskColumn> {
  const rows = await forgeRest<TaskColumn[]>("task_columns", {
    method: "POST",
    body: {
      name: input.name,
      position: input.position,
      is_default: input.is_default ?? true,
    },
  });
  return rows[0];
}

export async function listTaskColumns(): Promise<TaskColumn[]> {
  return forgeRest<TaskColumn[]>("task_columns", {
    requireAuth: true,
    query: { select: "*", order: "position.asc" },
  });
}

export async function listTasks(): Promise<Task[]> {
  return forgeRest<Task[]>("tasks", {
    requireAuth: true,
    query: {
      select: "*",
      ...(getRuntimeMode() === "local" ? { status: "neq.archived" } : {}),
      order: "position.asc",
    },
  });
}

export async function listArchivedTasks(): Promise<Task[]> {
  if (getRuntimeMode() !== "local") {
    throw new Error("Recently deleted is only available in local mode.");
  }
  const tasks = await forgeRest<Task[]>("tasks", {
    requireAuth: true,
    query: { select: "*", status: "eq.archived", order: "archived_at.desc" },
  });
  return tasks
    .map((task) => ({
      ...task,
      archived_at: task.archived_at ?? task.updated_at ?? null,
    }))
    .sort((a, b) =>
      String(b.archived_at ?? "").localeCompare(String(a.archived_at ?? ""))
    );
}

export async function createTask(input: {
  id?: string;
  column_id?: string | null;
  title: string;
  description?: string;
  priority?: "low" | "medium" | "high";
  due_at?: string | null;
  tags?: string[];
  project?: string;
  position?: number;
  source_type?: string;
}): Promise<Task> {
  const body = {
    ...(input.id ? { id: input.id } : {}),
    column_id: input.column_id ?? null,
    title: input.title,
    description: input.description ?? "",
    priority: input.priority ?? "medium",
    due_at: input.due_at ?? null,
    tags: input.tags ?? [],
    ...(input.project && shouldWriteProject()
      ? { project: input.project }
      : {}),
    position: input.position ?? 0,
    source_type: input.source_type ?? "manual",
  };
  try {
    const rows = await forgeRest<Task[]>("tasks", { method: "POST", body });
    if (input.project) {
      taskProjectColumnState = { available: true, checkedAt: Date.now() };
    }
    return rows[0];
  } catch (error) {
    if (!input.project || !missingProjectColumn(error)) throw error;
    taskProjectColumnState = { available: false, checkedAt: Date.now() };
    const { project: _project, ...compatibleBody } = body;
    void _project;
    const rows = await forgeRest<Task[]>("tasks", {
      method: "POST",
      body: compatibleBody,
    });
    return rows[0];
  }
}

export async function updateTask(id: string, patch: Partial<Task>): Promise<Task> {
  const rows = await forgeRest<Task[]>("tasks", {
    method: "PATCH",
    query: { id: `eq.${id}` },
    body: patch,
  });
  return rows[0];
}

export async function deleteTask(id: string): Promise<void> {
  if (getRuntimeMode() !== "local") {
    await forgeRest<undefined>("tasks", {
      method: "DELETE",
      query: { id: `eq.${id}` },
    });
    return;
  }
  const rows = await forgeRest<Task[]>("tasks", {
    requireAuth: true,
    query: { select: "*", id: `eq.${id}`, status: "neq.archived", limit: "1" },
  });
  const task = rows[0];
  if (!task) return;
  await forgeRest<Task[]>("tasks", {
    method: "PATCH",
    query: { id: `eq.${id}` },
    body: {
      status: "archived",
      archived_at: new Date().toISOString(),
      archived_from_status: task.status === "done" ? "done" : "open",
    },
  });
}

export async function restoreTask(id: string): Promise<Task> {
  if (getRuntimeMode() !== "local") {
    throw new Error("Archived task restore is only available in local mode.");
  }
  const archived = await forgeRest<Task[]>("tasks", {
    requireAuth: true,
    query: { select: "*", id: `eq.${id}`, status: "eq.archived", limit: "1" },
  });
  const task = archived[0];
  if (!task) throw new Error("Archived task not found.");
  const rows = await forgeRest<Task[]>("tasks", {
    method: "PATCH",
    query: { id: `eq.${id}` },
    body: {
      status: task.archived_from_status === "done" ? "done" : "open",
      archived_at: null,
      archived_from_status: null,
    },
  });
  if (!rows[0]) throw new Error("Archived task could not be restored.");
  return rows[0];
}

export async function hardDeleteTask(id: string): Promise<void> {
  if (getRuntimeMode() !== "local") {
    throw new Error("Recently deleted is only available in local mode.");
  }
  await forgeRest<undefined>("tasks", {
    method: "DELETE",
    query: { id: `eq.${id}`, status: "eq.archived" },
    headers: { "X-Cove-Hard-Delete": "recently-deleted" },
  });
}
