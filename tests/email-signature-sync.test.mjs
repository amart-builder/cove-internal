import assert from "node:assert/strict";
import test from "node:test";
import {
  htmlParts,
  selectOperatorSignature,
} from "../scripts/cove-signature-sync.ts";

test("signature sync selection ignores signatures inside Gmail quote containers", () => {
  const selected = selectOperatorSignature([{
    sourceMessageId: "sent-quoted",
    html: [
      '<div class="gmail_quote"><div class="gmail_signature">Alex Correspondent</div></div>',
      '<blockquote><div class="gmail_signature">Alex Earlier</div></blockquote>',
    ],
  }], "Alex");
  assert.equal(selected, null);
});

test("signature sync selection finds the operator signature after a quoted thread", () => {
  const own = '<div class="gmail_signature"><div>Best,<br><br>Alex<br>Edge AI</div></div>';
  const selected = selectOperatorSignature([{
    sourceMessageId: "sent-own",
    html: [
      '<div>Reply</div><div class="gmail_quote"><div class="gmail_signature">Other Person</div></div>' + own,
    ],
  }], "Alex");
  assert.deepEqual(selected, { html: own, sourceMessageId: "sent-own" });
});

test("signature sync skips mismatches and selects the next operator signature", () => {
  const own = '<div class="gmail_signature">Best,<br>Alex</div>';
  assert.deepEqual(selectOperatorSignature([{
    sourceMessageId: "sent-wrong",
    html: ['<div class="gmail_signature">Best,<br>Someone Else</div>'],
  }, {
    sourceMessageId: "sent-own-next",
    html: [own],
  }], "Alex"), { html: own, sourceMessageId: "sent-own-next" });
  assert.equal(selectOperatorSignature([{
    sourceMessageId: "sent-wrong-only",
    html: ['<div class="gmail_signature">Best,<br>Someone Else</div>'],
  }], "Alex"), null);
});

test("signature sync requires a configured operator name", () => {
  for (const operator of ["", "   ", "the operator", "THE OPERATOR"]) {
    assert.throws(
      () => selectOperatorSignature([], operator),
      /configure your operator name first/i,
    );
  }
});

test("signature sync finds HTML nested inside multipart related payloads", () => {
  const html = '<div class="gmail_signature">Alex</div>';
  assert.deepEqual(htmlParts({
    mimeType: "multipart/related",
    parts: [{
      mimeType: "text/html",
      body: { data: Buffer.from(html).toString("base64url") },
    }, {
      mimeType: "image/png",
      body: { attachmentId: "image-1" },
    }],
  }), [html]);
});
