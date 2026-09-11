import { localDateInTimezone } from "./brief";
import { isWeekendLocalDate } from "./weekday";

// Automatic briefs start at 08:00 in the operator's zone. Calendar comparisons
// preserve that wall-clock time across DST and catch up after laptop sleep.
export function automaticBriefIsDue(targetLocalDate: string, now: Date, timezone: string): boolean {
  if (targetLocalDate !== localDateInTimezone(now, timezone) || isWeekendLocalDate(targetLocalDate)) {
    return false;
  }
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(now));
  return hour >= 8;
}
