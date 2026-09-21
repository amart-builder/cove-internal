import { dueCalendarDay } from "../attention/due-date.mjs";

/**
 * How a task's stored `due_at` is shown to the person who is looking at it.
 *
 * A `due_at` is either a calendar day or a moment, and the two have to be shown
 * differently: a day has no clock time to print, and printing one invents
 * precision the person never chose. `src/lib/attention/due-date.mjs` has the
 * full account of the two encodings; the short version is that the board's date
 * pickers write a day as that day at UTC midnight, so reading it as an instant
 * puts it on the previous evening for every operator west of UTC.
 *
 * A day is rendered at noon so the label cannot drift either way across a
 * timezone or a clock change. This matches what the arrival screen already does
 * (`formatArrivalDueDate` in `src/lib/day-plan/presentation.ts`).
 */
export function taskDueLabel(dueAt: string): string {
  const day = dueCalendarDay(dueAt);
  if (day) return new Date(`${day}T12:00:00`).toLocaleDateString();
  return new Date(dueAt).toLocaleString();
}
