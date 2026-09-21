/**
 * When the inbound event behind an analyst task cannot be written, the task
 * must not be created either.
 *
 * `executeAction` records an inbound event, creates the task against it, and
 * then resolves the event to `triaged`. `recordEvent` reports a write failure
 * by returning a synthetic event rather than throwing, and that return was
 * never inspected: the task was created against an event that does not exist,
 * and the resolve step then failed — on that attempt and on every retry, since
 * the task now existed and the event still did not. Five attempts later the
 * job was dead, and because no task action had completed, the legacy
 * extraction fallback re-extracted the same meeting and produced a second copy
 * of the same cards.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
const { LocalCRMBackend } = require("../src/lib/crm/local.ts");
const { operatorTimezone } = require("../src/lib/operator.ts");

const MEETING_AT = "2026-08-28T18:00:00.000Z";
const DUE_AT = "2030-01-11T17:00:00.000Z";
const REMIND_AT = "2030-01-11T16:00:00.000Z";

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

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "cove-unrecorded-event-"));
  const dbPath = path.join(dir, "cove.db");
  const previous = new Map([
    ["COVE_DB_PATH", process.env.COVE_DB_PATH],
    ["NEXT_PUBLIC_COVE_RUNTIME", process.env.NEXT_PUBLIC_COVE_RUNTIME],
    ["NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL],
    ["SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY],
  ]);
  process.env.COVE_DB_PATH = dbPath;
  const crm = new LocalCRMBackend({ dbPath, now: () => new Date(MEETING_AT) });
  t.after(() => {
    crm.close();
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, dbPath, crm };
}

test("an analyst task is not created when its inbound event could not be recorded", async (t) => {
  const files = fixture(t);
  enqueueMeetingEnvelope({
    gmailMessageId: "unrecorded",
    threadId: "thread-unrecorded",
    tool: "granola",
    title: "Launch planning",
    sender: "Granola <notes@granola.ai>",
    attendees: [{ name: "Pat External", email: "pat@example.com" }],
    body: "Complete meeting transcript. ".repeat(80),
    receivedAt: MEETING_AT,
    durationMinutes: 45,
    fragment: false,
  }, { dbPath: files.dbPath, now: new Date(MEETING_AT) });

  const artifact = {
    meeting_summary: "The operator agreed on the next launch step.",
    per_contact_notes: [],
    tasks: [{
      title: "Send the revised scope",
      description: "Send the revised scope description",
      brief: "Send the revised scope, complete execution brief with context and completion standard.",
      due_at: localTimestamp(DUE_AT),
      priority: "high",
      notification_policy: "both",
      remind_at: localTimestamp(REMIND_AT),
      rationale: "This fulfills the explicit promise early.",
    }],
    waiting_on: [],
    research_requests: [],
  };

  const taskWrites = [];
  const fetchImpl = async (url, options = {}) => {
    const text = String(url);
    if (text.includes("/api/day-plan")) {
      return new Response(JSON.stringify({ csrfToken: "csrf" }), { status: 200 });
    }
    if (text.includes("task_columns")) {
      return new Response(JSON.stringify([{ id: "column", name: "Not Started" }]), { status: 200 });
    }
    if (text.includes("/tasks?") && options.method !== "POST") {
      return new Response("[]", { status: 200 });
    }
    if (text.endsWith("/api/cove-rest/tasks") && options.method === "POST") {
      taskWrites.push(JSON.parse(options.body));
      return new Response(JSON.stringify([{ id: "analyst-task" }]), { status: 201 });
    }
    throw new Error(`unexpected request ${text}`);
  };

  // The inbound event store is unreachable. Task creation goes to the web app
  // over its own transport and still answers.
  process.env.NEXT_PUBLIC_COVE_RUNTIME = "supabase";
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  const result = await runMeetingAnalysisSweep({
    dbPath: files.dbPath,
    dataDir: files.dir,
    baseUrl: "http://cove.test",
    crmBackend: files.crm,
    fetchImpl,
    now: () => new Date(MEETING_AT),
    runJobImpl: async (input) => ({
      ok: true,
      lane: input.lane,
      backend: "codex-sol-high",
      text: JSON.stringify(artifact),
      value: artifact,
    }),
    legacyFallback: async () => {},
    maxJobs: 1,
  });

  assert.equal(result.processed, 0, "the job does not complete while the event store is down");
  assert.deepEqual(
    taskWrites,
    [],
    "no task is created against an inbound event that was never recorded",
  );

  const db = new Database(files.dbPath, { readonly: true });
  const action = db.prepare(
    "SELECT status, error FROM meeting_analysis_actions WHERE kind = 'task'",
  ).get();
  db.close();
  assert.equal(action.status, "failed");
  assert.match(action.error, /could not record/i);
});
