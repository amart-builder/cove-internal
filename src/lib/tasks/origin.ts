/**
 * Task origin text: the plain-language answer to "why is this on my board?"
 * Every writer that creates a task fills `tasks.origin` with who asked, where,
 * when, and their exact words when Cove has them. The UI shows it under
 * "Reason this task was added".
 */

const MAX_QUOTE = 300;

/** Collapse whitespace and bound a quoted excerpt so the box stays readable. */
export function originQuote(text: string | null | undefined, max = MAX_QUOTE): string {
  const compact = (text ?? "").replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1).trimEnd()}…` : compact;
}

/** "Sep 4, 2026" in the given timezone; falls back to the raw value if unparseable. */
export function originDate(value: string | Date | null | undefined, timezone?: string): string {
  const date = value instanceof Date ? value : new Date(value ?? Number.NaN);
  if (Number.isNaN(date.getTime())) return "an unknown date";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(timezone ? { timeZone: timezone } : {}),
  }).format(date);
}

/** How each inbound channel reads to the operator. */
const CHANNEL_PHRASES: Record<string, string> = {
  imessage: "You texted Cove over iMessage",
  telegram: "You messaged Cove on Telegram",
  chat: "You told Claude in chat",
  buddy: "You asked Buddy",
  voice: "You sent a voice note",
  "day-plan": "You captured this in your day plan",
  meeting: "Cove picked this up from meeting notes received",
  "meeting-notes": "Cove picked this up from meeting notes received",
  email: "Cove picked this up from an email received",
  automation: "A Cove automation created this",
};

/**
 * Origin for a task built from an inbound event (text, voice note, chat,
 * meeting notes). Quotes the raw text so the operator sees the actual words.
 */
export function inboundOrigin(
  event: { source?: string; raw_text?: string | null; created_at?: string | null },
  timezone?: string,
): string {
  const when = originDate(event.created_at, timezone);
  const phrase = CHANNEL_PHRASES[event.source ?? ""] ?? `This arrived through ${event.source ?? "an unknown channel"}`;
  const words = originQuote(event.raw_text);
  return words ? `${phrase} on ${when}: "${words}"` : `${phrase} on ${when}.`;
}
