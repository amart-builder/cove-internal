import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { coveDataDir } from "../operator";

const MAX_SIGNATURE_HTML_BYTES = 20 * 1024;

function htmlSha256(html: string): string {
  return createHash("sha256").update(html, "utf8").digest("hex");
}

function decodedForInspection(html: string): string {
  return html
    .replace(/&#(?:x([0-9a-f]+)|(\d+));?/gi, (entity, hexadecimal, decimal) => {
      const point = Number.parseInt(hexadecimal ?? decimal, hexadecimal ? 16 : 10);
      if (!Number.isFinite(point) || point < 0 || point > 0x10ffff) return entity;
      try {
        return String.fromCodePoint(point);
      } catch {
        return entity;
      }
    })
    .replace(/&colon;/gi, ":")
    .replace(/&tab;/gi, "\t")
    .replace(/&newline;/gi, "\n");
}

function signatureHtmlViolation(html: string): string | null {
  const inspected = decodedForInspection(html);
  const urlInspected = inspected.replace(/[\t\n\r]/g, "");
  if (/<script\b/i.test(inspected)) return "script elements";
  if (/<[^>]*(?:\s|\/)on[a-z0-9_-]+\s*=/i.test(inspected)) return "event-handler attributes";
  if (/<[^>]*javascript\s*:[^>]*>/i.test(urlInspected)) return "javascript: URLs";
  if (/\bsrc\s*=\s*(?:["']\s*)?cid:/i.test(inspected)) return "cid: images";
  return null;
}

export type SignatureMetadata = {
  sendAsEmail: string;
  fetchedAt: string;
  sourceMessageId: string;
};

function signaturePaths(dataDir?: string): { html: string; metadata: string } {
  const root = coveDataDir(dataDir);
  return {
    html: path.join(root, "signature.html"),
    metadata: path.join(root, "signature.json"),
  };
}

function classNames(tag: string): string[] {
  const match = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(tag);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").split(/\s+/).filter(Boolean);
}

function balancedElementEnd(html: string, start: number, tagName: string): number | null {
  const tag = new RegExp(`<\\/?${tagName}\\b[^>]*>`, "gi");
  tag.lastIndex = start;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(html))) {
    if (new RegExp(`^<\\s*\\/${tagName}`, "i").test(match[0])) {
      depth -= 1;
      if (depth === 0) return match.index + match[0].length;
    } else if (!/\/\s*>$/.test(match[0])) {
      depth += 1;
    }
  }
  return null;
}

function removeElements(
  html: string,
  tagName: string,
  shouldRemove: (openingTag: string) => boolean,
): string {
  const opening = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  const ranges: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = opening.exec(html))) {
    if (!shouldRemove(match[0])) continue;
    const end = balancedElementEnd(html, match.index, tagName) ?? html.length;
    ranges.push({ start: match.index, end });
    opening.lastIndex = end;
  }
  return ranges.reverse().reduce(
    (result, range) => `${result.slice(0, range.start)}${result.slice(range.end)}`,
    html,
  );
}

function withoutQuotedContent(html: string): string {
  const withoutBlockquotes = removeElements(html, "blockquote", () => true);
  const opening = /<([a-z][a-z0-9:-]*)\b[^>]*>/gi;
  const ranges: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = opening.exec(withoutBlockquotes))) {
    if (!classNames(match[0]).some((name) => name.toLowerCase() === "gmail_quote")) {
      continue;
    }
    const end = balancedElementEnd(withoutBlockquotes, match.index, match[1]) ??
      withoutBlockquotes.length;
    ranges.push({ start: match.index, end });
    opening.lastIndex = end;
  }
  return ranges.reverse().reduce(
    (result, range) => `${result.slice(0, range.start)}${result.slice(range.end)}`,
    withoutBlockquotes,
  );
}

export function extractGmailSignature(html: string): string | null {
  const unquoted = withoutQuotedContent(html);
  const openingTag = /<div\b[^>]*>/gi;
  let lastSignature: string | null = null;
  let opening: RegExpExecArray | null;
  while ((opening = openingTag.exec(unquoted))) {
    if (!classNames(opening[0]).some((name) => name.toLowerCase() === "gmail_signature")) {
      continue;
    }
    const start = opening.index;
    const end = balancedElementEnd(unquoted, start, "div");
    if (end === null) continue;
    lastSignature = unquoted.slice(start, end);
    openingTag.lastIndex = end;
  }
  return lastSignature;
}

export function loadSignature(
  dataDir?: string,
  expectedSendAsEmail?: string,
): { html: string; fetchedAt: string; sendAsEmail: string } | null {
  const files = signaturePaths(dataDir);
  try {
    const html = readFileSync(files.html, "utf8");
    if (
      !html ||
      Buffer.byteLength(html, "utf8") > MAX_SIGNATURE_HTML_BYTES ||
      signatureHtmlViolation(html)
    ) return null;
    const metadata = JSON.parse(readFileSync(files.metadata, "utf8")) as unknown;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    const row = metadata as Record<string, unknown>;
    const fetchedAt = row.fetchedAt;
    const sendAsEmail = row.sendAsEmail;
    if (
      typeof sendAsEmail !== "string" || !sendAsEmail.trim() ||
      typeof fetchedAt !== "string" || !fetchedAt.trim() || !Number.isFinite(Date.parse(fetchedAt)) ||
      typeof row.sourceMessageId !== "string" || !row.sourceMessageId.trim() ||
      typeof row.htmlSha256 !== "string" || row.htmlSha256 !== htmlSha256(html)
    ) return null;
    const normalizedSendAsEmail = sendAsEmail.trim().toLowerCase();
    if (
      expectedSendAsEmail &&
      normalizedSendAsEmail !== expectedSendAsEmail.trim().toLowerCase()
    ) return null;
    return { html, fetchedAt, sendAsEmail: normalizedSendAsEmail };
  } catch {
    return null;
  }
}

export function writeSignature(input: {
  html: string;
  metadata: SignatureMetadata;
  dataDir?: string;
}): void {
  if (!input.html || Buffer.byteLength(input.html, "utf8") > MAX_SIGNATURE_HTML_BYTES) {
    throw new Error("Email signature HTML must be between 1 byte and 20 KB.");
  }
  const violation = signatureHtmlViolation(input.html);
  if (violation) {
    throw new Error(`Email signature HTML cannot contain ${violation}.`);
  }
  const root = coveDataDir(input.dataDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const files = signaturePaths(root);
  const suffix = `${process.pid}-${Date.now()}`;
  const htmlTemp = `${files.html}.${suffix}.tmp`;
  const metadataTemp = `${files.metadata}.${suffix}.tmp`;
  try {
    writeFileSync(htmlTemp, input.html, { encoding: "utf8", mode: 0o600 });
    writeFileSync(
      metadataTemp,
      `${JSON.stringify({ ...input.metadata, htmlSha256: htmlSha256(input.html) }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(htmlTemp, files.html);
    renameSync(metadataTemp, files.metadata);
  } finally {
    for (const file of [htmlTemp, metadataTemp]) {
      try {
        unlinkSync(file);
      } catch {
        // A successful rename removes the temporary path.
      }
    }
  }
}
