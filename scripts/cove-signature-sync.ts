import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFromHeader } from "../src/lib/email/from-header";
import { signatureHtmlToText } from "../src/lib/email/draft-format";
import { extractGmailSignature, writeSignature } from "../src/lib/email/signature";
import { operatorName } from "../src/lib/operator";
import { OPERATOR_NAME_FALLBACK } from "../src/lib/operator-runtime.mjs";
import { readWorkspaceConfig } from "../src/lib/workspace/config";
import { GoogleAccessTokenProvider } from "../src/lib/workspace/google/auth";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

type Json = Record<string, unknown>;

function object(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Json
    : null;
}

async function gmailJson(url: string, token: string): Promise<Json> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Gmail signature sync failed with HTTP ${response.status}.`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("Gmail signature sync received an oversized response.");
  }
  const parsed = object(JSON.parse(text) as unknown);
  if (!parsed) throw new Error("Gmail signature sync received invalid JSON.");
  return parsed;
}

function header(payload: Json, name: string): string {
  const headers = Array.isArray(payload.headers) ? payload.headers : [];
  for (const value of headers) {
    const row = object(value);
    if (
      typeof row?.name === "string" &&
      row.name.toLowerCase() === name.toLowerCase() &&
      typeof row.value === "string"
    ) {
      return row.value;
    }
  }
  return "";
}

export function htmlParts(payload: unknown, depth = 0): string[] {
  const row = object(payload);
  if (!row || depth > 12) return [];
  const body = object(row.body);
  const own = row.mimeType === "text/html" && typeof body?.data === "string"
    ? [Buffer.from(body.data, "base64url").toString("utf8")]
    : [];
  const parts = Array.isArray(row.parts)
    ? row.parts.flatMap((part) => htmlParts(part, depth + 1))
    : [];
  return [...own, ...parts];
}

export function imageHosts(html: string): string[] {
  const hosts = new Set<string>();
  for (const match of html.matchAll(/\bsrc\s*=\s*["'](https?:\/\/[^"']+)["']/gi)) {
    try {
      hosts.add(new URL(match[1]).hostname);
    } catch {
      // The cache can keep non-URL image attributes, but only valid hosts are printed.
    }
  }
  return [...hosts];
}

export function selectOperatorSignature(
  messages: Array<{ sourceMessageId: string; html: string[] }>,
  expectedOperatorName: string,
): { html: string; sourceMessageId: string } | null {
  const expected = expectedOperatorName.toLowerCase().replace(/\s+/g, " ").trim();
  if (!expected || expected === OPERATOR_NAME_FALLBACK) {
    throw new Error("Configure your operator name first before syncing a Gmail signature.");
  }
  for (const message of messages) {
    for (const html of message.html) {
      const signature = extractGmailSignature(html);
      if (!signature) continue;
      const text = signatureHtmlToText(signature).toLowerCase().replace(/\s+/g, " ").trim();
      if (!text.includes(expected)) continue;
      return { html: signature, sourceMessageId: message.sourceMessageId };
    }
  }
  return null;
}

async function main(): Promise<void> {
  if (process.argv.length > 2) throw new Error("email:signature-sync accepts no flags or options.");
  const config = readWorkspaceConfig();
  const provider = new GoogleAccessTokenProvider(config);
  const token = await provider.getAccessToken();
  const profile = await gmailJson(`${GMAIL}/profile`, token);
  if (typeof profile.emailAddress !== "string" || !profile.emailAddress.trim()) {
    throw new Error("Gmail profile did not include an account email.");
  }
  const accountEmail = profile.emailAddress.trim().toLowerCase();
  const list = await gmailJson(
    `${GMAIL}/messages?q=${encodeURIComponent("in:sent")}&maxResults=10`,
    token,
  );
  const messages = Array.isArray(list.messages) ? list.messages : [];
  const candidates: Array<{ sourceMessageId: string; html: string[] }> = [];
  for (const reference of messages) {
    const messageId = object(reference)?.id;
    if (typeof messageId !== "string" || !messageId) continue;
    const message = await gmailJson(
      `${GMAIL}/messages/${encodeURIComponent(messageId)}?format=full`,
      token,
    );
    const payload = object(message.payload);
    if (!payload) continue;
    let from: string;
    try {
      from = parseFromHeader(header(payload, "From")).address;
    } catch {
      continue;
    }
    if (from.toLowerCase() !== accountEmail) continue;
    candidates.push({ sourceMessageId: messageId, html: htmlParts(payload) });
  }
  const selected = selectOperatorSignature(candidates, operatorName());
  if (!selected) {
    throw new Error("No sent message from this account contained the operator's own gmail_signature block.");
  }
  const fetchedAt = new Date().toISOString();
  writeSignature({
    html: selected.html,
    metadata: {
      sendAsEmail: accountEmail,
      fetchedAt,
      sourceMessageId: selected.sourceMessageId,
    },
  });
  const plain = signatureHtmlToText(selected.html);
  const hosts = imageHosts(selected.html);
  console.log(
    `Stored Gmail signature: html=${Buffer.byteLength(selected.html, "utf8")} bytes, ` +
    `plain=${Buffer.byteLength(plain, "utf8")} bytes, img-host=${hosts.join(",") || "none"}.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
