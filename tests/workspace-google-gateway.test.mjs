import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  GOOGLE_SCOPES,
  scopesForConfig,
  WorkspaceGatewayError,
} from "../src/lib/workspace/index.ts";
import { createGoogleWorkspaceGateway } from "../src/lib/workspace/google/gateway.ts";
import {
  buildReplyMime,
  deterministicMessageId,
} from "../src/lib/workspace/google/mime.ts";

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

test("gateway preserves threadId and passes both reply alternatives into Gmail MIME", async () => {
  let postedMessage;
  const gateway = createGoogleWorkspaceGateway({
    config,
    tokenProvider: {
      getAccessToken: async () => "access",
      invalidate() {},
    },
    fetch: async (url, init) => {
      const target = String(url);
      if (target.endsWith("/profile")) return json({ emailAddress: "alex@example.com" });
      if (target.includes("/messages/source-rich")) {
        return json({
          id: "source-rich",
          threadId: "thread-rich",
          labelIds: ["INBOX"],
          internalDate: "1000",
          payload: {
            headers: [
              { name: "Message-ID", value: "<source-rich@example.com>" },
              { name: "From", value: "Person <person@example.com>" },
              { name: "Subject", value: "Rich reply" },
            ],
          },
        });
      }
      if (target.endsWith("/drafts") && init?.method === "POST") {
        postedMessage = JSON.parse(init.body).message;
        return json({
          id: "draft-rich",
          message: { id: "draft-message-rich", threadId: "thread-rich" },
        });
      }
      return json({});
    },
  });
  await gateway.mail.createReplyDraft({
    threadId: "thread-rich",
    sourceMessageId: "source-rich",
    body: "Plain reply.",
    htmlBody: '<div dir="ltr"><div><b>Rich</b> reply.</div></div>',
    idempotencyKey: "reply:thread-rich:v1",
  });
  assert.equal(postedMessage.threadId, "thread-rich");
  const decoded = decodedMultipart(Buffer.from(postedMessage.raw, "base64url").toString("utf8"));
  assert.equal(decoded.parts[0].text, "Plain reply.");
  assert.equal(decoded.parts[1].text, '<div dir="ltr"><div><b>Rich</b> reply.</div></div>');
});

test("gateway updates the exact existing Gmail draft when requested", async () => {
  let update;
  const gateway = createGoogleWorkspaceGateway({
    config,
    tokenProvider: { getAccessToken: async () => "access", invalidate() {} },
    fetch: async (url, init) => {
      const target = String(url);
      if (target.endsWith("/profile")) return json({ emailAddress: "alex@example.com" });
      if (target.includes("/messages/source-update")) {
        return json({
          id: "source-update", threadId: "thread-update", labelIds: ["INBOX"],
          internalDate: "1000",
          payload: { headers: [
            { name: "Message-ID", value: "<source-update@example.com>" },
            { name: "From", value: "Person <person@example.com>" },
            { name: "Subject", value: "Update reply" },
          ] },
        });
      }
      if (target.endsWith("/drafts/draft-update") && init?.method === "PUT") {
        update = JSON.parse(init.body);
        return json({ id: "draft-update", message: { id: "draft-message-update", threadId: "thread-update" } });
      }
      return json({});
    },
  });
  await gateway.mail.createReplyDraft({
    threadId: "thread-update", sourceMessageId: "source-update", body: "Updated.",
    idempotencyKey: "reply:thread-update:v2", existingDraftId: "draft-update",
  });
  assert.equal(update.message.threadId, "thread-update");
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

function decodedMultipart(raw) {
  const headerEnd = raw.indexOf("\r\n\r\n");
  const headers = raw.slice(0, headerEnd).split("\r\n");
  const boundary = /boundary="([^"]+)"/.exec(headers.at(-1))?.[1];
  assert.ok(boundary);
  const chunks = raw.slice(headerEnd + 4).split(`--${boundary}`).slice(1);
  const parts = [];
  for (const chunk of chunks) {
    if (chunk.startsWith("--")) break;
    const value = chunk.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const [partHeaders, encoded] = value.split("\r\n\r\n");
    parts.push({
      headers: partHeaders.split("\r\n"),
      encodedLines: encoded.split("\r\n"),
      text: Buffer.from(encoded.replace(/\r\n/g, ""), "base64").toString("utf8"),
    });
  }
  return { boundary, headers, parts };
}

test("reply MIME is deterministic multipart alternative with preserved threading headers", () => {
  const input = {
    to: "person@example.com",
    subject: "Planning 👋",
    body: "First paragraph.\n\n- One\n- Two",
    htmlBody: '<div dir="ltr"><div>First paragraph.</div><div><br></div><div>- One<br>- Two</div></div>',
    inReplyTo: "<source@example.com>",
    references: ["<older@example.com>", "<source@example.com>"],
    idempotencyKey: "reply:thread:v2",
    accountEmail: "alex@example.com",
  };
  const first = buildReplyMime(input);
  const second = buildReplyMime(input);
  assert.equal(first, second);
  const raw = Buffer.from(first, "base64url").toString("utf8");
  assert.equal(raw.replace(/\r\n/g, "").includes("\n"), false);
  const decoded = decodedMultipart(raw);
  assert.equal(decoded.parts.length, 2);
  assert.match(decoded.boundary, /^=_cove_[0-9a-f]{32}$/);
  assert.deepEqual(decoded.headers, [
    "To: person@example.com",
    "Subject: =?UTF-8?B?UmU6IFBsYW5uaW5nIPCfkYs=?=",
    `Message-ID: ${deterministicMessageId(input.idempotencyKey, input.accountEmail)}`,
    "In-Reply-To: <source@example.com>",
    "References: <older@example.com> <source@example.com>",
    "X-Cove-Operation-Id: reply:thread:v2",
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${decoded.boundary}"`,
  ]);
  assert.deepEqual(decoded.parts[0].headers, [
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ]);
  assert.deepEqual(decoded.parts[1].headers, [
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ]);
  assert.equal(decoded.parts[0].text, "First paragraph.\r\n\r\n- One\r\n- Two");
  assert.equal(decoded.parts[1].text, input.htmlBody);
  for (const part of decoded.parts) {
    assert.ok(part.encodedLines.every((line) => line.length > 0 && line.length <= 76));
  }
  assert.notEqual(
    decoded.boundary,
    decodedMultipart(Buffer.from(buildReplyMime({ ...input, idempotencyKey: "reply:thread:v3" }), "base64url").toString("utf8")).boundary,
  );
});

test("reply MIME base64 wrapping preserves a 2000-character logical line", () => {
  const body = "x".repeat(2_000);
  const raw = Buffer.from(buildReplyMime({
    to: "person@example.com",
    subject: "Long line",
    body,
    inReplyTo: "<source@example.com>",
    references: [],
    idempotencyKey: "reply:long-line:v1",
    accountEmail: "alex@example.com",
  }), "base64url").toString("utf8");
  const decoded = decodedMultipart(raw);
  assert.equal(decoded.parts[0].text, body);
  assert.ok(decoded.parts[0].encodedLines.length > 20);
  assert.ok(decoded.parts[0].encodedLines.every((line) => line.length <= 76));
});

test("connecting Google reads the configured data directory, not <repo>/data", () => {
  // CONFIGURATION.md offers COVE_DATA_DIR and the installer writes the resolved
  // directory into every LaunchAgent, so an operator who moved Cove's private
  // data has services reading one place. The connect script used to hard-code
  // <repo>/data: the browser consent succeeded, the Keychain entries were
  // written, and Cove still reported no email connected, with nothing saying why.
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cove-google-connect-"));
  try {
    copyFileSync(
      path.join(process.cwd(), "data", "cove-workspace.example.json"),
      path.join(dataDir, "cove-workspace.json"),
    );
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", path.join(process.cwd(), "scripts", "cove-google-connect.ts"), "status"],
      { cwd: process.cwd(), env: { ...process.env, COVE_DATA_DIR: dataDir }, encoding: "utf8" },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    // "not connected" means it never found the config that is sitting right there.
    assert.doesNotMatch(
      output,
      /Google Workspace is not connected\./,
      `the connect script ignored COVE_DATA_DIR: ${output.trim()}`,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
