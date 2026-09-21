import { domainToASCII } from "node:url";

export function cleanAttentionText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    // The C0 and C1 ranges above were stripped; this is the family next door,
    // and it is the one an attacker reaches for. These characters render as
    // nothing, so they do two things to a banner built from an email subject.
    // U+202E and its neighbours flip the text that follows, which makes what
    // Cove stored and what the person reads two different strings. And a single
    // U+2060 walked a whole domain past the rule below: it breaks the
    // label-dot-label shape the pattern matches, the remaining ".example" has
    // no leading label, and "Visit evil<U+2060>.example now" reached the screen
    // reading "Visit evil.example now".
    //
    // Removed rather than replaced with a space, because a space would be
    // visible where these are not, and because the domain rule has to see the
    // characters either side of them join up.
    //
    // U+200C and U+200D are deliberately absent: they carry meaning in emoji
    // sequences and in Persian and Devanagari orthography, and they are not a
    // bypass, because the domain rule already breaks a domain containing one.
    .replace(/[\u00ad\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, "")
    .replace(/[\u2013\u2014]/g, ":")
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizeAttentionContent(value) {
  return cleanAttentionText(value)
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "")
    .replace(/(?:\+?\d[\d().\s-]{6,}\d)/g, "")
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

export function sanitizeNonDirectBanner(value, provenance) {
  const sanitized = sanitizeAttentionContent(value);
  return `${cleanAttentionText(provenance)}: ${sanitized || "Open Cove to review this item."}`
    .slice(0, 180);
}

export function safeSenderDomain(fromHeader) {
  const raw = cleanAttentionText(fromHeader);
  if ((raw.match(/@/g) ?? []).length !== 1) return "an unknown sender";
  const angle = /<([^<>]+)>/.exec(raw)?.[1];
  const address = (angle ?? raw).trim();
  const domain = address.slice(address.lastIndexOf("@") + 1).replace(/^\[|\]$/g, "");
  if (!domain || /[\s/\\]/.test(domain)) return "an unknown sender";
  const ascii = domainToASCII(domain).toLowerCase().replace(/\.+$/, "");
  if (
    !ascii ||
    ascii.length > 253 ||
    !/^[a-z0-9.-]+$/.test(ascii) ||
    ascii.startsWith(".") ||
    ascii.includes("..") ||
    ascii.split(".").some((label) => !label || label.startsWith("-") || label.endsWith("-"))
  ) {
    return "an unknown sender";
  }
  return ascii;
}
