const MAX_SIGNATURE_HTML_BYTES = 20 * 1024;

function startsWithListMarker(line: string): boolean {
  return /^\s*(?:[-*•>]|\d+[.)])/u.test(line);
}

function isShortBlockLine(line: string): boolean {
  return line.trim().length <= 45;
}

function joinParagraphLines(paragraph: string): string {
  const lines = paragraph.split("\n");
  let joined = lines[0] ?? "";
  let colonBlock = false;
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1] ?? "";
    const line = lines[index] ?? "";
    const beginsColonBlock = previous.trimEnd().endsWith(":") && isShortBlockLine(line);
    const continuesColonBlock: boolean = colonBlock &&
      isShortBlockLine(previous) &&
      isShortBlockLine(line);
    if (beginsColonBlock || continuesColonBlock || startsWithListMarker(line)) {
      joined = `${joined}\n${line}`;
      colonBlock = beginsColonBlock || continuesColonBlock;
    } else {
      joined = `${joined.replace(/[ \t]+$/g, "")} ${line.trimStart()}`;
      colonBlock = false;
    }
  }
  return joined;
}

export function normalizeDraftBody(text: string): string {
  const cleaned = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned) return "";
  return cleaned
    .split("\n\n")
    .map(joinParagraphLines)
    .join("\n\n");
}

function collapsedAlphanumerics(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const SIGN_OFF_CLOSER = new RegExp(
  "^(?:best|best regards|best wishes|all the best|regards|kind regards|warm regards|" +
  "warmest regards|warmly|thanks|thanks again|thanks so much|thank you|many thanks|" +
  "cheers|sincerely|sincerely yours|yours truly|talk soon|take care|gratefully|" +
  "respectfully|cordially),$",
  "i",
);

// A line that plausibly belongs under a valediction: a name or company line,
// short and without sentence-ending punctuation.
function isSignOffNameLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && trimmed.length <= 45 && !/[.!?:;,]$/.test(trimmed);
}

// Strips a model-invented valediction ("Best,\nAlex") that survives the
// verbatim signature match, so the appended real signature never stacks
// under a second sign-off. Never strips the entire body.
function stripGenericSignOff(body: string): string {
  const lines = body.split("\n");
  const nonEmpty = lines.flatMap((line, index) => line.trim() ? [index] : []);
  const maximum = Math.min(3, nonEmpty.length - 1);
  for (let count = maximum; count >= 1; count -= 1) {
    const start = nonEmpty[nonEmpty.length - count];
    const block = lines.slice(start).filter((line) => line.trim());
    if (!SIGN_OFF_CLOSER.test(block[0]?.trim() ?? "")) continue;
    if (!block.slice(1).every(isSignOffNameLine)) continue;
    const remainder = lines.slice(0, start).join("\n").trim();
    if (remainder) return remainder;
  }
  return body;
}

export function stripTrailingSignature(text: string, signatureText?: string | null): string {
  let body = text.replace(/\r\n?/g, "\n").trim();
  if (!body) return body;
  const signature = collapsedAlphanumerics(signatureText ?? "");
  if (signature) {
    const lines = body.split("\n");
    const nonEmpty = lines.flatMap((line, index) => line.trim() ? [index] : []);
    const maximum = Math.min(4, nonEmpty.length);
    for (let count = maximum; count >= 1; count -= 1) {
      const start = nonEmpty[nonEmpty.length - count];
      const candidate = lines
        .slice(start)
        .filter((line) => line.trim())
        .map(collapsedAlphanumerics)
        .join("");
      if (!candidate || !signature.startsWith(candidate)) continue;
      const remainder = lines.slice(0, start).join("\n").trim();
      if (remainder) {
        body = remainder;
        break;
      }
    }
  }
  return stripGenericSignOff(body);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function autolinkEscapedText(text: string): string {
  return text.replace(/https?:\/\/[^\s<]+/gi, (candidate) => {
    const escapedDelimiter = candidate.search(/&(?:gt|lt|quot|#39);/i);
    let url = escapedDelimiter === -1 ? candidate : candidate.slice(0, escapedDelimiter);
    let trailing = escapedDelimiter === -1 ? "" : candidate.slice(escapedDelimiter);
    while (/[.,!?;:\])}]$/.test(url)) {
      if (url.endsWith(")")) {
        const openings = url.match(/\(/g)?.length ?? 0;
        const closings = url.match(/\)/g)?.length ?? 0;
        if (closings <= openings) break;
      }
      trailing = `${url.slice(-1)}${trailing}`;
      url = url.slice(0, -1);
    }
    return url ? `<a href="${url}">${url}</a>${trailing}` : candidate;
  });
}

export function draftBodyToHtml(normalized: string, signatureHtml?: string): string {
  if (
    signatureHtml !== undefined &&
    Buffer.byteLength(signatureHtml, "utf8") > MAX_SIGNATURE_HTML_BYTES
  ) {
    throw new Error("Email signature HTML exceeds 20 KB.");
  }
  const paragraphs = normalized
    ? normalized.split("\n\n").map((paragraph) =>
      `<div>${autolinkEscapedText(escapeHtml(paragraph)).replace(/\n/g, "<br>")}</div>`
    )
    : [];
  const body = paragraphs.join("<div><br></div>");
  const signature = signatureHtml
    ? `${body ? "<div><br></div>" : ""}${signatureHtml}`
    : "";
  return `<div dir="ltr">${body}${signature}</div>`;
}

/**
 * Shared with the Google gateway, which strips the tags off an HTML-only email
 * and needs the same decoding afterwards. Kept here because this is the module
 * that already owns Cove's HTML-to-text handling.
 */
export function decodeHtmlEntities(text: string): string {
  // The punctuation a mail composer emits for ordinary typing, plus the five
  // structural entities. Anything outside this list is left as written;
  // numeric references below already cover the rest.
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    bull: "\u2022",
    copy: "\u00a9",
    deg: "\u00b0",
    euro: "\u20ac",
    gt: ">",
    hellip: "\u2026",
    ldquo: "\u201c",
    lsquo: "\u2018",
    lt: "<",
    mdash: "\u2014",
    middot: "\u00b7",
    nbsp: " ",
    ndash: "\u2013",
    pound: "\u00a3",
    quot: '"',
    rdquo: "\u201d",
    reg: "\u00ae",
    rsquo: "\u2019",
    trade: "\u2122",
  };
  return text.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (entity, key: string) => {
    if (key[0] !== "#") return named[key.toLowerCase()] ?? entity;
    const hexadecimal = key[1]?.toLowerCase() === "x";
    const point = Number.parseInt(key.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    if (!Number.isFinite(point) || point < 0 || point > 0x10ffff) return entity;
    try {
      return String.fromCodePoint(point);
    } catch {
      return entity;
    }
  });
}

export function signatureHtmlToText(signatureHtml: string): string {
  return decodeHtmlEntities(
    signatureHtml
      .replace(/<!--[^]*?-->/g, "")
      .replace(/<(?:script|style)\b[^>]*>[^]*?<\/(?:script|style)>/gi, "")
      .replace(/<img\b[^>]*>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<(?:address|blockquote|div|h[1-6]|ol|p|pre|table|tr|ul)\b[^>]*>/gi, "\n")
      .replace(/<\/(?:address|blockquote|div|h[1-6]|li|ol|p|pre|table|tr|ul)>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
