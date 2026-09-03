import assert from "node:assert/strict";
import test from "node:test";
import {
  GranolaApiError,
  createGranolaClient,
  granolaNoteRevisionHash,
  granolaNoteToMeetingInput,
} from "../src/lib/intake/granola-source.ts";

function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

test("Granola client carries updated_after and opaque cursor pagination", async () => {
  const calls = [];
  const pages = [
    response({
      notes: [{
        id: "not_1",
        title: "First",
        owner: { name: "Alex", email: "alex@example.com" },
        created_at: "2026-09-01T10:00:00.000Z",
        updated_at: "2026-09-01T11:00:00.000Z",
      }],
      hasMore: true,
      cursor: "opaque+/=cursor",
    }),
    response({ notes: [], hasMore: false, cursor: "finished" }),
  ];
  const client = createGranolaClient({
    apiKey: "test-key",
    baseUrl: "https://granola.test/v1",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return pages.shift();
    },
  });
  const first = await client.listNotes({
    updatedAfter: "2026-09-01T00:00:00.000Z",
    pageSize: 30,
  });
  const second = await client.listNotes({
    updatedAfter: "2026-09-01T00:00:00.000Z",
    pageSize: 30,
    cursor: first.cursor,
  });
  assert.equal(first.hasMore, true);
  assert.equal(second.hasMore, false);
  assert.match(calls[0].url, /updated_after=2026-09-01T00%3A00%3A00\.000Z/);
  assert.match(calls[1].url, /cursor=opaque%2B%2F%3Dcursor/);
  assert.equal(calls[0].init.headers.Authorization, "Bearer test-key");
  assert.equal(calls[0].init.signal instanceof AbortSignal, true);
});

test("Granola boundary accepts snake-case pagination and absent people fields", async () => {
  const responses = [
    response({
      notes: [{
        id: "not_sparse",
        title: "Sparse response",
        created_at: "2026-09-01T10:00:00.000Z",
        updated_at: "2026-09-01T11:00:00.000Z",
      }],
      has_more: true,
      next_cursor: "snake-cursor",
    }),
    response({
      id: "not_sparse",
      title: "Sparse response",
      created_at: "2026-09-01T10:00:00.000Z",
      updated_at: "2026-09-01T11:00:00.000Z",
      summary_text: "A complete summary.",
      web_url: "https://app.granola.ai/notes/not_sparse",
    }),
  ];
  const client = createGranolaClient({
    apiKey: "test-key",
    fetchImpl: async () => responses.shift(),
  });
  const page = await client.listNotes({
    updatedAfter: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(page.hasMore, true);
  assert.equal(page.cursor, "snake-cursor");
  assert.equal(page.notes[0].owner, undefined);
  const note = await client.getNote("not_sparse");
  assert.equal(note.owner, undefined);
  assert.deepEqual(note.attendees, []);
});

test("Granola client exposes 401 without leaking the key", async () => {
  const client = createGranolaClient({
    apiKey: "do-not-leak",
    fetchImpl: async () => response({ error: "expired" }, 401),
  });
  await assert.rejects(
    client.getNote("not_expired"),
    (error) => {
      assert.equal(error instanceof GranolaApiError, true);
      assert.equal(error.status, 401);
      assert.match(error.message, /HTTP 401/);
      assert.doesNotMatch(error.message, /do-not-leak/);
      return true;
    },
  );
});

test("Granola client honours Retry-After once for a 429", async () => {
  let calls = 0;
  const client = createGranolaClient({
    apiKey: "test-key",
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? response({ error: "slow down" }, 429, { "retry-after": "0" })
        : response({ notes: [], hasMore: false });
    },
  });
  const page = await client.listNotes({
    updatedAfter: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(page.hasMore, false);
  assert.equal(calls, 2);
});

test("Granola client caps Retry-After at ten seconds", async () => {
  let calls = 0;
  const delays = [];
  const client = createGranolaClient({
    apiKey: "test-key",
    sleepImpl: async (ms) => delays.push(ms),
    fetchImpl: async () => {
      calls += 1;
      return calls === 1
        ? response({ error: "slow down" }, 429, { "retry-after": "90" })
        : response({ notes: [], hasMore: false });
    },
  });
  await client.listNotes({ updatedAfter: "2026-09-01T00:00:00.000Z" });
  assert.equal(delays[0], 10_000);
});

test("Granola mapping uses meeting time, includes private notes and source, and caps the body", () => {
  const note = {
    id: "not_mapping",
    title: null,
    owner: { name: "Alex Martin", email: "owner@example.com" },
    attendees: [{ name: "Sam", email: "sam@example.com" }],
    created_at: "2026-09-01T10:00:00.000Z",
    updated_at: "2026-09-02T10:00:00.000Z",
    summary_markdown: "S".repeat(20_050),
    summary_text: "unused",
    private_notes_markdown: "Call Sam tomorrow.",
    private_notes_text: null,
    calendar_event: {
      event_title: "Calendar title",
      scheduled_start_time: "2026-09-01T09:00:00.000Z",
      scheduled_end_time: "2026-09-01T09:45:00.000Z",
    },
    web_url: "https://app.granola.ai/notes/not_mapping",
  };
  const input = granolaNoteToMeetingInput(note);
  assert.equal(input.messageId, "granola:not_mapping");
  assert.equal(input.threadId, input.messageId);
  assert.equal(input.subject, "Calendar title");
  assert.equal(input.receivedAt, "2026-09-01T09:00:00.000Z");
  assert.equal(input.durationMinutes, 45);
  assert.equal(input.fragment, false);
  assert.equal(input.artifactUrl, note.web_url);
  assert.equal(input.body.length, 20_000);
  assert.match(input.body, /\[Content truncated by Cove\.\]/);
  assert.ok(input.body.endsWith(`Source: ${note.web_url}`));
  assert.deepEqual(input.attendees, [
    { name: "Sam", email: "sam@example.com" },
    { name: "Alex Martin", email: "owner@example.com" },
  ]);
  assert.equal(granolaNoteRevisionHash(note).length, 64);
});
