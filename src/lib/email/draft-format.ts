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

export function stripTrailingSignature(text: string, signatureText?: string | null): string {
  const body = text.replace(/\r\n?/g, "\n").trim();
  const signature = collapsedAlphanumerics(signatureText ?? "");
  if (!body || !signature) return body;
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
    return remainder || body;
  }
  return body;
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

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
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
  return decodeEntities(
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
