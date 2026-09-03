import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  main as meetingWatchMain,
  readMeetingState,
  runGranolaPoll,
  runMeetingAnalysisDrain,
  runMeetingWatch,
  shouldRecordMeetingWatchReceipt,
  writeMeetingState,
} from "../scripts/cove-meeting-watch.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

test("meeting watcher skips the receipt for a no-op run", () => {
  assert.equal(shouldRecordMeetingWatchReceipt({ processed: 0, errors: 0 }), false);
  assert.equal(shouldRecordMeetingWatchReceipt({ processed: 1, errors: 0 }), true);
  assert.equal(shouldRecordMeetingWatchReceipt({ processed: 0, errors: 1 }), true);
});

function fixture(t, meeting = {}) {
  const dir = path.join(
    os.tmpdir(),
    `cove-meeting-watch-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, "cove-meetings.json");
  const emailConfigPath = path.join(dir, "cove-workspace.json");
  const statePath = path.join(dir, "meeting-state.json");
  const heartbeatPath = path.join(dir, "intake", "heartbeats.json");
  writeFileSync(configPath, JSON.stringify({
    enabled: true,
    active_tools: ["gemini"],
    window: "newer_than:4d",
    processed_label: "Cove/Meeting-Processed",
    custom_patterns: [],
    ...meeting,
  }));
  writeFileSync(emailConfigPath, JSON.stringify({
    version: 1,
    provider: "google-api",
    account_email: "alex@example.com",
    cove_url: "http://127.0.0.1:3200",
  }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, configPath, emailConfigPath, statePath, heartbeatPath };
}

function message(format) {
  return {
    id: "message-1",
    threadId: "thread-1",
    labelIds: ["INBOX"],
    internalDate: "1000",
    snippet: "Meeting notes",
    headers: [
      { name: "From", value: "Gemini <gemini-noreply@google.com>" },
      { name: "Subject", value: "Notes: Client planning" },
    ],
    text: format === "full"
      ? "Meeting notes\n\nNext steps:\n- Alex: Send the proposal"
      : "",
  };
}

function gateway(overrides = {}) {
  const calls = [];
  return {
    calls,
    mail: {
      listMessages: async (input) => {
        calls.push(["listMessages", input]);
        return { messages: [{ id: "message-1", threadId: "thread-1" }] };
      },
      getMessage: async (input) => {
        calls.push(["getMessage", input]);
        return message(input.format);
      },
      ensureCoveLabel: async (input) => {
        calls.push(["ensureCoveLabel", input]);
        return { id: "label-meeting", name: input.name };
      },
      modifyThreadLabels: async (input) => {
        calls.push(["modifyThreadLabels", input]);
      },
      archiveMessages: async (input) => {
        calls.push(["archiveMessages", input]);
      },
      ...overrides,
    },
  };
}

function runOptions(files, mail, extra = {}) {
  return {
    configPath: files.configPath,
    emailConfigPath: files.emailConfigPath,
    statePath: files.statePath,
    heartbeatPath: files.heartbeatPath,
    dataDir: files.dir,
    dbPath: path.join(files.dir, "cove.db"),
    gateway: mail,
    machineIdentity: {
      id: "11111111-1111-4111-8111-111111111111",
      hostname: "test-mac",
    },
    now: () => new Date("2026-07-29T18:00:00.000Z"),
    ...extra,
  };
}

test("meeting watcher labels and archives each durably processed message exactly once", async (t) => {
  const files = fixture(t);
  const google = gateway();
  const result = await runMeetingWatch(runOptions(files, google.mail, {
    processMeetingEmail: async () => ({
      status: "processed",
      summary: { parsedItems: 1, tasks: 1, waitingOn: 0 },
      quietLine: "Client planning: 1 follow-up",
    }),
  }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.processed, 1);
  assert.match(
    google.calls.find(([name]) => name === "listMessages")[1].query,
    /newer_than:4d/,
  );
  assert.deepEqual(
    google.calls.find(([name]) => name === "modifyThreadLabels")[1],
    {
      threadId: "thread-1",
      addNames: ["Cove/Meeting-Processed"],
    },
  );
  assert.deepEqual(
    google.calls.filter(([name]) => name === "archiveMessages").map(([, input]) => input),
    [{ messageIds: ["message-1"] }],
  );
  assert.deepEqual(readMeetingState(files.statePath).processed_ids, ["message-1"]);
});

test("meeting drain runs only the local analysis sweep with legacy fallback wiring", async (t) => {
  const files = fixture(t);
  const sweeps = [];
  const result = await runMeetingAnalysisDrain({
    dataDir: files.dir,
    dbPath: path.join(files.dir, "cove.db"),
    baseUrl: "http://127.0.0.1:3200",
    now: () => new Date("2026-07-29T18:00:00.000Z"),
    runMeetingAnalysisSweepImpl: async (options) => {
      sweeps.push(options);
      return { processed: 0, failed: 0, dead: 0 };
    },
  });
  assert.deepEqual(result, { processed: 0, failed: 0, dead: 0 });
  assert.equal(sweeps.length, 1);
  assert.equal("mail" in sweeps[0], false);
  assert.equal(typeof sweeps[0].legacyFallback, "function");
  assert.equal(sweeps[0].dbPath, path.join(files.dir, "cove.db"));
});

test("drain-only CLI bypasses the Gmail watcher", async () => {
  let drainCalls = 0;
  const code = await meetingWatchMain(["--drain-only"], {
    runMeetingAnalysisDrainImpl: async () => {
      drainCalls += 1;
      return { processed: 0, failed: 0, dead: 0 };
    },
    runMeetingWatchImpl: async () => {
      throw new Error("Gmail watcher must not run");
    },
  });
  assert.equal(code, 0);
  assert.equal(drainCalls, 1);
});

test("already-failed meeting re-picks remain unlabeled and in the inbox", async (t) => {
  const files = fixture(t);
  const google = gateway();
  const result = await runMeetingWatch(runOptions(files, google.mail, {
    processMeetingEmail: async () => ({
      status: "skipped",
      reason: "already-failed",
      summary: { parsedItems: 0, tasks: 0, waitingOn: 0 },
    }),
    runMeetingAnalysisSweepImpl: async () => ({
      processed: 0,
      failed: 0,
      dead: 0,
    }),
  }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.processed, 0);
  assert.equal(
    google.calls.some(([name]) => name === "ensureCoveLabel"),
    false,
  );
  assert.equal(
    google.calls.some(([name]) => name === "modifyThreadLabels"),
    false,
  );
  assert.equal(
    google.calls.some(([name]) => name === "archiveMessages"),
    false,
  );
  assert.deepEqual(readMeetingState(files.statePath).processed_ids, []);
});

test("meeting analyst is the default live pipeline and its durable sweep runs in the watcher tick", async (t) => {
  const files = fixture(t);
  const google = gateway();
  const queued = [];
  const sweeps = [];
  const result = await runMeetingWatch(runOptions(files, google.mail, {
    queueMeetingEmail: async (email) => {
      queued.push(email);
      return {
        status: "processed",
        summary: { parsedItems: 0, tasks: 0, waitingOn: 0 },
        quietLine: "Meeting queued for deep analysis.",
      };
    },
    runMeetingAnalysisSweepImpl: async (options) => {
      sweeps.push(options);
      return { processed: 1, failed: 0, dead: 0 };
    },
  }));
  assert.equal(result.exitCode, 0);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].detectedTool, "gemini");
  assert.equal(Array.isArray(queued[0].headers), true);
  assert.equal(sweeps.length, 1);
});

test("the analyst off switch reverts the meeting pipeline wholesale to legacy extraction", async (t) => {
  const files = fixture(t);
  const google = gateway();
  let legacyCalls = 0;
  const result = await runMeetingWatch(runOptions(files, google.mail, {
    meetingAnalystEnabled: false,
    processMeetingEmail: async () => {
      legacyCalls += 1;
      return {
        status: "processed",
        summary: { parsedItems: 1, tasks: 1, waitingOn: 0 },
      };
    },
    runMeetingAnalysisSweepImpl: async () => {
      throw new Error("analyst sweep must stay off");
    },
  }));
  assert.equal(result.exitCode, 0);
  assert.equal(legacyCalls, 1);
  assert.equal(google.calls.filter(([name]) => name === "archiveMessages").length, 1);
});

test("dry run parses without labeling or changing state", async (t) => {
  const files = fixture(t);
  const google = gateway();
  const result = await runMeetingWatch(runOptions(files, google.mail, {
    dryRun: true,
    extractFollowUps: async () => [{
      owner: "Alex",
      title: "Send proposal",
      detail: "Send the revised proposal.",
    }],
  }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.parsed_items, 1);
  assert.equal(
    google.calls.some(([name]) => name === "modifyThreadLabels"),
    false,
  );
  assert.equal(
    google.calls.some(([name]) => name === "archiveMessages"),
    false,
  );
  assert.equal(readMeetingState(files.statePath).processed_ids.length, 0);
});

test("archive failure is logged without failing or retrying processed meeting mail", async (t) => {
  const files = fixture(t);
  const logs = [];
  const google = gateway({
    archiveMessages: async (input) => {
      google.calls.push(["archiveMessages", input]);
      throw new Error("archive offline");
    },
  });
  const result = await runMeetingWatch(runOptions(files, google.mail, {
    processMeetingEmail: async () => ({
      status: "processed",
      summary: { parsedItems: 1, tasks: 1, waitingOn: 0 },
    }),
    logArchiveFailure: (line) => logs.push(line),
  }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.processed, 1);
  assert.equal(result.summary.errors, 0);
  assert.equal(google.calls.filter(([name]) => name === "archiveMessages").length, 1);
  assert.match(logs[0], /message-1: archive offline/);
  assert.deepEqual(readMeetingState(files.statePath).processed_ids, ["message-1"]);
  const second = await runMeetingWatch(runOptions(files, google.mail, {
    processMeetingEmail: async () => {
      throw new Error("processed mail must not re-enter ingestion");
    },
    logArchiveFailure: (line) => logs.push(line),
  }));
  assert.equal(second.exitCode, 0);
  assert.equal(second.summary.processed, 0);
  assert.equal(google.calls.filter(([name]) => name === "archiveMessages").length, 1);
});

test("disabled meeting watch never touches Gmail", async (t) => {
  const files = fixture(t, { enabled: false });
  const google = gateway({
    listMessages: async () => {
      throw new Error("must not be called");
    },
  });
  const result = await runMeetingWatch(runOptions(files, google.mail));
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.examined, 0);
  assert.equal(JSON.parse(readFileSync(files.heartbeatPath, "utf8")).version, 2);
});

test("state writes are bounded and idempotently deduplicated", (t) => {
  const files = fixture(t);
  writeMeetingState(files.statePath, {
    processed_ids: ["a", "a", ...Array.from({ length: 600 }, (_, index) => `m-${index}`)],
    cursor_at: "2026-07-29T18:00:00.000Z",
    failures: {},
    dead_letters: [],
    granola: {
      watermark_at: null,
      list_cursor: null,
      pending_note_ids: [],
      revisions: Object.fromEntries(
        Array.from({ length: 600 }, (_, index) => [`not-${index}`, `hash-${index}`]),
      ),
      failures: {},
      dead_letters: [],
    },
  });
  const state = readMeetingState(files.statePath);
  assert.equal(state.processed_ids.length, 500);
  assert.equal(new Set(state.processed_ids).size, 500);
  assert.equal(Object.keys(state.granola.revisions).length, 500);
  assert.equal(state.granola.revisions["not-0"], undefined);
  assert.equal(state.granola.revisions["not-100"], "hash-100");
});

test("Google gateway failure exits nonzero and leaves the message unprocessed", async (t) => {
  const files = fixture(t);
  const error = new Error("Google unavailable");
  error.name = "WorkspaceGatewayError";
  const google = gateway({
    getMessage: async () => { throw error; },
  });
  const result = await runMeetingWatch(runOptions(files, google.mail));
  assert.equal(result.exitCode, 1);
  assert.equal(result.summary.processed, 0);
});

test("notification-only Gemini failure is labelled with a skip receipt and never analyzed", async (t) => {
  const files = fixture(t);
  const google = gateway({
    getMessage: async (input) => {
      google.calls.push(["getMessage", input]);
      return {
        ...message(input.format),
        headers: [
          { name: "From", value: "Gemini <gemini-noreply@google.com>" },
          { name: "Subject", value: "Gemini couldn't take notes for Client planning" },
        ],
        text: "",
      };
    },
  });
  let analyzed = 0;
  const receipts = [];
  const result = await runMeetingWatch(runOptions(files, google.mail, {
    queueMeetingEmail: async () => {
      analyzed += 1;
      throw new Error("notification stub must not be analyzed");
    },
    recordSkipReceiptImpl: (receipt) => receipts.push(receipt),
    runMeetingAnalysisSweepImpl: async () => ({ processed: 0, failed: 0, dead: 0 }),
  }));
  assert.equal(result.exitCode, 0);
  assert.equal(analyzed, 0);
  assert.equal(result.summary.processed, 1);
  assert.equal(receipts[0].summary,
    "meeting notification skipped; message contained no meeting notes");
  assert.equal(google.calls.filter(([name]) => name === "modifyThreadLabels").length, 1);
});

test("Granola notification mail is skipped in favor of the API", async (t) => {
  const files = fixture(t, {
    active_tools: ["granola"],
    granola: { enabled: true, owner_emails: ["alex@joinedgeai.com"] },
  });
  const google = gateway({
    getMessage: async (input) => {
      google.calls.push(["getMessage", input]);
      return {
        ...message(input.format),
        headers: [
          { name: "From", value: "Granola <notifications@mail.granola.ai>" },
          { name: "Subject", value: "Your Granola notes are ready" },
        ],
        text: "",
      };
    },
  });
  const receipts = [];
  const result = await runMeetingWatch(runOptions(files, google.mail, {
    granolaApiKey: "test-key",
    granolaClient: {
      listNotes: async () => ({ notes: [], hasMore: false }),
      getNote: async () => { throw new Error("no Granola notes expected"); },
    },
    queueMeetingEmail: async () => {
      throw new Error("Granola notification must not be analyzed");
    },
    recordSkipReceiptImpl: (receipt) => receipts.push(receipt),
    runMeetingAnalysisSweepImpl: async () => ({ processed: 0, failed: 0, dead: 0 }),
  }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.processed, 1);
  assert.equal(receipts[0].summary,
    "granola notification skipped; notes come from the Granola API");
});

test("Granola Gmail content uses the normal path when the API key is missing", async (t) => {
  const files = fixture(t, {
    active_tools: ["granola"],
    granola: { enabled: true, owner_emails: ["alex@joinedgeai.com"] },
  });
  const google = gateway({
    getMessage: async (input) => {
      google.calls.push(["getMessage", input]);
      return {
        ...message(input.format),
        headers: [
          { name: "From", value: "Granola <notifications@mail.granola.ai>" },
          { name: "Subject", value: "Your Granola notes are ready" },
        ],
        text: input.format === "full" ? "N".repeat(1_300) : "",
      };
    },
  });
  const receipts = [];
  let analyzed = 0;
  const result = await runMeetingWatch(runOptions(files, google.mail, {
    granolaApiKey: "",
    meetingAnalystEnabled: false,
    processMeetingEmail: async () => {
      analyzed += 1;
      return {
        status: "processed",
        summary: { parsedItems: 0, tasks: 0, waitingOn: 0 },
      };
    },
    recordSkipReceiptImpl: (receipt) => receipts.push(receipt),
  }));
  assert.equal(result.exitCode, 0);
  assert.equal(analyzed, 1);
  assert.equal(receipts.some((receipt) =>
    receipt.summary === "granola notification skipped; notes come from the Granola API"
  ), false);
});

test("Granola-only active tools leave Gemini outside the Gmail query", async (t) => {
  const files = fixture(t, {
    active_tools: ["granola"],
    granola: { enabled: true, owner_emails: ["alex@joinedgeai.com"] },
  });
  let query = "";
  const google = gateway({
    listMessages: async (input) => {
      query = input.query;
      return { messages: [] };
    },
    getMessage: async () => {
      throw new Error("Gemini email must not be fetched");
    },
  });
  const result = await runMeetingWatch(runOptions(files, google.mail, {
    runMeetingAnalysisSweepImpl: async () => ({ processed: 0, failed: 0, dead: 0 }),
  }));
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(query, /gemini/i);
  assert.equal(result.summary.examined, 0);
});

test("Granola API poll queues a complete note through the watcher door and persists state and heartbeat", async (t) => {
  const files = fixture(t, {
    active_tools: ["granola"],
    granola: { enabled: true, owner_emails: ["alex@joinedgeai.com"] },
  });
  const requests = [];
  const granolaPayload = (url) => {
    if (url.startsWith("/v1/notes?")) {
      return {
        notes: [{
          id: "not_real",
          title: "Client review",
          owner: { name: "Alex", email: "alex@joinedgeai.com" },
          created_at: "2026-07-29T16:00:00.000Z",
          updated_at: "2026-07-29T17:00:00.000Z",
        }],
        hasMore: false,
        cursor: "done",
      };
    }
    if (url === "/v1/notes/not_real") {
      return {
        id: "not_real",
        title: "Client review",
        owner: { name: "Alex", email: "alex@joinedgeai.com" },
        attendees: [{ name: "Sam", email: "sam@example.com" }],
        created_at: "2026-07-29T16:00:00.000Z",
        updated_at: "2026-07-29T17:00:00.000Z",
        summary_markdown: "We agreed the launch plan.",
        private_notes_markdown: "Follow up tomorrow.",
        calendar_event: {
          event_title: "Client review",
          scheduled_start_time: "2026-07-29T16:00:00.000Z",
          scheduled_end_time: "2026-07-29T16:30:00.000Z",
        },
        web_url: "https://app.granola.ai/notes/not_real",
      };
    }
    return null;
  };
  const server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    response.setHeader("content-type", "application/json");
    const payload = granolaPayload(request.url ?? "");
    response.statusCode = payload ? 200 : 404;
    response.end(JSON.stringify(payload ?? { error: "not found" }));
  });
  let baseUrl = "http://granola.test/v1";
  let granolaFetchImpl;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => server.close());
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
    granolaFetchImpl = async (url, init) => {
      const parsed = new URL(url);
      requests.push({
        url: `${parsed.pathname}${parsed.search}`,
        authorization: init.headers.Authorization,
      });
      const payload = granolaPayload(`${parsed.pathname}${parsed.search}`);
      return new Response(JSON.stringify(payload ?? { error: "not found" }), {
        status: payload ? 200 : 404,
        headers: { "content-type": "application/json" },
      });
    };
  }
  const google = gateway({ listMessages: async () => ({ messages: [] }) });
  const priorDbPath = process.env.COVE_DB_PATH;
  process.env.COVE_DB_PATH = path.join(files.dir, "cove.db");
  t.after(() => {
    if (priorDbPath === undefined) delete process.env.COVE_DB_PATH;
    else process.env.COVE_DB_PATH = priorDbPath;
  });
  const options = runOptions(files, google.mail, {
    granolaApiKey: "granola-test-key",
    granolaBaseUrl: baseUrl,
    granolaFetchImpl,
    runMeetingAnalysisSweepImpl: async () => ({ processed: 0, failed: 0, dead: 0 }),
  });
  delete options.dbPath;
  const result = await runMeetingWatch(options);
  assert.equal(result.exitCode, 0);
  const db = new Database(path.join(files.dir, "cove.db"), { readonly: true });
  const ingestion = db.prepare(
    "SELECT message_id, source_door FROM cove_message_ingestion WHERE message_id = ?",
  ).get("granola:not_real");
  const member = db.prepare(
    "SELECT envelope_json FROM meeting_analysis_members WHERE gmail_message_id = ?",
  ).get("granola:not_real");
  db.close();
  assert.deepEqual(ingestion, {
    message_id: "granola:not_real",
    source_door: "watcher",
  });
  const envelope = JSON.parse(member.envelope_json);
  assert.equal(envelope.fragment, false);
  assert.equal(envelope.artifactUrl, "https://app.granola.ai/notes/not_real");
  assert.match(requests[0].url, /page_size=30/);
  assert.equal(
    new URL(requests[0].url, "http://granola.test").searchParams.get("updated_after"),
    "2026-07-25T18:00:00.000Z",
  );
  assert.equal(requests.every((request) =>
    request.authorization === "Bearer granola-test-key"), true);
  const state = readMeetingState(files.statePath);
  assert.equal(state.granola.watermark_at, "2026-07-29T18:00:00.000Z");
  assert.equal(state.granola.list_cursor, null);
  assert.equal(state.granola.revisions.not_real.length, 64);
  const heartbeat = JSON.parse(readFileSync(files.heartbeatPath, "utf8"))
    .machines["11111111-1111-4111-8111-111111111111"].meeting_watch;
  assert.equal(heartbeat.granola.status, "ok");
  assert.equal(heartbeat.granola.notes_queued, 1);
  assert.equal(heartbeat.granola.notes_pending, 0);
  assert.equal(heartbeat.granola.notes_failed, 0);
  assert.equal(heartbeat.granola.notes_dead_lettered, 0);
});

test("Granola pending notes queue once when complete and later revisions are ignored", async () => {
  const now = () => new Date("2026-09-02T18:00:00.000Z");
  const baseState = {
    watermark_at: null,
    list_cursor: null,
    pending_note_ids: [],
    revisions: {},
  };
  const note = (summary, privateNotes = null) => ({
    id: "not_pending",
    title: "Pending meeting",
    owner: { name: "Alex", email: "alex@joinedgeai.com" },
    attendees: [],
    created_at: "2026-09-01T18:00:00.000Z",
    updated_at: "2026-09-02T17:00:00.000Z",
    summary_markdown: summary,
    summary_text: null,
    private_notes_markdown: privateNotes,
    private_notes_text: null,
    calendar_event: null,
    web_url: "https://app.granola.ai/notes/not_pending",
  });
  const client = (detail) => ({
    listNotes: async () => ({
      notes: [detail],
      hasMore: false,
      cursor: "done",
    }),
    getNote: async () => detail,
  });
  let queued = 0;
  const queueMeetingEmail = async (_input, options) => {
    assert.equal(options.sourceDoor, "watcher");
    queued += 1;
    return { status: "processed" };
  };
  const pending = await runGranolaPoll({
    enabled: true,
    apiKey: "test",
    ownerEmails: ["alex@joinedgeai.com"],
    state: baseState,
    now,
    dryRun: false,
    client: client(note(null)),
    queueMeetingEmail,
  });
  assert.deepEqual(pending.state.pending_note_ids, ["not_pending"]);
  assert.equal(pending.heartbeat.notes_pending, 1);
  assert.equal(queued, 0);

  const complete = await runGranolaPoll({
    enabled: true,
    apiKey: "test",
    ownerEmails: ["alex@joinedgeai.com"],
    state: pending.state,
    now,
    dryRun: false,
    client: client(note("Complete summary")),
    queueMeetingEmail,
  });
  assert.deepEqual(complete.state.pending_note_ids, []);
  assert.equal(complete.heartbeat.notes_queued, 1);
  assert.equal(queued, 1);

  const revised = await runGranolaPoll({
    enabled: true,
    apiKey: "test",
    ownerEmails: ["alex@joinedgeai.com"],
    state: complete.state,
    now,
    dryRun: false,
    client: client(note("Complete summary", "New private note")),
    queueMeetingEmail,
  });
  assert.equal(revised.heartbeat.revisions_ignored, 1);
  assert.equal(queued, 1);
});

test("Granola skips foreign and missing owners without fetching note details", async () => {
  let detailCalls = 0;
  const result = await runGranolaPoll({
    enabled: true,
    apiKey: "test",
    ownerEmails: ["alex@joinedgeai.com"],
    state: {
      watermark_at: null,
      list_cursor: null,
      pending_note_ids: [],
      revisions: {},
      failures: {},
      dead_letters: [],
    },
    now: () => new Date("2026-09-02T18:00:00.000Z"),
    dryRun: false,
    client: {
      listNotes: async () => ({
        notes: [
          {
            id: "not_foreign",
            owner: { name: "Other", email: "other@example.com" },
            created_at: "2026-09-02T16:00:00.000Z",
            updated_at: "2026-09-02T17:00:00.000Z",
          },
          {
            id: "not_owner_missing",
            created_at: "2026-09-02T16:00:00.000Z",
            updated_at: "2026-09-02T17:00:00.000Z",
          },
        ],
        hasMore: false,
      }),
      getNote: async () => {
        detailCalls += 1;
        throw new Error("owner-skipped notes must not be fetched");
      },
    },
    queueMeetingEmail: async () => {
      throw new Error("owner-skipped notes must not be queued");
    },
  });
  assert.equal(result.heartbeat.notes_seen, 2);
  assert.equal(result.heartbeat.notes_skipped_owner, 2);
  assert.equal(result.heartbeat.notes_queued, 0);
  assert.equal(detailCalls, 0);
});

test("Granola queue failures are isolated, bounded, and dead-lettered", async () => {
  const now = () => new Date("2026-09-02T18:00:00.000Z");
  const note = (id) => ({
    id,
    title: id,
    owner: { name: "Alex", email: "alex@joinedgeai.com" },
    attendees: [],
    created_at: "2026-09-02T16:00:00.000Z",
    updated_at: "2026-09-02T17:00:00.000Z",
    summary_text: "Complete summary",
    web_url: `https://app.granola.ai/notes/${id}`,
  });
  let detailCalls = 0;
  let state = {
    watermark_at: null,
    list_cursor: null,
    pending_note_ids: [],
    revisions: {},
    failures: {},
    dead_letters: [],
  };
  const client = {
    listNotes: async () => ({
      notes: [note("not_retry"), note("not_good")],
      hasMore: false,
    }),
    getNote: async (id) => {
      detailCalls += 1;
      return note(id);
    },
  };
  let goodQueued = false;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const poll = await runGranolaPoll({
      enabled: true,
      apiKey: "test",
      ownerEmails: ["alex@joinedgeai.com"],
      state,
      now,
      dryRun: false,
      client,
      queueMeetingEmail: async (input) => {
        if (input.messageId === "granola:not_good") {
          goodQueued = true;
          return { status: "processed" };
        }
        throw new Error("queue offline");
      },
    });
    state = poll.state;
    assert.equal(poll.heartbeat.notes_failed, 1);
  }
  assert.equal(goodQueued, true);
  assert.equal(state.failures.not_retry, undefined);
  assert.deepEqual(state.pending_note_ids, []);
  assert.equal(state.dead_letters.length, 1);
  assert.equal(state.dead_letters[0].note_id, "not_retry");
  assert.equal(state.dead_letters[0].failed_runs, 5);
  const callsBeforeDeadLetterPoll = detailCalls;
  const afterDeadLetter = await runGranolaPoll({
    enabled: true,
    apiKey: "test",
    ownerEmails: ["alex@joinedgeai.com"],
    state,
    now,
    dryRun: false,
    client,
    queueMeetingEmail: async () => {
      throw new Error("dead-lettered notes must not be queued");
    },
  });
  assert.equal(afterDeadLetter.heartbeat.notes_dead_lettered, 1);
  assert.equal(detailCalls, callsBeforeDeadLetterPoll + 1, "only the completed note is refetched");

  const alreadyFailed = await runGranolaPoll({
    enabled: true,
    apiKey: "test",
    ownerEmails: ["alex@joinedgeai.com"],
    state: {
      watermark_at: null,
      list_cursor: null,
      pending_note_ids: [],
      revisions: {},
      failures: {},
      dead_letters: [],
    },
    now,
    dryRun: false,
    client: {
      listNotes: async () => ({ notes: [note("not_already_failed")], hasMore: false }),
      getNote: async () => note("not_already_failed"),
    },
    queueMeetingEmail: async () => ({ status: "skipped", reason: "already-failed" }),
  });
  assert.equal(alreadyFailed.state.dead_letters[0].note_id, "not_already_failed");
  assert.equal(alreadyFailed.heartbeat.notes_dead_lettered, 1);
});

test("Granola lease-active results remain pending without consuming failure attempts", async () => {
  const note = {
    id: "not_leased",
    title: "Leased note",
    owner: { email: "alex@joinedgeai.com" },
    attendees: [],
    created_at: "2026-09-02T16:00:00.000Z",
    updated_at: "2026-09-02T17:00:00.000Z",
    summary_text: "Complete summary",
    web_url: "https://app.granola.ai/notes/not_leased",
  };
  const result = await runGranolaPoll({
    enabled: true,
    apiKey: "test",
    ownerEmails: ["alex@joinedgeai.com"],
    state: {
      watermark_at: "2026-09-01T18:00:00.000Z",
      list_cursor: null,
      pending_note_ids: ["not_leased"],
      revisions: {},
      failures: { not_leased: { failed_runs: 2 } },
      dead_letters: [],
    },
    now: () => new Date("2026-09-02T18:00:00.000Z"),
    dryRun: false,
    client: {
      listNotes: async () => ({ notes: [], hasMore: false }),
      getNote: async () => note,
    },
    queueMeetingEmail: async () => ({ status: "skipped", reason: "lease-active" }),
  });
  assert.equal(result.heartbeat.notes_failed, 0);
  assert.equal(result.state.failures.not_leased.failed_runs, 2);
  assert.deepEqual(result.state.pending_note_ids, ["not_leased"]);
  assert.deepEqual(result.state.dead_letters, []);
});

test("every Granola pending note expires after seven days", async () => {
  let queued = 0;
  const result = await runGranolaPoll({
    enabled: true,
    apiKey: "test",
    ownerEmails: ["alex@joinedgeai.com"],
    state: {
      watermark_at: "2026-09-01T18:00:00.000Z",
      list_cursor: null,
      pending_note_ids: ["not_old_complete"],
      revisions: {},
      failures: { not_old_complete: { failed_runs: 1 } },
      dead_letters: [],
    },
    now: () => new Date("2026-09-10T18:00:00.000Z"),
    dryRun: false,
    client: {
      listNotes: async () => ({ notes: [], hasMore: false }),
      getNote: async () => ({
        id: "not_old_complete",
        owner: { email: "alex@joinedgeai.com" },
        attendees: [],
        created_at: "2026-09-01T18:00:00.000Z",
        updated_at: "2026-09-02T18:00:00.000Z",
        summary_text: "This summary is now complete.",
        web_url: "https://app.granola.ai/notes/not_old_complete",
      }),
    },
    queueMeetingEmail: async () => {
      queued += 1;
      return { status: "processed" };
    },
  });
  assert.equal(queued, 0);
  assert.deepEqual(result.state.pending_note_ids, []);
  assert.equal(result.state.failures.not_old_complete, undefined);
});

test("Granola pending notes with an invalid created_at expire on the next poll", async () => {
  let queued = 0;
  const result = await runGranolaPoll({
    enabled: true,
    apiKey: "test",
    ownerEmails: ["alex@joinedgeai.com"],
    state: {
      watermark_at: "2026-09-01T18:00:00.000Z",
      list_cursor: null,
      pending_note_ids: ["not_bad_date"],
      revisions: {},
      failures: { not_bad_date: { failed_runs: 1 } },
      dead_letters: [],
    },
    now: () => new Date("2026-09-02T18:00:00.000Z"),
    dryRun: false,
    client: {
      listNotes: async () => ({ notes: [], hasMore: false }),
      getNote: async () => ({
        id: "not_bad_date",
        owner: { email: "alex@joinedgeai.com" },
        attendees: [],
        created_at: "not-a-date",
        updated_at: "2026-09-02T17:00:00.000Z",
        summary_text: "Late summary",
        web_url: "https://app.granola.ai/notes/not_bad_date",
      }),
    },
    queueMeetingEmail: async () => {
      queued += 1;
      return { status: "processed" };
    },
  });
  assert.equal(queued, 0);
  assert.deepEqual(result.state.pending_note_ids, []);
  assert.equal(result.state.failures.not_bad_date, undefined);
});

test("Granola resumes a poll from an existing opaque list cursor", async () => {
  const calls = [];
  const result = await runGranolaPoll({
    enabled: true,
    apiKey: "test",
    ownerEmails: [],
    state: {
      watermark_at: "2026-09-01T18:00:00.000Z",
      list_cursor: "opaque-resume-token",
      pending_note_ids: [],
      revisions: {},
      failures: {},
      dead_letters: [],
    },
    now: () => new Date("2026-09-02T18:00:00.000Z"),
    dryRun: false,
    client: {
      listNotes: async (input) => {
        calls.push(input);
        return { notes: [], hasMore: false };
      },
      getNote: async () => { throw new Error("no notes expected"); },
    },
    queueMeetingEmail: async () => { throw new Error("no notes expected"); },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cursor, "opaque-resume-token");
  assert.equal(calls[0].updatedAfter, "2026-09-01T17:50:00.000Z");
  assert.equal(result.state.list_cursor, null);
  assert.equal(result.state.watermark_at, "2026-09-02T18:00:00.000Z");
});

test("Granola pagination failure clears its cursor and restarts from the unchanged watermark", async () => {
  const initial = {
    watermark_at: "2026-09-01T18:00:00.000Z",
    list_cursor: null,
    pending_note_ids: [],
    revisions: {},
    failures: {},
    dead_letters: [],
  };
  const persisted = [];
  let firstCalls = 0;
  await assert.rejects(runGranolaPoll({
    enabled: true,
    apiKey: "test",
    ownerEmails: ["alex@joinedgeai.com"],
    state: initial,
    now: () => new Date("2026-09-02T18:00:00.000Z"),
    dryRun: false,
    client: {
      listNotes: async () => {
        firstCalls += 1;
        if (firstCalls === 2) throw new Error("page two failed");
        return {
          notes: [{
            id: "not_page_one",
            owner: { email: "other@example.com" },
            created_at: "2026-09-02T16:00:00.000Z",
            updated_at: "2026-09-02T17:00:00.000Z",
          }],
          hasMore: true,
          cursor: "page-two",
        };
      },
      getNote: async () => { throw new Error("not reached"); },
    },
    queueMeetingEmail: async () => { throw new Error("not reached"); },
    persistProgress: (state) => persisted.push(structuredClone(state)),
  }), /page two failed/);
  const interrupted = persisted.at(-1);
  assert.equal(interrupted.list_cursor, null);
  assert.equal(interrupted.watermark_at, initial.watermark_at);

  const resumedCalls = [];
  const resumed = await runGranolaPoll({
    enabled: true,
    apiKey: "test",
    ownerEmails: ["alex@joinedgeai.com"],
    state: interrupted,
    now: () => new Date("2026-09-02T18:00:00.000Z"),
    dryRun: false,
    client: {
      listNotes: async (input) => {
        resumedCalls.push(input);
        return input.cursor
          ? { notes: [], hasMore: false }
          : {
              notes: [{
                id: "not_page_one",
                owner: { email: "other@example.com" },
                created_at: "2026-09-02T16:00:00.000Z",
                updated_at: "2026-09-02T17:00:00.000Z",
              }],
              hasMore: true,
              cursor: "page-two",
            };
      },
      getNote: async () => { throw new Error("owner skip must avoid detail fetch"); },
    },
    queueMeetingEmail: async () => { throw new Error("not reached"); },
  });
  assert.equal(resumedCalls[0].cursor, undefined);
  assert.equal(resumedCalls[0].updatedAfter, "2026-09-01T17:50:00.000Z");
  assert.equal(resumed.state.watermark_at, "2026-09-02T18:00:00.000Z");
});

test("Granola list walk stops at twenty pages without advancing its watermark", async () => {
  let pages = 0;
  const result = await runGranolaPoll({
    enabled: true,
    apiKey: "test",
    ownerEmails: [],
    state: {
      watermark_at: "2026-09-01T18:00:00.000Z",
      list_cursor: null,
      pending_note_ids: [],
      revisions: {},
      failures: {},
      dead_letters: [],
    },
    now: () => new Date("2026-09-02T18:00:00.000Z"),
    dryRun: false,
    client: {
      listNotes: async () => {
        pages += 1;
        return { notes: [], hasMore: true, cursor: `cursor-${pages}` };
      },
      getNote: async () => { throw new Error("not reached"); },
    },
    queueMeetingEmail: async () => { throw new Error("not reached"); },
  });
  assert.equal(pages, 20);
  assert.equal(result.state.watermark_at, "2026-09-01T18:00:00.000Z");
  assert.equal(result.state.list_cursor, "cursor-20");
  assert.match(result.heartbeat.note, /page cap reached at 20 pages/);
});

test("missing Granola key leaves the Gmail watcher active", async (t) => {
  const files = fixture(t, {
    active_tools: ["gemini", "granola"],
    granola: { enabled: true, owner_emails: ["alex@joinedgeai.com"] },
  });
  const google = gateway();
  const result = await runMeetingWatch(runOptions(files, google.mail, {
    granolaApiKey: "",
    meetingAnalystEnabled: false,
    processMeetingEmail: async () => ({
      status: "processed",
      summary: { parsedItems: 1, tasks: 1, waitingOn: 0 },
    }),
  }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.processed, 1);
  const heartbeat = JSON.parse(readFileSync(files.heartbeatPath, "utf8"))
    .machines["11111111-1111-4111-8111-111111111111"].meeting_watch;
  assert.equal(heartbeat.granola.status, "disabled");
  assert.equal(google.calls.filter(([name]) => name === "listMessages").length, 1);
});

test("Granola 401 leaves poll state unchanged and reports failed without disabling Gmail", async (t) => {
  const files = fixture(t, {
    active_tools: ["granola"],
    granola: { enabled: true, owner_emails: ["alex@joinedgeai.com"] },
  });
  writeMeetingState(files.statePath, {
    processed_ids: [],
    cursor_at: "2026-09-01T18:00:00.000Z",
    failures: {},
    dead_letters: [],
    granola: {
      watermark_at: "2026-09-01T18:00:00.000Z",
      list_cursor: null,
      pending_note_ids: ["not_pending"],
      revisions: { not_old: "old-hash" },
    },
  });
  const before = readMeetingState(files.statePath).granola;
  let gmailPolls = 0;
  const google = gateway({
    listMessages: async () => {
      gmailPolls += 1;
      return { messages: [] };
    },
  });
  const result = await runMeetingWatch(runOptions(files, google.mail, {
    granolaApiKey: "expired-key",
    granolaFetchImpl: async () => new Response("expired", { status: 401 }),
    runMeetingAnalysisSweepImpl: async () => ({ processed: 0, failed: 0, dead: 0 }),
  }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.errors, 1);
  assert.deepEqual(readMeetingState(files.statePath).granola, before);
  const heartbeat = JSON.parse(readFileSync(files.heartbeatPath, "utf8"))
    .machines["11111111-1111-4111-8111-111111111111"].meeting_watch;
  assert.equal(heartbeat.disabled, false);
  assert.equal(heartbeat.granola.status, "failed");
  assert.match(heartbeat.granola.error, /HTTP 401/);
  assert.equal(gmailPolls, 1);
});

test("malformed Granola list pages fail the poll and leave state untouched", async (t) => {
  const files = fixture(t, {
    active_tools: ["granola"],
    granola: { enabled: true, owner_emails: ["alex@joinedgeai.com"] },
  });
  writeMeetingState(files.statePath, {
    processed_ids: [],
    cursor_at: "2026-09-01T18:00:00.000Z",
    failures: {},
    dead_letters: [],
    granola: {
      watermark_at: "2026-09-01T18:00:00.000Z",
      list_cursor: "opaque-existing-cursor",
      pending_note_ids: ["not_pending"],
      revisions: { not_old: "old-hash" },
      failures: {},
      dead_letters: [],
    },
  });
  const before = readMeetingState(files.statePath).granola;
  const google = gateway({ listMessages: async () => ({ messages: [] }) });
  const result = await runMeetingWatch(runOptions(files, google.mail, {
    granolaApiKey: "test-key",
    granolaFetchImpl: async () => new Response(JSON.stringify({
      notes: { invalid: true },
      hasMore: false,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    runMeetingAnalysisSweepImpl: async () => ({ processed: 0, failed: 0, dead: 0 }),
  }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary.errors, 1);
  assert.deepEqual(readMeetingState(files.statePath).granola, before);
  const heartbeat = JSON.parse(readFileSync(files.heartbeatPath, "utf8"))
    .machines["11111111-1111-4111-8111-111111111111"].meeting_watch;
  assert.equal(heartbeat.granola.status, "failed");
  assert.match(heartbeat.granola.error, /invalid notes page/);
});
