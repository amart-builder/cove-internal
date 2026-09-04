/**
 * Deterministic recurring-task calendar and occurrence lifecycle.
 *
 * A model or parser may recognize recurrence language, but only a confirmed
 * template creates future occurrences. Template ID plus operator-local date is
 * the dedupe boundary. Misses expire instead of accumulating stale daily tasks,
 * while occurrence history remains available to the Morning Brief.
 */
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { localDateInTimezone } from "../day-plan/brief";
import { openLocalDatabase } from "../local/database";
import { operatorTimezone } from "../operator";
import { taskColumnKeyForName } from "./columns";
import { originDate } from "./origin";

const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

type DayName = typeof DAY_NAMES[number];
export type RecurrenceCadence =
  | "daily"
  | "weekdays"
  | `weekly:${DayName}`
  | `monthly:${number}`;

export type RecurringTemplate = {
  id: string;
  title: string;
  description: string | null;
  cadence: RecurrenceCadence;
  active: boolean;
  pausedUntil: string | null;
  lastSpawnedLocalDate: string | null;
  currentStreak: number;
  lastMissedLocalDate: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RecurringRhythm = {
  templateId: string;
  title: string;
  cadence: RecurrenceCadence;
  currentStreak: number;
  recentMisses: string[];
};

type TemplateRow = {
  id: string;
  title: string;
  description: string | null;
  cadence: string;
  active: number;
  paused_until: string | null;
  last_spawned_local_date: string | null;
  current_streak: number;
  last_missed_local_date: string | null;
  created_at: string;
  updated_at: string;
};

type OccurrenceState = "open" | "completed" | "missed";
type OccurrenceRow = {
  occurrence_local_date: string;
  state: OccurrenceState;
};

function decodeTemplate(row: TemplateRow): RecurringTemplate {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    cadence: normalizeCadence(row.cadence),
    active: row.active === 1,
    pausedUntil: row.paused_until,
    lastSpawnedLocalDate: row.last_spawned_local_date,
    currentStreak: row.current_streak,
    lastMissedLocalDate: row.last_missed_local_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function normalizeCadence(value: string): RecurrenceCadence {
  const normalized = value.trim().toLowerCase();
  if (normalized === "daily" || normalized === "weekdays") return normalized;
  const weekly = /^weekly:(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/
    .exec(normalized);
  if (weekly) return `weekly:${weekly[1] as DayName}`;
  const monthly = /^monthly:(\d{1,2})$/.exec(normalized);
  const day = Number(monthly?.[1]);
  if (monthly && Number.isInteger(day) && day >= 1 && day <= 31) {
    return `monthly:${day}`;
  }
  throw new Error("Recurrence cadence must be daily, weekdays, weekly:<day>, or monthly:<day>.");
}

function dateParts(localDate: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) throw new Error("Recurrence local date is invalid.");
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  const roundTrip = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, 12),
  ).toISOString().slice(0, 10);
  if (roundTrip !== localDate) throw new Error("Recurrence local date is invalid.");
  return parts;
}

function addCalendarDays(localDate: string, days: number): string {
  const value = dateParts(localDate);
  return new Date(
    Date.UTC(value.year, value.month - 1, value.day + days, 12),
  ).toISOString().slice(0, 10);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0, 12)).getUTCDate();
}

// Plain words for the origin box. Mirrors the label the task detail view shows.
function cadenceLabel(cadenceValue: string): string {
  const cadence = normalizeCadence(cadenceValue);
  if (cadence === "daily") return "daily";
  if (cadence === "weekdays") return "every weekday";
  if (cadence.startsWith("weekly:")) {
    const day = cadence.slice("weekly:".length);
    return `weekly on ${day.charAt(0).toUpperCase()}${day.slice(1)}`;
  }
  return `monthly on day ${cadence.slice("monthly:".length)}`;
}

// "Sep 4, 2026" for a YYYY-MM-DD operator-local date.
function calendarDateLabel(localDate: string): string {
  return originDate(`${localDate}T00:00:00Z`, "UTC");
}

export function cadenceOccursOn(
  cadenceValue: string,
  localDate: string,
): boolean {
  const cadence = normalizeCadence(cadenceValue);
  const parts = dateParts(localDate);
  const weekday = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, 12),
  ).getUTCDay();
  if (cadence === "daily") return true;
  if (cadence === "weekdays") return weekday >= 1 && weekday <= 5;
  if (cadence.startsWith("weekly:")) {
    return DAY_NAMES[weekday] === cadence.slice("weekly:".length);
  }
  const requestedDay = Number(cadence.slice("monthly:".length));
  return parts.day === Math.min(
    requestedDay,
    daysInMonth(parts.year, parts.month),
  );
}

export function detectRecurrenceIntent(
  text: string,
): RecurrenceCadence | undefined {
  const normalized = text.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ");
  if (/\b(?:every|each)\s+day\b|\bdaily\b/.test(normalized)) return "daily";
  if (/\b(?:every|each)\s+weekday\b|\bweekdays\b/.test(normalized)) {
    return "weekdays";
  }
  for (const day of DAY_NAMES) {
    if (new RegExp(`\\b(?:every|each)\\s+${day}\\b`).test(normalized)) {
      return `weekly:${day}`;
    }
  }
  const monthly = /\b(?:every|each)\s+month(?:\s+on\s+the)?\s+(\d{1,2})(?:st|nd|rd|th)?\b/
    .exec(normalized);
  const monthlyDay = Number(monthly?.[1]);
  if (monthly && monthlyDay >= 1 && monthlyDay <= 31) {
    return `monthly:${monthlyDay}`;
  }
  return undefined;
}

function todayColumnId(db: Database.Database): string {
  const rows = db.prepare(
    "SELECT id, name FROM task_columns ORDER BY position, id",
  ).all() as Array<{ id: string; name: string }>;
  const column = rows.find((row) => taskColumnKeyForName(row.name) === "today");
  if (!column) throw new Error("The Must happen today task column is missing.");
  return column.id;
}

function dueAt(localDate: string): string {
  return localDate;
}

function dateRangeAfter(
  lastDate: string | null,
  targetDate: string,
  createdAt: string,
  timezone: string,
): string[] {
  const start = lastDate ??
    addCalendarDays(localDateInTimezone(new Date(createdAt), timezone), -1);
  if (start >= targetDate) return [];
  const dates: string[] = [];
  let cursor = addCalendarDays(start, 1);
  while (cursor <= targetDate && dates.length < 400) {
    dates.push(cursor);
    cursor = addCalendarDays(cursor, 1);
  }
  if (cursor <= targetDate) {
    throw new Error("Recurrence catch-up exceeded 400 local days.");
  }
  return dates;
}

function recordRecurrenceTimezone(
  db: Database.Database,
  timezone: string,
  localDate: string,
  nowIso: string,
): void {
  const state = db.prepare(
    `SELECT timezone, local_date, timezone_hold_local_date
     FROM recurrence_runtime_state WHERE id = 1`,
  ).get() as {
    timezone: string;
    local_date: string;
    timezone_hold_local_date: string | null;
  } | undefined;
  if (!state) {
    db.prepare(
      `INSERT INTO recurrence_runtime_state
         (id, timezone, local_date, timezone_hold_local_date, updated_at)
       VALUES (1, ?, ?, NULL, ?)`,
    ).run(timezone, localDate, nowIso);
    return;
  }
  db.prepare(
    `UPDATE recurrence_runtime_state
     SET timezone = ?, local_date = ?, timezone_hold_local_date = NULL,
         updated_at = ?
     WHERE id = 1`,
  ).run(timezone, localDate, nowIso);
}

function recomputeTemplateStreak(
  db: Database.Database,
  template: TemplateRow,
  throughLocalDate: string,
  nowIso: string,
  persist = true,
): RecurringRhythm {
  const occurrences = db.prepare(
    `SELECT occurrence_local_date, state
     FROM recurring_occurrences
     WHERE template_id = ? AND occurrence_local_date <= ?
     ORDER BY occurrence_local_date DESC`,
  ).all(template.id, throughLocalDate) as OccurrenceRow[];
  let currentStreak = 0;
  for (const occurrence of occurrences) {
    if (
      occurrence.occurrence_local_date === throughLocalDate &&
      occurrence.state === "open"
    ) {
      continue;
    }
    if (occurrence.state === "completed") {
      currentStreak += 1;
      continue;
    }
    break;
  }
  const recentMisses = occurrences
    .filter((occurrence) =>
      occurrence.state === "missed"
    )
    .map((occurrence) => occurrence.occurrence_local_date)
    .slice(0, 5);
  if (persist) {
    db.prepare(
      `UPDATE recurring_templates
       SET current_streak = ?, last_missed_local_date = ?, updated_at = ?
       WHERE id = ?`,
    ).run(currentStreak, recentMisses[0] ?? null, nowIso, template.id);
  }
  return {
    templateId: template.id,
    title: template.title,
    cadence: normalizeCadence(template.cadence),
    currentStreak,
    recentMisses,
  };
}

export function spawnRecurringTasks(input: {
  dbPath?: string;
  now?: Date;
  timezone?: string;
  localDate?: string;
} = {}): { spawned: number; missed: number; localDate: string } {
  const now = input.now ?? new Date();
  const timezone = input.timezone ?? operatorTimezone();
  const localDate = input.localDate ?? localDateInTimezone(now, timezone);
  const nowIso = now.toISOString();
  const db = openLocalDatabase(input.dbPath);
  try {
    return db.transaction(() => {
      recordRecurrenceTimezone(db, timezone, localDate, nowIso);
      db.prepare(
        `UPDATE recurring_occurrences
         SET state = 'completed', completed_at = COALESCE(completed_at, ?),
             missed_at = NULL, updated_at = ?
         WHERE occurrence_local_date < ? AND state = 'open'
           AND task_id IN (SELECT id FROM tasks WHERE status = 'done')`,
      ).run(nowIso, nowIso, localDate);
      const pastOpen = db.prepare(
        `SELECT template_id, task_id
         FROM recurring_occurrences
         WHERE occurrence_local_date < ? AND state = 'open'`,
      ).all(localDate) as Array<{
        template_id: string;
        task_id: string | null;
      }>;
      db.prepare(
        `UPDATE recurring_occurrences
         SET state = 'missed', missed_at = ?, completed_at = NULL, updated_at = ?
         WHERE occurrence_local_date < ? AND state = 'open'`,
      ).run(nowIso, nowIso, localDate);
      const archivePastTask = db.prepare(
        `UPDATE tasks
         SET archived_from_status = COALESCE(archived_from_status, status),
             status = 'archived', archived_at = COALESCE(archived_at, ?),
             updated_at = ?
         WHERE id = ? AND status != 'done' AND status != 'archived'`,
      );
      for (const occurrence of pastOpen) {
        if (occurrence.task_id) {
          archivePastTask.run(nowIso, nowIso, occurrence.task_id);
        }
      }
      const templates = db.prepare(
        "SELECT * FROM recurring_templates WHERE active = 1 ORDER BY created_at, id",
      ).all() as TemplateRow[];
      const insertOccurrence = db.prepare(
        `INSERT OR IGNORE INTO recurring_occurrences
           (id, template_id, occurrence_local_date, task_id, state,
            completed_at, missed_at, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, NULL, ?, ?, ?)`,
      );
      const attachTask = db.prepare(
        "UPDATE recurring_occurrences SET task_id = ?, updated_at = ? WHERE template_id = ? AND occurrence_local_date = ?",
      );
      const insertTask = db.prepare(
        `INSERT INTO tasks
           (id, column_id, title, description, priority, due_at, due_date,
            tags, project, position, status, source_type, remind_native,
            remind_text, origin, created_at, updated_at, recurring_template_id,
            occurrence_local_date)
         VALUES (?, ?, ?, ?, 'medium', ?, ?, '["recurring"]', 'Atlas', 0,
                 'open', 'recurring', 1, 0, ?, ?, ?, ?, ?)`,
      );
      let spawned = 0;
      let missed = pastOpen.length;
      const targetColumnId = todayColumnId(db);
      for (const template of templates) {
        const dates = dateRangeAfter(
          template.last_spawned_local_date,
          localDate,
          template.created_at,
          timezone,
        );
        for (const date of dates) {
          if (template.paused_until && date <= template.paused_until) continue;
          if (!cadenceOccursOn(template.cadence, date)) continue;
          const state: OccurrenceState = date < localDate ? "missed" : "open";
          const inserted = insertOccurrence.run(
            randomUUID(),
            template.id,
            date,
            state,
            state === "missed" ? nowIso : null,
            nowIso,
            nowIso,
          );
          if (inserted.changes !== 1) continue;
          if (state === "missed") {
            missed += 1;
            continue;
          }
          const taskId = randomUUID();
          insertTask.run(
            taskId,
            targetColumnId,
            template.title,
            template.description ?? "",
            dueAt(date),
            date,
            `Recurring task. Cove created it from your "${template.title}" rhythm (${cadenceLabel(template.cadence)}) for ${calendarDateLabel(date)}.`,
            nowIso,
            nowIso,
            template.id,
            date,
          );
          attachTask.run(taskId, nowIso, template.id, date);
          spawned += 1;
        }
        db.prepare(
          `UPDATE recurring_templates
           SET last_spawned_local_date = ?, updated_at = ?
           WHERE id = ?`,
        ).run(localDate, nowIso, template.id);
        recomputeTemplateStreak(db, template, localDate, nowIso);
      }
      return { spawned, missed, localDate };
    }).immediate();
  } finally {
    db.close();
  }
}

export function createRecurringTemplate(input: {
  title: string;
  description?: string;
  cadence: string;
  dbPath?: string;
  now?: Date;
  timezone?: string;
  spawnToday?: boolean;
}): RecurringTemplate {
  const title = input.title.replace(/\s+/g, " ").trim();
  if (!title || title.length > 240) throw new Error("Template title is required.");
  const description = input.description?.trim() || null;
  if (description && description.length > 4000) {
    throw new Error("Template description is too long.");
  }
  const cadence = normalizeCadence(input.cadence);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const id = randomUUID();
  const db = openLocalDatabase(input.dbPath);
  try {
    db.prepare(
      `INSERT INTO recurring_templates
         (id, title, description, cadence, active, paused_until,
          last_spawned_local_date, current_streak, last_missed_local_date,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, NULL, NULL, 0, NULL, ?, ?)`,
    ).run(id, title, description, cadence, nowIso, nowIso);
  } finally {
    db.close();
  }
  if (input.spawnToday !== false) {
    spawnRecurringTasks({
      dbPath: input.dbPath,
      now,
      timezone: input.timezone,
    });
  }
  return getRecurringTemplate(id, input.dbPath)!;
}

export function confirmTaskRecurrence(input: {
  taskId: string;
  cadence?: string;
  dbPath?: string;
  now?: Date;
  timezone?: string;
}): RecurringTemplate {
  const now = input.now ?? new Date();
  const timezone = input.timezone ?? operatorTimezone();
  const localDate = localDateInTimezone(now, timezone);
  const nowIso = now.toISOString();
  const db = openLocalDatabase(input.dbPath);
  try {
    const templateId = db.transaction(() => {
      const task = db.prepare(
        `SELECT id, title, description, tags, status, proposed_recurrence_cadence,
                recurring_template_id
         FROM tasks WHERE id = ?`,
      ).get(input.taskId) as {
        id: string;
        title: string;
        description: string | null;
        tags: string | null;
        status: string | null;
        proposed_recurrence_cadence: string | null;
        recurring_template_id: string | null;
      } | undefined;
      if (!task) throw new Error("Task not found.");
      if (task.recurring_template_id) return task.recurring_template_id;
      const cadence = normalizeCadence(
        input.cadence ?? task.proposed_recurrence_cadence ?? "",
      );
      const id = randomUUID();
      db.prepare(
        `INSERT INTO recurring_templates
           (id, title, description, cadence, active, paused_until,
            last_spawned_local_date, current_streak, last_missed_local_date,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, NULL, ?, 0, NULL, ?, ?)`,
      ).run(
        id,
        task.title,
        task.description,
        cadence,
        localDate,
        nowIso,
        nowIso,
      );
      const occurrenceState: OccurrenceState = task.status === "done"
        ? "completed"
        : "open";
      db.prepare(
        `INSERT INTO recurring_occurrences
           (id, template_id, occurrence_local_date, task_id, state,
            completed_at, missed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).run(
        randomUUID(),
        id,
        localDate,
        task.id,
        occurrenceState,
        occurrenceState === "completed" ? nowIso : null,
        nowIso,
        nowIso,
      );
      let tags: string[] = [];
      try {
        const parsed = JSON.parse(task.tags ?? "[]") as unknown;
        if (Array.isArray(parsed)) {
          tags = parsed.filter((tag): tag is string => typeof tag === "string");
        }
      } catch {
        tags = [];
      }
      tags = tags.filter((tag) => tag !== "recurrence-proposed");
      if (!tags.some((tag) => tag.toLowerCase() === "recurring")) {
        tags.push("recurring");
      }
      db.prepare(
        `UPDATE tasks
         SET tags = ?, proposed_recurrence_cadence = NULL,
             recurring_template_id = ?, occurrence_local_date = ?,
             updated_at = ?
         WHERE id = ?`,
      ).run(JSON.stringify(tags), id, localDate, nowIso, task.id);
      const row = db.prepare(
        "SELECT * FROM recurring_templates WHERE id = ?",
      ).get(id) as TemplateRow;
      recomputeTemplateStreak(db, row, localDate, nowIso);
      return id;
    }).immediate();
    return decodeTemplate(
      db.prepare("SELECT * FROM recurring_templates WHERE id = ?")
        .get(templateId) as TemplateRow,
    );
  } finally {
    db.close();
  }
}

export function getRecurringTemplate(
  id: string,
  dbPath?: string,
): RecurringTemplate | undefined {
  const db = openLocalDatabase(dbPath);
  try {
    const row = db.prepare(
      "SELECT * FROM recurring_templates WHERE id = ?",
    ).get(id) as TemplateRow | undefined;
    return row ? decodeTemplate(row) : undefined;
  } finally {
    db.close();
  }
}

export function listRecurringTemplates(dbPath?: string): RecurringTemplate[] {
  const db = openLocalDatabase(dbPath);
  try {
    return (db.prepare(
      "SELECT * FROM recurring_templates ORDER BY active DESC, created_at, id",
    ).all() as TemplateRow[]).map(decodeTemplate);
  } finally {
    db.close();
  }
}

export function updateRecurringTemplate(input: {
  id: string;
  cadence?: string;
  pausedUntil?: string | null;
  active?: boolean;
  dbPath?: string;
  now?: Date;
  timezone?: string;
}): RecurringTemplate {
  const patch: string[] = [];
  const values: unknown[] = [];
  if (input.cadence !== undefined) {
    patch.push("cadence = ?");
    values.push(normalizeCadence(input.cadence));
  }
  if (input.pausedUntil !== undefined) {
    if (input.pausedUntil !== null) dateParts(input.pausedUntil);
    patch.push("paused_until = ?");
    values.push(input.pausedUntil);
  }
  if (input.active !== undefined) {
    patch.push("active = ?");
    values.push(input.active ? 1 : 0);
  }
  if (patch.length === 0) throw new Error("No template change was supplied.");
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const timezone = input.timezone ?? operatorTimezone();
  const localDate = localDateInTimezone(now, timezone);
  patch.push("updated_at = ?");
  values.push(nowIso, input.id);
  const db = openLocalDatabase(input.dbPath);
  try {
    db.transaction(() => {
      const result = db.prepare(
        `UPDATE recurring_templates SET ${patch.join(", ")} WHERE id = ?`,
      ).run(...values);
      if (result.changes !== 1) throw new Error("Recurring template not found.");
      const pausesToday = input.active === false ||
        (
          input.pausedUntil !== undefined &&
          input.pausedUntil !== null &&
          input.pausedUntil >= localDate
        );
      if (!pausesToday) return;
      const occurrence = db.prepare(
        `SELECT task_id FROM recurring_occurrences
         WHERE template_id = ? AND occurrence_local_date = ? AND state = 'open'`,
      ).get(input.id, localDate) as { task_id: string | null } | undefined;
      if (occurrence?.task_id) {
        db.prepare(
          `UPDATE tasks
           SET archived_from_status = COALESCE(archived_from_status, status),
               status = 'archived', archived_at = COALESCE(archived_at, ?),
               updated_at = ?
           WHERE id = ? AND status != 'done'`,
        ).run(nowIso, nowIso, occurrence.task_id);
      }
      db.prepare(
        `DELETE FROM recurring_occurrences
         WHERE template_id = ? AND occurrence_local_date = ? AND state = 'open'`,
      ).run(input.id, localDate);
    }).immediate();
    return decodeTemplate(
      db.prepare("SELECT * FROM recurring_templates WHERE id = ?")
        .get(input.id) as TemplateRow,
    );
  } finally {
    db.close();
  }
}

export function expireRecurringInstances(input: {
  localDate: string;
  dbPath?: string;
  now?: Date;
}): { expired: number } {
  dateParts(input.localDate);
  const nowIso = (input.now ?? new Date()).toISOString();
  const db = openLocalDatabase(input.dbPath);
  try {
    return db.transaction(() => {
      const rows = db.prepare(
        `SELECT ro.template_id, ro.task_id
         FROM recurring_occurrences ro
         LEFT JOIN tasks t ON t.id = ro.task_id
         WHERE ro.occurrence_local_date = ?
           AND ro.state = 'open'
           AND (t.id IS NULL OR t.status != 'done')`,
      ).all(input.localDate) as Array<{
        template_id: string;
        task_id: string | null;
      }>;
      const markMissed = db.prepare(
        `UPDATE recurring_occurrences
         SET state = 'missed', missed_at = ?, updated_at = ?
         WHERE template_id = ? AND occurrence_local_date = ? AND state = 'open'`,
      );
      const archiveTask = db.prepare(
        `UPDATE tasks
         SET archived_from_status = COALESCE(archived_from_status, status),
             status = 'archived', archived_at = ?, updated_at = ?
         WHERE id = ? AND status != 'done'`,
      );
      for (const row of rows) {
        markMissed.run(nowIso, nowIso, row.template_id, input.localDate);
        if (row.task_id) archiveTask.run(nowIso, nowIso, row.task_id);
      }
      for (const templateId of new Set(rows.map((row) => row.template_id))) {
        const template = db.prepare(
          "SELECT * FROM recurring_templates WHERE id = ?",
        ).get(templateId) as TemplateRow;
        recomputeTemplateStreak(db, template, input.localDate, nowIso);
      }
      return { expired: rows.length };
    }).immediate();
  } finally {
    db.close();
  }
}

export function syncRecurringOccurrenceForTask(
  db: Database.Database,
  taskId: string,
  taskStatus: string | null | undefined,
  nowIso: string,
): void {
  const occurrence = db.prepare(
    `SELECT template_id, occurrence_local_date, state
     FROM recurring_occurrences WHERE task_id = ?`,
  ).get(taskId) as {
    template_id: string;
    occurrence_local_date: string;
    state: OccurrenceState;
  } | undefined;
  if (!occurrence) return;
  const archivedFromStatus = taskStatus === "archived"
    ? (db.prepare(
        "SELECT archived_from_status FROM tasks WHERE id = ?",
      ).get(taskId) as { archived_from_status: string | null } | undefined)
      ?.archived_from_status
    : undefined;
  const state: OccurrenceState = taskStatus === "done"
    ? "completed"
    : taskStatus === "archived"
      ? archivedFromStatus === "done" ? "completed" : "missed"
      : "open";
  db.prepare(
    `UPDATE recurring_occurrences
     SET state = ?, completed_at = ?, missed_at = ?, updated_at = ?
     WHERE task_id = ?`,
  ).run(
    state,
    state === "completed" ? nowIso : null,
    state === "missed" ? nowIso : null,
    nowIso,
    taskId,
  );
  const template = db.prepare(
    "SELECT * FROM recurring_templates WHERE id = ?",
  ).get(occurrence.template_id) as TemplateRow;
  recomputeTemplateStreak(
    db,
    template,
    occurrence.occurrence_local_date,
    nowIso,
  );
}

export function recurringRhythmSnapshot(input: {
  dbPath?: string;
  now?: Date;
  timezone?: string;
  localDate?: string;
} = {}): RecurringRhythm[] {
  const now = input.now ?? new Date();
  const timezone = input.timezone ?? operatorTimezone();
  const localDate = input.localDate ?? localDateInTimezone(now, timezone);
  const todayLocalDate = localDateInTimezone(now, timezone);
  const nowIso = now.toISOString();
  const db = openLocalDatabase(input.dbPath);
  try {
    return db.transaction(() =>
      (db.prepare(
        "SELECT * FROM recurring_templates WHERE active = 1 ORDER BY created_at, id",
      ).all() as TemplateRow[]).map((template) =>
        recomputeTemplateStreak(
          db,
          template,
          localDate,
          nowIso,
          localDate === todayLocalDate,
        )
      )
    )();
  } finally {
    db.close();
  }
}
