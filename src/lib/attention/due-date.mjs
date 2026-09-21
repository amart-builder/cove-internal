/**
 * What day a stored `due_at` means, when it means a day rather than a moment.
 *
 * Cove stores a due date two ways. A bare `YYYY-MM-DD` is plainly a calendar
 * date. So is `YYYY-MM-DDT00:00:00.000Z`: that is what Cove's own date pickers
 * write, and only they write it. `toSupabaseDueAt` in KanbanBoard.tsx does it,
 * TodayView.tsx does the same, and the comment beside them explains why -- the
 * read path slices the date off the front of the string, so storing local
 * midnight would show the day before the one the person picked to anyone at or
 * ahead of UTC.
 *
 * Right for display, and wrong for every lane that asks when the deadline is.
 * `2026-10-02T00:00:00.000Z` is 5pm on October 1 in Los Angeles, so a card the
 * board labelled October 2 rang on the evening of October 1, and the attention
 * floor said "Due today and still open in Cove" at lunchtime on October 1 while
 * the same screen showed the card as due tomorrow. Everyone west of UTC got
 * that on the first due date they set.
 *
 * Everything else that writes a deadline -- intake, the meeting analyst, the
 * wake loop, the cove-task skill -- writes either an offset timestamp or a bare
 * date, so an exact UTC midnight is not ambiguous in practice. A deadline with
 * a real time of day, including one at 00:00 in the operator's own zone, is an
 * instant and is left alone.
 */

const BARE_CALENDAR_DATE = /^(\d{4}-\d{2}-\d{2})$/;
const UTC_MIDNIGHT = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.000)?Z$/;

/** The calendar day this due_at names, or null when it names a moment. */
export function dueCalendarDay(raw) {
  if (typeof raw !== "string" || raw === "") return null;
  const bare = BARE_CALENDAR_DATE.exec(raw);
  if (bare) return bare[1];
  const midnight = UTC_MIDNIGHT.exec(raw);
  return midnight ? midnight[1] : null;
}

/**
 * When the reminder for this due_at is owed.
 *
 * A calendar day is owed at 9am, never at a made-up midnight: the same hour the
 * bare-date form has always used. Anything else is already a moment.
 */
export function dueInstant(raw) {
  const day = dueCalendarDay(raw);
  return new Date(day ? `${day}T09:00:00` : raw);
}
