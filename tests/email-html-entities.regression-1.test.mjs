/**
 * An HTML-only email must reach the classifier as the text a person would read.
 *
 * The gateway strips the tags off an HTML body but left the character entities
 * encoded, so the model was shown `I&#39;ll send the deck Friday`. That text is
 * also the evidence a quoted commitment is checked against, and a model that
 * writes the apostrophe in its quote fails that check — so the commitment was
 * dropped with nothing recorded anywhere.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createGoogleWorkspaceGateway } from "../src/lib/workspace/google/gateway.ts";

const config = {
  version: 1,
  provider: "google-api",
  profileId: "primary",
  accountEmail: "gary@example.com",
  oauthClientId: "client.apps.googleusercontent.com",
  capabilities: { mail: true, calendar: false, documents: false },
  calendarId: "primary",
  supportDraftRecipients: [],
};

const HTML_BODY =
  "<div><p>Hi Gary,</p><p>I&#39;ll send the deck Friday &amp; the pricing" +
  "&nbsp;sheet with it. Ben&rsquo;s team needs it before 5&nbsp;pm.</p>" +
  "<style>p { color: red }</style></div>";

function gatewayReturning(payload) {
  return createGoogleWorkspaceGateway({
    config,
    tokenProvider: {
      getAccessToken: async () => "access",
      invalidate() {},
    },
    fetch: async (url) => {
      const text = String(url);
      if (text.includes("/userinfo") || text.includes("/tokeninfo") || text.includes("profile")) {
        return new Response(JSON.stringify({ emailAddress: config.accountEmail }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
}

test("an HTML-only email arrives decoded, so a quoted commitment can match it", async () => {
  const gateway = gatewayReturning({
    id: "message-1",
    threadId: "thread-1",
    snippet: "Hi Gary,",
    internalDate: "1758000000000",
    payload: {
      mimeType: "text/html",
      headers: [{ name: "Subject", value: "The deck" }],
      body: { data: Buffer.from(HTML_BODY, "utf8").toString("base64url") },
    },
  });

  const message = await gateway.mail.getMessage({ messageId: "message-1" });

  assert.match(message.text, /I'll send the deck Friday & the pricing sheet with it\./);
  assert.match(message.text, /Ben’s team needs it before 5 pm\./);
  assert.equal(message.text.includes("&#39;"), false);
  assert.equal(message.text.includes("&nbsp;"), false);
  assert.equal(message.text.includes("&amp;"), false);
  assert.equal(message.text.includes("color: red"), false, "style blocks are still removed");

  // This is the check the classification lane makes before it keeps a
  // commitment: the model's quote has to appear in the mail.
  const evidence = message.text.replace(/\s+/g, " ").trim().toLowerCase();
  assert.ok(
    evidence.includes("i'll send the deck friday".toLowerCase()),
    "the quote a model would write is found in the evidence",
  );
});

test("a decoded entity cannot reintroduce a tag", async () => {
  const gateway = gatewayReturning({
    id: "message-2",
    threadId: "thread-2",
    snippet: "",
    internalDate: "1758000000000",
    payload: {
      mimeType: "text/html",
      headers: [],
      body: {
        data: Buffer.from(
          "<p>&lt;script&gt;alert(1)&lt;/script&gt; and &lt;b&gt;bold&lt;/b&gt;</p>",
          "utf8",
        ).toString("base64url"),
      },
    },
  });

  const message = await gateway.mail.getMessage({ messageId: "message-2" });
  assert.equal(message.text, "<script>alert(1)</script> and <b>bold</b>");
});
