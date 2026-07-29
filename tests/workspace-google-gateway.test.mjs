import assert from "node:assert/strict";
import test from "node:test";
import {
  GOOGLE_SCOPES,
  scopesForConfig,
  WorkspaceGatewayError,
} from "../src/lib/workspace/index.ts";
import { createGoogleWorkspaceGateway } from "../src/lib/workspace/google/gateway.ts";
import { buildReplyMime } from "../src/lib/workspace/google/mime.ts";

const config = {
  version: 1,
  provider: "google-api",
  profileId: "primary",
  accountEmail: "alex@example.com",
  oauthClientId: "client.apps.googleusercontent.com",
  capabilities: { mail: true, calendar: true, documents: true },
  calendarId: "primary",
  supportDraftRecipients: ["support@example.com"],
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("OAuth scopes are fixed by capabilities, not caller input", () => {
  assert.deepEqual(scopesForConfig(config), [
    GOOGLE_SCOPES.mail,
    GOOGLE_SCOPES.calendar,
    GOOGLE_SCOPES.documents,
  ]);
});

test("restricted gateway exposes no send, delete, trash, forward, raw request, or token method", () => {
  const gateway = createGoogleWorkspaceGateway({
    config,
    tokenProvider: {
      getAccessToken: async () => "access",
      invalidate() {},
    },
    fetch: async () => json({}),
  });
  const methods = new Set();
  let prototype = Object.getPrototypeOf(gateway.mail);
  while (prototype && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) methods.add(name);
    prototype = Object.getPrototypeOf(prototype);
  }
  const publicNames = [...methods].filter((name) => name !== "constructor");
  for (const forbidden of ["send", "delete", "trash", "forward", "request", "token"]) {
    assert.equal(
      publicNames.some((name) => name.toLowerCase().includes(forbidden)),
      false,
      `${forbidden} leaked through ${publicNames.join(", ")}`,
    );
  }
  assert.deepEqual(Object.keys(gateway.mail), ["accountEmail"]);
  assert.equal("transport" in gateway.mail, false);
  assert.equal("tokens" in gateway.mail, false);
});

test("archive removes INBOX from exact messages and does not add workflow labels", async () => {
  const calls = [];
  const gateway = createGoogleWorkspaceGateway({
    config,
    tokenProvider: {
      getAccessToken: async () => "access",
      invalidate() {},
    },
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return String(url).endsWith("/profile")
        ? json({ emailAddress: "alex@example.com" })
        : json({});
    },
  });
  await gateway.mail.archiveMessages({ messageIds: ["m-1", "m-2"] });
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/profile$/);
  for (const call of calls.slice(1)) {
    assert.match(call.url, /\/messages\/m-[12]\/modify$/);
    assert.deepEqual(JSON.parse(call.init.body), {
      addLabelIds: [],
      removeLabelIds: ["INBOX"],
    });
  }
});

test("calendar preserves the real Google Meet URL and self attendee state", async () => {
  const gateway = createGoogleWorkspaceGateway({
    config,
    tokenProvider: {
      getAccessToken: async () => "access",
      invalidate() {},
    },
    fetch: async (url) => {
      const target = String(url);
      if (target.endsWith("/profile")) {
        return json({ emailAddress: "alex@example.com" });
      }
      if (target.includes("/calendar/v3/calendars/primary/events")) {
        return json({
          items: [{
            id: "strategy",
            status: "confirmed",
            summary: "Strategy call",
            htmlLink: "https://calendar.google.com/calendar/event?eid=strategy",
            hangoutLink: "https://meet.google.com/abc-defg-hij",
            start: { dateTime: "2026-11-01T09:00:00-08:00" },
            end: { dateTime: "2026-11-01T09:30:00-08:00" },
            attendees: [{
              email: "alex@example.com",
              self: true,
              responseStatus: "accepted",
            }],
          }],
        });
      }
      return json({});
    },
  });
  const events = await gateway.calendar.listEvents({
    timeMin: "2026-11-01T00:00:00-07:00",
    timeMax: "2026-11-08T00:00:00-08:00",
    timeZone: "America/Los_Angeles",
  });
  assert.equal(events[0].htmlLink, "https://calendar.google.com/calendar/event?eid=strategy");
  assert.equal(events[0].meetingUrl, "https://meet.google.com/abc-defg-hij");
  assert.deepEqual(events[0].attendees, [{
    email: "alex@example.com",
    responseStatus: "accepted",
    self: true,
  }]);
});

test("free-form and workflow label creation is rejected before network access", async () => {
  let fetched = false;
  const gateway = createGoogleWorkspaceGateway({
    config,
    tokenProvider: {
      getAccessToken: async () => "access",
      invalidate() {},
    },
    fetch: async () => {
      fetched = true;
      return json({});
    },
  });
  for (const name of ["Client/Acme", "Cove/Reply", "Cove/Done"]) {
    await assert.rejects(
      gateway.mail.ensureCoveLabel({ name }),
      (error) => error instanceof WorkspaceGatewayError && error.code === "unsafe_operation",
    );
  }
  assert.equal(fetched, false);
});

test("ambiguous draft HTTP failures become unknown outcomes and are never blind-retried", async () => {
  let draftPosts = 0;
  const gateway = createGoogleWorkspaceGateway({
    config,
    tokenProvider: {
      getAccessToken: async () => "access",
      invalidate() {},
    },
    fetch: async (url, init) => {
      const target = String(url);
      if (target.endsWith("/profile")) {
        return json({ emailAddress: "alex@example.com" });
      }
      if (target.includes("/messages/source-message")) {
        return json({
          id: "source-message",
          threadId: "thread-1",
          labelIds: ["INBOX"],
          internalDate: "1000",
          payload: {
            headers: [
              { name: "Message-ID", value: "<source@example.com>" },
              { name: "From", value: "Person <person@example.com>" },
              { name: "Subject", value: "Hello" },
            ],
          },
        });
      }
      if (target.endsWith("/drafts") && init?.method === "POST") {
        draftPosts += 1;
        return json({ error: "timeout" }, 503);
      }
      return json({});
    },
  });
  await assert.rejects(
    gateway.mail.createReplyDraft({
      threadId: "thread-1",
      sourceMessageId: "source-message",
      body: "Thanks.",
      idempotencyKey: "reply:thread-1:v1",
    }),
    (error) =>
      error instanceof WorkspaceGatewayError &&
      error.code === "unknown_write_outcome",
  );
  assert.equal(draftPosts, 1);
});

test("reply MIME rejects header injection and carries a deterministic operation marker", () => {
  assert.throws(() => buildReplyMime({
    to: "victim@example.com\r\nBcc: attacker@example.com",
    subject: "Hello",
    body: "Body",
    inReplyTo: "<source@example.com>",
    references: [],
    idempotencyKey: "reply:thread:v1",
    accountEmail: "alex@example.com",
  }));
  const first = buildReplyMime({
    to: "person@example.com",
    subject: "Hello",
    body: "Body",
    inReplyTo: "<source@example.com>",
    references: [],
    idempotencyKey: "reply:thread:v1",
    accountEmail: "alex@example.com",
  });
  const second = buildReplyMime({
    to: "person@example.com",
    subject: "Hello",
    body: "Body",
    inReplyTo: "<source@example.com>",
    references: [],
    idempotencyKey: "reply:thread:v1",
    accountEmail: "alex@example.com",
  });
  assert.equal(first, second);
  assert.match(Buffer.from(first, "base64url").toString("utf8"), /X-Cove-Operation-Id: reply:thread:v1/);
});
