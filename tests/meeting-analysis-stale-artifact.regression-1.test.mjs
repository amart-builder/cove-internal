/**
 * A meeting whose analyst artifact was already generated must still be able to
 * finish after the retry lands past the earliest due time it proposed.
 *
 * The analyst's output is cached on the job row so a retry does not pay for a
 * second model run. That cached artifact used to be re-validated against a
 * fresh clock, and one of those rules is that every task due date is in the
 * future. So a job that was interrupted in the evening and retried the next
 * morning failed that rule on every remaining attempt and died with the rest
 * of the meeting's commitments unwritten.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("tsx/cjs");
const {
  enqueueMeetingEnvelope,
  runMeetingAnalysisSweep,
} = require("../src/lib/intake/meeting-analysis.ts");
const { operatorTimezone } = require("../src/lib/operator.ts");

const MEETING_AT = "2026-08-28T18:00:00.000Z";
const DUE_AT = "2026-08-28T20:00:00.000Z";
const REMIND_AT = "2026-08-28T19:00:00.000Z";
const NEXT_MORNING = "2026-08-29T16:00:00.000Z";

function databasePath() {
  return path.join(mkdtempSync(path.join(tmpdir(), "cove-stale-artifact-")), "cove.db");
}

function localTimestamp(instant, timezone = operatorTimezone()) {
  const date = new Date(instant);
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const zone = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  }).formatToParts(date).find((part) => part.type === "timeZoneName").value.replace(/^GMT/, "") || "Z";
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}${zone === "+00:00" ? "Z" : zone}`;
}

function task(title) {
  return {
    title,
    description: `${title} description`,
    brief: `${title} complete execution brief with context and completion standard.`,
    due_at: localTimestamp(DUE_AT),
    priority: "high",
    notification_policy: "both",
    remind_at: localTimestamp(REMIND_AT),
    rationale: "The operator promised this before the end of the day.",
  };
}

function envelope(messageId) {
  return {
    gmailMessageId: messageId,
    threadId: `thread-${messageId}`,
    tool: "granola",
    title: "Launch planning",
    sender: "Granola <notes@granola.ai>",
    attendees: [{ name: "Pat External", email: "pat@example.com" }],
    body: "Complete meeting transcript. ".repeat(80),
    receivedAt: MEETING_AT,
    durationMinutes: 45,
    fragment: false,
  };
}

function scenario(dbPath) {
  const artifact = {
    meeting_summary: "The operator agreed on the next launch step.",
    per_contact_notes: [],
    tasks: [task("Send the revised scope"), task("Book the follow-up")],
    waiting_on: [],
    research_requests: [],
  };
  const state = { analystCalls: 0, executed: [] };
  const common = {
    dbPath,
    dataDir: path.dirname(dbPath),
    baseUrl: "http://127.0.0.1:3200",
    runJobImpl: async (input) => {
      state.analystCalls += 1;
      return {
        ok: true,
        lane: input.lane,
        backend: "codex-sol-high",
        text: JSON.stringify(artifact),
        value: artifact,
      };
    },
    executeActionImpl: async (action) => {
      state.executed.push(action.action_key);
      return action.target_id;
    },
    legacyFallback: async () => {},
    maxJobs: 1,
  };
  return { state, common };
}

/**
 * Interrupts the job the way a killed worker or a closed laptop does: after one
 * task is on the board and before the rest of the meeting is written. One
 * completed task action is also what makes the death silent, because the
 * legacy extraction fallback is deliberately skipped once partial analyst
 * output exists.
 */
function crashOnSecondTask() {
  let tasks = 0;
  return (action) => {
    if (action.kind !== "task") return;
    tasks += 1;
    if (tasks === 2) throw new Error("simulated crash after the first task was written");
  };
}

test("a cached analyst artifact still applies when the retry lands after its due time", async () => {
  const dbPath = databasePath();
  enqueueMeetingEnvelope(envelope("stale-resume"), { dbPath, now: new Date(MEETING_AT) });
  const { state, common } = scenario(dbPath);

  const first = await runMeetingAnalysisSweep({
    ...common,
    now: () => new Date(MEETING_AT),
    afterSideEffect: crashOnSecondTask(),
  });
  assert.equal(first.failed, 1);

  const interrupted = new Database(dbPath);
  assert.ok(
    interrupted.prepare("SELECT analyst_json FROM meeting_analysis_jobs").pluck().get(),
    "the analyst artifact is cached on the job row",
  );
  assert.equal(
    interrupted.prepare(
      "SELECT count(*) FROM meeting_analysis_actions WHERE kind = 'task' AND status = 'done'",
    ).pluck().get(),
    1,
    "one task was written before the crash",
  );
  interrupted.close();

  // The next sweep runs the following morning, past the due time the analyst
  // proposed. Nothing about the meeting has changed.
  const second = await runMeetingAnalysisSweep({
    ...common,
    now: () => new Date(NEXT_MORNING),
  });

  assert.equal(second.processed, 1, "the interrupted meeting finishes on the next sweep");
  assert.equal(state.analystCalls, 1, "the cached artifact is reused, not regenerated");
  const finished = new Database(dbPath);
  assert.equal(finished.prepare("SELECT status FROM meeting_analysis_jobs").pluck().get(), "succeeded");
  assert.equal(
    finished.prepare(
      "SELECT count(*) FROM meeting_analysis_actions WHERE kind = 'task' AND status = 'done'",
    ).pluck().get(),
    2,
    "the task left unwritten by the crash is written",
  );
  finished.close();
});

test("a stale cached artifact does not burn the job's remaining attempts", async () => {
  const dbPath = databasePath();
  enqueueMeetingEnvelope(envelope("stale-attempts"), { dbPath, now: new Date(MEETING_AT) });
  const { common } = scenario(dbPath);

  await runMeetingAnalysisSweep({
    ...common,
    now: () => new Date(MEETING_AT),
    afterSideEffect: crashOnSecondTask(),
  });

  // Five more sweeps the next morning: with the future-due rule applied to the
  // cached artifact every one of them failed, and the fifth marked the job
  // dead with the remaining commitments never written.
  for (let index = 0; index < 5; index += 1) {
    const db = new Database(dbPath);
    db.prepare("UPDATE meeting_analysis_jobs SET not_before = ?").run(NEXT_MORNING);
    db.close();
    await runMeetingAnalysisSweep({ ...common, now: () => new Date(NEXT_MORNING) });
  }

  const finished = new Database(dbPath);
  const row = finished.prepare("SELECT status, error FROM meeting_analysis_jobs").get();
  finished.close();
  assert.notEqual(row.status, "dead", `the job died with: ${row.error ?? "no error"}`);
  assert.equal(row.status, "succeeded");
});
