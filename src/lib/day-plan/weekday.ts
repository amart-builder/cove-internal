// Pure local-date weekday helpers. This module must stay dependency-free:
// client components import it directly, so it can never pull in server-only
// modules the way brief.ts does.

function utcDateFromLocalDate(localDate: string): Date {
  const [year, month, day] = localDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function isWeekendLocalDate(localDate: string): boolean {
  const weekday = utcDateFromLocalDate(localDate).getUTCDay();
  return weekday === 0 || weekday === 6;
}

// Returns the first weekday strictly after localDate. Date.UTC keeps this
// calendar math independent from both the server timezone and DST changes.
export function nextWeekdayLocalDate(localDate: string): string {
  const next = utcDateFromLocalDate(localDate);
  do {
    next.setUTCDate(next.getUTCDate() + 1);
  } while (next.getUTCDay() === 0 || next.getUTCDay() === 6);
  return next.toISOString().slice(0, 10);
}
