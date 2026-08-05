import { createHash } from "node:crypto";
import { draftBodyToHtml } from "../../email/draft-format";
import { WorkspaceGatewayError } from "../errors";

function headerValue(value: string, name: string, max: number): string {
  const result = value.trim();
  if (!result || result.length > max || /[\r\n]/.test(result)) {
    throw new WorkspaceGatewayError({
      code: "invalid_input",
      operation: "build_draft",
      safeMessage: `${name} is invalid.`,
    });
  }
  return result;
}

function encodeSubject(subject: string): string {
  return /^[\x20-\x7E]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

export function deterministicMessageId(
  idempotencyKey: string,
  accountEmail: string,
): string {
  const domain = accountEmail.split("@")[1] || "cove.local";
  const digest = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32);
  return `<cove-${digest}@${domain}>`;
}

export function buildReplyMime(input: {
  to: string;
  subject: string;
  body: string;
  htmlBody?: string;
  inReplyTo: string;
  references: string[];
  idempotencyKey: string;
  accountEmail: string;
}): string {
  const to = headerValue(input.to, "Reply recipient", 1_000);
  const rawSubject = headerValue(input.subject, "Subject", 998);
  const subject = /^re:/i.test(rawSubject) ? rawSubject : `Re: ${rawSubject}`;
  const inReplyTo = headerValue(input.inReplyTo, "In-Reply-To", 998);
  if (input.body.length > 100_000) {
    throw new WorkspaceGatewayError({
      code: "invalid_input",
      operation: "build_draft",
      safeMessage: "Draft body is too long.",
    });
  }
  const htmlBody = input.htmlBody ?? draftBodyToHtml(input.body);
  if (Buffer.byteLength(htmlBody, "utf8") > 250_000) {
    throw new WorkspaceGatewayError({
      code: "invalid_input",
      operation: "build_draft",
      safeMessage: "Draft HTML is too long.",
    });
  }
  const references = [...input.references, inReplyTo]
    .map((value) => headerValue(value, "References", 998))
    .filter((value, index, rows) => rows.indexOf(value) === index)
    .join(" ");
  const messageId = deterministicMessageId(input.idempotencyKey, input.accountEmail);
  const boundary = `=_cove_${createHash("sha256")
    .update(`${input.idempotencyKey}\0${messageId}`)
    .digest("hex")
    .slice(0, 32)}`;
  const encodePart = (value: string): string[] => {
    const canonical = value.replace(/\r\n?|\n/g, "\r\n");
    return Buffer.from(canonical, "utf8").toString("base64").match(/.{1,76}/g) ?? [""];
  };
  const headers = [
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    `Message-ID: ${messageId}`,
    `In-Reply-To: ${inReplyTo}`,
    `References: ${references}`,
    `X-Cove-Operation-Id: ${headerValue(input.idempotencyKey, "Operation id", 240)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    ...encodePart(input.body),
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    ...encodePart(htmlBody),
    `--${boundary}--`,
    "",
  ];
  return Buffer.from(headers.join("\r\n"), "utf8")
    .toString("base64url");
}

export function buildSupportMime(input: {
  to: string;
  subject: string;
  body: string;
  idempotencyKey: string;
  accountEmail: string;
}): string {
  const headers = [
    `To: ${headerValue(input.to, "Recipient", 500)}`,
    `Subject: ${encodeSubject(headerValue(input.subject, "Subject", 998))}`,
    `Message-ID: ${deterministicMessageId(input.idempotencyKey, input.accountEmail)}`,
    `X-Cove-Operation-Id: ${headerValue(input.idempotencyKey, "Operation id", 240)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${input.body}`, "utf8")
    .toString("base64url");
}
