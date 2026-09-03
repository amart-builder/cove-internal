import { parseFromHeader } from "./from-header";

export type CalendarNoticeKind =
  | "accepted"
  | "declined"
  | "tentative"
  | "invitation"
  | "updated"
  | "canceled"
  | "new_event";

export type CalendarNotice = {
  kind: CalendarNoticeKind;
  eventTitle: string;
  responder: string;
};

const PREFIXES: Array<{ prefix: string; kind: CalendarNoticeKind }> = [
  { prefix: "Tentatively accepted:", kind: "tentative" },
  { prefix: "Tentatively Accepted:", kind: "tentative" },
  { prefix: "Updated invitation:", kind: "updated" },
  { prefix: "Canceled event:", kind: "canceled" },
  { prefix: "Cancelled event:", kind: "canceled" },
  { prefix: "Accepted:", kind: "accepted" },
  { prefix: "Declined:", kind: "declined" },
  { prefix: "Invitation:", kind: "invitation" },
  { prefix: "New Event:", kind: "new_event" },
];

const SCHEDULE_DATE_START = /^(?:(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b|\d{1,4}[/-]\d{1,2})/iu;

// A real schedule carries a year or a clock time ("Thu Sep 24, 2026 3pm"),
// which keeps "@ March Capital" or "@ Friday Beers" from reading as a date.
const SCHEDULE_YEAR_OR_TIME = /\b(?:19|20)\d{2}\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/iu;

function scheduleSegmentIndex(value: string): number {
  for (const match of value.matchAll(/\s+@\s+/gu)) {
    const suffix = value.slice((match.index ?? 0) + match[0].length);
    if (SCHEDULE_DATE_START.test(suffix) && SCHEDULE_YEAR_OR_TIME.test(suffix)) {
      return match.index ?? -1;
    }
  }
  return -1;
}

function stripScheduleSuffix(value: string): string {
  const scheduleIndex = scheduleSegmentIndex(value);
  return (scheduleIndex >= 0 ? value.slice(0, scheduleIndex) : value)
    .replace(
      /\s+-\s+(?:\d{1,2}:\d{2}(?:\s*(?:am|pm))?|\d{1,2}\s*(?:am|pm))\b.*$/iu,
      "",
    )
    .trim();
}

export function detectCalendarNotice(input: {
  sender: string;
  subject: string;
}): CalendarNotice | null {
  const subject = input.subject.trim();
  const match = PREFIXES.find(({ prefix }) => subject.startsWith(prefix));
  if (!match) return null;

  const parsedSender = parseFromHeader(input.sender);
  const rawEventTitle = subject.slice(match.prefix.length).trim();
  const calendarSender = parsedSender.address === "calendar-notification@google.com" ||
    parsedSender.address.endsWith("@calendar-server.bounces.google.com");
  if (scheduleSegmentIndex(rawEventTitle) < 0 && !calendarSender) return null;

  let eventTitle = stripScheduleSuffix(rawEventTitle);
  let responder = parsedSender.displayName || parsedSender.address || "Unknown sender";
  if (match.kind === "new_event") {
    const booking = /^(.+?)\s+-\s+(.+)$/u.exec(eventTitle);
    if (booking) {
      responder = booking[1].trim();
      eventTitle = booking[2].trim();
    }
  }
  if (!eventTitle) return null;

  return { kind: match.kind, eventTitle, responder };
}

export function summarizeCalendarNotice(notice: CalendarNotice): string {
  switch (notice.kind) {
    case "accepted":
      return `Accepted: ${notice.eventTitle} (${notice.responder})`;
    case "declined":
      return `Declined: ${notice.eventTitle} (${notice.responder})`;
    case "tentative":
      return `Tentative: ${notice.eventTitle} (${notice.responder})`;
    case "invitation":
      return `Invitation: ${notice.eventTitle} from ${notice.responder}`;
    case "updated":
      return `Updated: ${notice.eventTitle}`;
    case "canceled":
      return `Canceled: ${notice.eventTitle}`;
    case "new_event":
      return `Booked: ${notice.eventTitle}`;
  }
}
