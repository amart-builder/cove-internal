import type Database from "better-sqlite3";
import type { Responsibility } from "./store";

export type CalendarBlock = {
  start: string;
  end: string;
  status?: string;
  attendees?: Array<{ self?: boolean; responseStatus?: string }>;
};
export function localDay(now: Date, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function localHour(date: string, hour: number, timezone: string): Date {
  const wanted = Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
  let instant = wanted;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  for (let i = 0; i < 4; i++) {
    const p = Object.fromEntries(
      formatter.formatToParts(new Date(instant)).map((p) => [p.type, p.value]),
    );
    const offset =
      Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) -
      instant;
    const next = wanted - offset;
    if (next === instant) break;
    instant = next;
  }
  return new Date(instant);
}

/** Calendar overlap is counted once. Unknown availability is never free time. */
export function assessCapacity(input: {
  now: Date;
  date: string;
  timezone: string;
  events: CalendarBlock[] | null;
  items: Array<{ id: string; title: string; minutes: number | null }>;
  startHour?: number;
  endHour?: number;
}) {
  const start = Math.max(
    +input.now,
    +localHour(input.date, input.startHour ?? 9, input.timezone),
  );
  const end = +localHour(input.date, input.endHour ?? 17, input.timezone);
  const intervals = (input.events ?? [])
    .filter(
      (e) =>
        e.status !== "cancelled" &&
        !e.attendees?.some((a) => a.self && a.responseStatus === "declined"),
    )
    .map((e) => [
      Math.max(
        start,
        e.start.includes("T")
          ? Date.parse(e.start)
          : +localHour(e.start, 0, input.timezone),
      ),
      Math.min(
        end,
        e.end.includes("T")
          ? Date.parse(e.end)
          : +localHour(e.end, 0, input.timezone),
      ),
    ])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((a, b) => a[0] - b[0]);
  let busy = 0,
    until = start;
  for (const [a, b] of intervals) {
    busy += Math.max(0, b - Math.max(a, until));
    until = Math.max(until, b);
  }
  const available =
    input.events === null
      ? null
      : Math.floor((Math.max(0, end - start - busy) / 60000) * 0.7);
  const known = input.items.reduce((sum, item) => sum + (item.minutes ?? 0), 0);
  const unknown = input.items.filter((item) => item.minutes === null).length;
  return {
    availableMinutes: available,
    proposedMinutes: known,
    unknownEstimates: unknown,
    overloaded: available !== null && known > available,
    assumption: `9am to 5pm working window with 30% left for breaks and unexpected work. Estimates are proposals.`,
    conclusion:
      available === null
        ? "Calendar availability is unknown. This plan is not verified to fit."
        : known > available
          ? "This plan needs a tradeoff. Reduce, delegate, defer or renegotiate before adding more."
          : unknown
            ? "Some work is not estimated. There is not enough evidence to say this day fits."
            : "Estimated work fits the remaining window; review the assumptions.",
  };
}

/** This local read model never adds personal planning files to a model prompt. */
export function plannedDay(
  db: Database.Database,
  rows: Responsibility[],
  date: string,
  timezone: string,
) {
  const exists = !!db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='day_plans'",
    )
    .get();
  const plans = exists
    ? (db
        .prepare(
          "SELECT local_date,items_json FROM day_plans WHERE local_date<=? ORDER BY local_date DESC LIMIT 14",
        )
        .all(date) as Array<{ local_date: string; items_json: string }>)
    : [];
  const ids = new Set<string>();
  const carried = new Map<string, number>();
  for (const plan of plans) {
    let items: Array<{
      taskId?: string;
      decision?: string;
      settlementDecision?: { disposition?: string };
    }> = [];
    try {
      items = JSON.parse(plan.items_json);
    } catch {
      continue;
    }
    if (!Array.isArray(items)) continue;
    for (const item of items)
      if (item.taskId) {
        if (plan.local_date === date && item.decision === "accepted")
          ids.add(item.taskId);
        if (
          plan.local_date < date &&
          item.settlementDecision?.disposition === "carry"
        )
          carried.set(item.taskId, (carried.get(item.taskId) ?? 0) + 1);
      }
  }
  const planned = rows.filter(
    (row) =>
      (row.ref_kind === "task" && ids.has(row.ref_id)) ||
      (row.planned_for &&
        Number.isFinite(Date.parse(row.planned_for)) &&
        localDay(new Date(row.planned_for), timezone) === date),
  );
  return {
    items: planned.map((row) => ({
      id: `${row.ref_kind}:${row.ref_id}`,
      title: row.title,
      minutes: row.estimate_minutes,
    })),
    carried: rows
      .filter(
        (row) => row.ref_kind === "task" && (carried.get(row.ref_id) ?? 0) >= 3,
      )
      .map((row) => ({
        id: row.ref_id,
        title: row.title,
        count: carried.get(row.ref_id)!,
        nextAction: row.next_action,
        blocker: row.blocker,
      })),
  };
}
