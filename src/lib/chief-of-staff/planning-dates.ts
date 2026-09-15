/** Local labels accompany source dates; they never replace source values or IDs. */
export function localDateLabel(
  value: string | null | undefined,
  timeZone: string,
  options: { exclusiveEnd?: boolean } = {},
): string | null {
  if (value === null || value === undefined || value === "") return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const instant = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!dateOnly && !instant) {
    return "Unlabelled date/time: unsupported format or missing explicit timezone. Do not infer its local date or time.";
  }
  const calendarDate = dateOnly ? value : instant![1];
  const calendarDay = new Date(`${calendarDate}T00:00:00Z`);
  const validCalendarDate = Number.isFinite(+calendarDay) && calendarDay.toISOString().slice(0, 10) === calendarDate;
  const validClock = !instant || (
    Number(instant[2]) < 24 && Number(instant[3]) < 60 && Number(instant[4] ?? 0) < 60 &&
    Number(instant[6] ?? 0) < 24 && Number(instant[7] ?? 0) < 60
  );
  const date = dateOnly ? calendarDay : new Date(value);
  if (!validCalendarDate || !validClock || !Number.isFinite(+date)) {
    return "Invalid date/time: do not infer its local date or time.";
  }
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: dateOnly ? "UTC" : timeZone,
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    ...(!dateOnly ? { hour: "numeric", minute: "2-digit", timeZoneName: "short" } as const : {}),
  }).format(date);
  return label + (dateOnly
    ? options.exclusiveEnd ? " (date only; exclusive end, this date is not covered)" : " (date only)"
    : options.exclusiveEnd ? " (exclusive end)" : "");
}

const dateFields = {
  now: "nowLocal",
  deadline: "deadlineLocal",
  dueAt: "dueAtLocal",
  due_at: "dueAtLocal",
  nextCheckAt: "nextCheckAtLocal",
  next_check_at: "nextCheckAtLocal",
  plannedFor: "plannedForLocal",
  planned_for: "plannedForLocal",
  observedAt: "observedAtLocal",
  observed_at: "observedAtLocal",
  timeMin: "timeMinLocal",
  timeMax: "timeMaxLocal",
  expiresAt: "expiresAtLocal",
  expires_at: "expiresAtLocal",
  createdAt: "createdAtLocal",
  created_at: "createdAtLocal",
  updatedAt: "updatedAtLocal",
  updated_at: "updatedAtLocal",
  answeredAt: "answeredAtLocal",
  answered_at: "answeredAtLocal",
  closedAt: "closedAtLocal",
  closed_at: "closedAtLocal",
  settledAt: "settledAtLocal",
  settled_at: "settledAtLocal",
} as const;

/** Label only known date fields in this record, without traversing source bodies. */
export function withPlanningDateLabels<T extends object>(record: T, timeZone: string): T & Record<string, unknown> {
  const result: Record<string, unknown> = { ...record } as Record<string, unknown>;
  const source = record as Record<string, unknown>;
  for (const [field, label] of Object.entries(dateFields)) {
    if (!Object.hasOwn(source, field)) continue;
    const value = source[field];
    result[label] = typeof value === "string" || value === null || value === undefined
      ? localDateLabel(value, timeZone, { exclusiveEnd: field === "timeMax" })
      : "Invalid date/time: expected a source date string. Do not infer its local date or time.";
  }
  return result as T & Record<string, unknown>;
}
