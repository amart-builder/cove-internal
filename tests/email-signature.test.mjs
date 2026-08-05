import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  extractGmailSignature,
  loadSignature,
  writeSignature,
} from "../src/lib/email/signature.ts";

test("extractGmailSignature prefers the last unquoted balanced signature block", () => {
  const html = [
    "<div>Message</div>",
    '<div dir="ltr" class="foo gmail_signature bar" data-smartmail="gmail_signature">',
    "<div>Best,<div>Alex</div></div>",
    "</div>",
    '<div class="gmail_signature">Second signature</div>',
  ].join("");
  assert.equal(
    extractGmailSignature(html),
    '<div class="gmail_signature">Second signature</div>',
  );
});

test("extractGmailSignature returns null for absent or unbalanced blocks", () => {
  assert.equal(extractGmailSignature("<div>No signature</div>"), null);
  assert.equal(extractGmailSignature('<div class="gmail_signature"><div>Alex</div>'), null);
});

test("extractGmailSignature handles Gmail multipart-related HTML fixtures", () => {
  const relatedHtml = [
    '<div dir="ltr">Reply body</div>',
    '<div class=\'gmail_signature\' data-smartmail="gmail_signature">',
    '<div dir="ltr">Best,<br><br>Alex<div><img src="https://ci3.googleusercontent.com/mail-sig/image"></div></div>',
    "</div>",
    '<div class="gmail_quote">Quoted reply</div>',
  ].join("");
  const signature = extractGmailSignature(relatedHtml);
  assert.match(signature, /^<div class='gmail_signature'/);
  assert.match(signature, /ci3\.googleusercontent\.com/);
  assert.doesNotMatch(signature, /gmail_quote/);
});

test("extractGmailSignature removes quoted signatures and finds an own signature after the quote", () => {
  const quotedOnly = [
    '<section class="gmail_quote"><div class="gmail_signature">Correspondent</div></section>',
    '<blockquote><div class="gmail_signature">Earlier correspondent</div></blockquote>',
  ].join("");
  assert.equal(extractGmailSignature(quotedOnly), null);
  const ownAfterQuote = `${quotedOnly}<div class="gmail_signature"><div>Best,<br>Alex</div></div>`;
  assert.equal(
    extractGmailSignature(ownAfterQuote),
    '<div class="gmail_signature"><div>Best,<br>Alex</div></div>',
  );
});

test("signature cache writes metadata atomically and loads through an explicit data dir", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-signature-"));
  const html = '<div class="gmail_signature">Alex</div>';
  writeSignature({
    dataDir,
    html,
    metadata: {
      sendAsEmail: "alex@example.com",
      fetchedAt: "2026-08-05T12:00:00.000Z",
      sourceMessageId: "sent-1",
    },
  });
  assert.deepEqual(loadSignature(dataDir), {
    html,
    fetchedAt: "2026-08-05T12:00:00.000Z",
    sendAsEmail: "alex@example.com",
  });
  assert.deepEqual(JSON.parse(readFileSync(path.join(dataDir, "signature.json"), "utf8")), {
    sendAsEmail: "alex@example.com",
    fetchedAt: "2026-08-05T12:00:00.000Z",
    sourceMessageId: "sent-1",
    htmlSha256: createHash("sha256").update(html).digest("hex"),
  });
});

test("signature cache is bound to its normalized Gmail account identity", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-signature-account-"));
  writeSignature({
    dataDir,
    html: '<div class="gmail_signature">Alex</div>',
    metadata: {
      sendAsEmail: "Alex@Example.com",
      fetchedAt: "2026-08-05T12:00:00.000Z",
      sourceMessageId: "sent-account",
    },
  });
  assert.equal(loadSignature(dataDir, "other@example.com"), null);
  assert.equal(loadSignature(dataDir, "alex@example.com")?.sendAsEmail, "alex@example.com");
});

test("signature cache fails closed when required metadata is incomplete", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-signature-invalid-"));
  writeFileSync(path.join(dataDir, "signature.html"), '<div class="gmail_signature">Alex</div>');
  writeFileSync(path.join(dataDir, "signature.json"), JSON.stringify({
    fetchedAt: "2026-08-05T12:00:00.000Z",
  }));
  assert.equal(loadSignature(dataDir), null);
});

test("signature cache detects interrupted pairs and rejects cid images", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-signature-integrity-"));
  writeSignature({
    dataDir,
    html: '<div class="gmail_signature">Alex</div>',
    metadata: {
      sendAsEmail: "alex@example.com",
      fetchedAt: "2026-08-05T12:00:00.000Z",
      sourceMessageId: "sent-1",
    },
  });
  writeFileSync(path.join(dataDir, "signature.html"), '<div class="gmail_signature">Changed</div>');
  assert.equal(loadSignature(dataDir), null);
  assert.throws(() => writeSignature({
    dataDir,
    html: '<div class="gmail_signature"><img src="cid:logo"></div>',
    metadata: {
      sendAsEmail: "alex@example.com",
      fetchedAt: "2026-08-05T12:00:00.000Z",
      sourceMessageId: "sent-2",
    },
  }), /cid:/);
});

test("signature cache rejects executable signature HTML at write time", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-signature-unsafe-"));
  const metadata = {
    sendAsEmail: "alex@example.com",
    fetchedAt: "2026-08-05T12:00:00.000Z",
    sourceMessageId: "sent-unsafe",
  };
  assert.throws(
    () => writeSignature({ dataDir, html: '<div><script>alert(1)</script></div>', metadata }),
    /script elements/,
  );
  assert.throws(
    () => writeSignature({ dataDir, html: '<div onclick="alert(1)">Alex</div>', metadata }),
    /event-handler attributes/,
  );
  assert.throws(
    () => writeSignature({ dataDir, html: '<div><a href="javascript:alert(1)">Alex</a></div>', metadata }),
    /javascript: URLs/,
  );
  assert.throws(
    () => writeSignature({ dataDir, html: '<svg/onload=alert(1)>Alex</svg>', metadata }),
    /event-handler attributes/,
  );
  assert.throws(
    () => writeSignature({ dataDir, html: '<a href="java&#x73;cript:alert(1)">Alex</a>', metadata }),
    /javascript: URLs/,
  );
  for (const html of [
    '<a href="java&#x09;script:alert(1)">Alex</a>',
    '<a href="java&Tab;script&colon;alert(1)">Alex</a>',
    '<a href="java&NewLine;script:alert(1)">Alex</a>',
  ]) {
    assert.throws(
      () => writeSignature({ dataDir, html, metadata }),
      /javascript: URLs/,
    );
  }
});

test("signature cache rejects control-obfuscated javascript URLs on load", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-signature-legacy-unsafe-"));
  const html = '<a href="java&#x0a;script:alert(1)">Alex</a>';
  writeFileSync(path.join(dataDir, "signature.html"), html);
  writeFileSync(path.join(dataDir, "signature.json"), JSON.stringify({
    sendAsEmail: "alex@example.com",
    fetchedAt: "2026-08-05T12:00:00.000Z",
    sourceMessageId: "sent-legacy-unsafe",
    htmlSha256: createHash("sha256").update(html).digest("hex"),
  }));

  assert.equal(loadSignature(dataDir, "alex@example.com"), null);
});
