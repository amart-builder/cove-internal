import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readMeetingState,
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
    window: "newer_than:2d",
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

test("meeting watcher reads through the restricted gateway and applies only the reserved meeting marker", async (t) => {
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
  assert.deepEqual(
    google.calls.find(([name]) => name === "modifyThreadLabels")[1],
    {
      threadId: "thread-1",
      addNames: ["Cove/Meeting-Processed"],
    },
  );
  assert.deepEqual(readMeetingState(files.statePath).processed_ids, ["message-1"]);
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
  assert.equal(readMeetingState(files.statePath).processed_ids.length, 0);
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
