import { domainToASCII } from "node:url";

export function cleanAttentionText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/[\u2013\u2014]/g, ":")
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizeNonDirectBanner(value, provenance) {
  const sanitized = cleanAttentionText(value)
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "")
    .replace(/(?:\+?\d[\d().\s-]{6,}\d)/g, "")
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
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
