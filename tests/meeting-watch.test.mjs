import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  main as meetingWatchMain,
  readMeetingState,
  runMeetingAnalysisDrain,
  runMeetingWatch,
  shouldRecordMeetingWatchReceipt,
  writeMeetingState,
} from "../scripts/cove-meeting-watch.mjs";

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
  });
  const state = readMeetingState(files.statePath);
  assert.equal(state.processed_ids.length, 500);
  assert.equal(new Set(state.processed_ids).size, 500);
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
