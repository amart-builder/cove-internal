import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  detectMeetingNotes,
  KNOWN_MEETING_TOOL_PATTERNS,
  loadMeetingDetectionConfig,
} from "../src/lib/intake/meeting-detection.ts";
import { coveConfigPath } from "../src/lib/env-runtime.mjs";

const fixtureEmails = JSON.parse(readFileSync(
  new URL("./fixtures/meeting-notes.json", import.meta.url),
  "utf8",
));

test("known meeting-note patterns detect Gemini, Granola, Fathom, and Otter", () => {
  for (const email of fixtureEmails) {
    const result = detectMeetingNotes(email, {
      patterns: KNOWN_MEETING_TOOL_PATTERNS,
    });
    assert.deepEqual(result, { matched: true, tool: email.tool }, email.tool);
    if (email.tool !== "gemini") {
      assert.deepEqual(
        detectMeetingNotes(
          { subject: email.subject },
          { patterns: KNOWN_MEETING_TOOL_PATTERNS },
        ),
        { matched: true, tool: email.tool },
        `${email.tool} subject-only`,
      );
    }
  }
  assert.deepEqual(
    detectMeetingNotes(
      {
        sender: "person@example.com",
        subject: "Can you review the proposal?",
      },
      { patterns: KNOWN_MEETING_TOOL_PATTERNS },
    ),
    { matched: false },
  );
});

test("meeting config selects active tools and accepts a custom pattern", (t) => {
  const dir = path.join(
    os.tmpdir(),
    `cove-meeting-detection-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "cove-meetings.json");
  writeFileSync(file, JSON.stringify({
    enabled: true,
    active_tools: ["otter", "custom-recorder"],
    window: "newer_than:7d",
    processed_label: "Cove/Meeting-Processed",
    custom_patterns: [{
      tool: "custom-recorder",
      sender_regex: "@recorder\\.example$",
      subject_regex: "^Call recap:",
      gmail_query: "from:(recorder.example) OR subject:(\"Call recap:\")",
    }],
  }));
  const config = loadMeetingDetectionConfig(file);
  assert.deepEqual(config.activeTools, ["otter", "custom-recorder"]);
  assert.match(config.query, /otter\.ai/);
  assert.match(config.query, /recorder\.example/);
  assert.deepEqual(
    detectMeetingNotes(
      {
        sender: "notes@recorder.example",
        subject: "Call recap: Weekly sync",
      },
      config,
    ),
    { matched: true, tool: "custom-recorder" },
  );
});

test("legacy Gemini config remains the default-compatible shape", (t) => {
  const dir = path.join(
    os.tmpdir(),
    `cove-meeting-legacy-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "cove-meetings.json");
  const legacy = {
    enabled: true,
    query: 'from:(gemini-noreply@google.com) OR subject:("Notes:" OR "Meeting notes")',
    window: "newer_than:2d",
    processed_label: "Cove/Meeting-Processed",
  };
  writeFileSync(file, JSON.stringify(legacy));
  writeFileSync(
    path.join(dir, "cove-meetings.example.json"),
    JSON.stringify({
      enabled: false,
      active_tools: ["otter"],
      window: "newer_than:30d",
      processed_label: "Cove/Meeting-Processed",
    }),
  );
  const resolved = coveConfigPath(dir, "meetings.json");
  assert.equal(resolved, file);
  const config = loadMeetingDetectionConfig(resolved);
  assert.deepEqual(config.activeTools, ["gemini"]);
  assert.equal(config.patterns[0].tool, "gemini");
  assert.equal(config.enabled, legacy.enabled);
  assert.equal(config.query, legacy.query);
  assert.equal(config.window, legacy.window);
  assert.equal(config.processedLabel, legacy.processed_label);
});

test("Gemini detector accepts every notes token shape selected by its Gmail query", () => {
  const config = {
    patterns: KNOWN_MEETING_TOOL_PATTERNS.filter(
      (pattern) => pattern.tool === "gemini",
    ),
  };
  for (const subject of [
    "Notes: Client sync",
    "Client sync notes",
    "Here are your NOTES from today",
    "Meeting notes for launch",
  ]) {
    assert.deepEqual(
      detectMeetingNotes({ subject }, config),
      { matched: true, tool: "gemini" },
      subject,
    );
  }
});
