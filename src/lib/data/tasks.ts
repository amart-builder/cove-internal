import { forgeRest } from "../supabase/rest";
import type { Task, TaskColumn } from "./types";

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
    query: { select: "*", order: "position.asc" },
  });
}

export async function createTask(input: {
  id?: string;
  column_id?: string | null;
  title: string;
  description?: string;
  priority?: "low" | "medium" | "high";
  due_at?: string | null;
  tags?: string[];
  position?: number;
  source_type?: string;
}): Promise<Task> {
  const rows = await forgeRest<Task[]>("tasks", {
    method: "POST",
    body: {
      ...(input.id ? { id: input.id } : {}),
      column_id: input.column_id ?? null,
      title: input.title,
      description: input.description ?? "",
      priority: input.priority ?? "medium",
      due_at: input.due_at ?? null,
      tags: input.tags ?? [],
      position: input.position ?? 0,
      source_type: input.source_type ?? "manual",
    },
  });
  return rows[0];
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
  await forgeRest<undefined>("tasks", {
    method: "DELETE",
    query: { id: `eq.${id}` },
  });
}
