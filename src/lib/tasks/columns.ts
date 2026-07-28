export const TASK_COLUMNS = [
  {
    key: "not-started",
    name: "Not Started",
    aliases: ["Not Started", "To Do", "Backlog"],
    position: 0,
  },
  {
    key: "today",
    name: "Must happen today",
    aliases: ["Must happen today", "Needs to happen today", "Today"],
    position: 10,
  },
  {
    key: "in-progress",
    name: "In Flight / Waiting",
    aliases: ["In Flight / Waiting", "In Progress"],
    position: 20,
  },
  {
    key: "done",
    name: "Done",
    aliases: ["Done", "Completed"],
    position: 30,
  },
] as const;

export type TaskColumnKey = (typeof TASK_COLUMNS)[number]["key"];

export const LEGACY_BLOCKED_TASK_COLUMN_NAMES = new Set(["Blocked", "Waiting"]);

export function taskColumnKeyForName(
  name: string | undefined,
): TaskColumnKey | undefined {
  if (!name) return undefined;
  const column = TASK_COLUMNS.find((candidate) =>
    candidate.aliases.some((alias) => alias === name)
  );
  return column?.key;
}
