/**
 * Petrit as four cards, Asher as one card per meeting.
 *
 * The meeting analyst was handed the CRM record, open commitments and three
 * emails per attendee, and never the board. Its output could only say
 * "create a task", so every meeting with the same person produced another
 * card beside the last one, and Alex tidied them up each morning. The same
 * lane was also told to "default to overdelivering", so a Friday promise
 * became a Friday-morning deadline the person never made.
 *
 * The analyst now sees every open card by id and title, plus the full text
 * of the cards that mention an attendee, and a task may name the open card it
 * belongs to (existing_task_id, narrowed at runtime to the ids it was shown)
 * with checklist lines. Cove appends to that card, guarded on what it read,
 * and never creates a second one. The forced-early deadline sentence is gone.
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
  MEETING_ANALYST_JSON_SCHEMA,
  buildMeetingAnalystPrompt,
  enqueueMeetingEnvelope,
  loadAnalystBoardContext,
  meetingAnalystSchema,
  runMeetingAnalysisSweep,
  validateMeetingAnalystArtifact,
} = require("../src/lib/intake/meeting-analysis.ts");
const { runLocalMigrations } = require("../src/lib/local/migrations.ts");
const { operatorTimezone } = require("../src/lib/operator.ts");

const at = "2026-08-28T12:00:00.000Z";

function localTimestamp(instant, timezone = operatorTimezone()) {
  const date = new Date(instant);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      timeZoneName: "longOffset",
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  const offset = parts.timeZoneName === "GMT" ? "+00:00" : parts.timeZoneName.replace("GMT", "");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

function fixture(t) {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "cove-analyst-append-")), "cove.db");
  const db = new Database(dbPath);
  runLocalMigrations(db);
  db.prepare(
    "INSERT INTO tasks(id,title,description,status,priority,due_at,project,tags,created_at,updated_at) VALUES(?,?,?,'open','medium',?,?,?,?,?)",
  ).run(
    "petrit-card", "Send Petrit the onboarding plan",
    "Petrit Krasniqi wants the plan before his team starts.\n- [ ] Draft the plan",
    "2026-09-04T17:00:00-07:00", "Atlas", JSON.stringify(["triaged", "meeting-analyst"]), at, at,
  );
  db.prepare(
    "INSERT INTO tasks(id,title,description,status,priority,project,tags,created_at,updated_at) VALUES(?,?,?,'open','low',?,?,?,?)",
  ).run("unrelated", "Renew the domain", "Annual renewal.", "Atlas", "[]", at, at);
  db.prepare(
    "INSERT INTO tasks(id,title,description,status,priority,project,tags,created_at,updated_at) VALUES(?,?,?,'done','low',?,?,?,?)",
  ).run("closed-petrit", "Old Petrit intro", "Done already.", "Atlas", "[]", at, at);
  db.close();
  const prior = { db: process.env.COVE_DB_PATH, runtime: process.env.NEXT_PUBLIC_COVE_RUNTIME, cached: globalThis.__coveDb };
  delete globalThis.__coveDb;
  process.env.COVE_DB_PATH = dbPath;
  process.env.NEXT_PUBLIC_COVE_RUNTIME = "local";
  t.after(() => {
    globalThis.__coveDb?.close();
    if (prior.cached === undefined) delete globalThis.__coveDb; else globalThis.__coveDb = prior.cached;
    if (prior.db === undefined) delete process.env.COVE_DB_PATH; else process.env.COVE_DB_PATH = prior.db;
    if (prior.runtime === undefined) delete process.env.NEXT_PUBLIC_COVE_RUNTIME; else process.env.NEXT_PUBLIC_COVE_RUNTIME = prior.runtime;
  });
  return dbPath;
}

const attendees = [{ name: "Petrit Krasniqi", email: "petrit@example.com" }];

function envelope() {
  return {
    gmailMessageId: "petrit-2", threadId: "thread-petrit-2", tool: "granola",
    title: "Petrit onboarding check-in", sender: "Granola <notes@granola.ai>",
    attendees, body: "Complete meeting transcript. ".repeat(80), receivedAt: at, durationMinutes: 45, fragment: false,
  };
}

function analystTask(overrides = {}) {
  return {
    title: "Send Petrit the onboarding plan",
    description: "Petrit asked for the agenda to go out with the plan.",
    brief: "Full brief with context and completion standard.",
    due_at: localTimestamp("2030-01-11T17:00:00Z"),
    priority: "medium",
    notification_policy: "due",
    rationale: "He asked for it in the check-in.",
    ...overrides,
  };
}

test("the analyst is shown the board: every open card by id, and the full text of the attendee's cards", (t) => {
  const dbPath = fixture(t);
  const board = loadAnalystBoardContext(attendees, { dbPath });
  assert.deepEqual(board.openTasks.map((task) => task.id).sort(), ["petrit-card", "unrelated"]);
  assert.equal("description" in board.openTasks[0], false, "the index is ids and titles, not full text");
  assert.deepEqual(board.relatedTasks.map((task) => task.id), ["petrit-card"]);
  assert.match(board.relatedTasks[0].description, /Draft the plan/);

  const schema = meetingAnalystSchema(board);
  assert.deepEqual(schema.properties.tasks.items.properties.existing_task_id.enum, ["petrit-card", "unrelated"]);
  assert.equal("existing_task_id" in meetingAnalystSchema({ openTasks: [], relatedTasks: [] }).properties.tasks.items.properties, false);
  assert.ok(MEETING_ANALYST_JSON_SCHEMA.properties.tasks.items.properties.checklist);

  const prompt = buildMeetingAnalystPrompt({
    envelopes: [envelope()], contacts: [], recentEmailThreads: [], board,
    goals: "", operatorProfile: {}, timezone: operatorTimezone(), processingTime: at,
  });
  assert.match(prompt, /BEGIN_UNTRUSTED_OPEN_TASKS_CONTENT/);
  assert.match(prompt, /BEGIN_UNTRUSTED_RELATED_TASKS_CONTENT/);
  assert.match(prompt, /set existing_task_id to that card's id/);
  assert.match(prompt, /one task with checklist lines, never one task each/);
  assert.doesNotMatch(prompt, /overdelivering/);
  assert.match(prompt, /a Friday promise is due Friday, not earlier/);
});

test("existing_task_id must name a card the analyst was shown, once", () => {
  const known = new Set(["petrit-card"]);
  const good = { meeting_summary: "s", per_contact_notes: [], waiting_on: [], research_requests: [], tasks: [analystTask({ existing_task_id: "petrit-card", checklist: ["Add the agenda"] })] };
  assert.doesNotThrow(() => validateMeetingAnalystArtifact(good, operatorTimezone(), new Date(at), known));
  assert.throws(
    () => validateMeetingAnalystArtifact({ ...good, tasks: [analystTask({ existing_task_id: "ghost" })] }, operatorTimezone(), new Date(at), known),
    /not an open card/,
  );
  assert.throws(
    () => validateMeetingAnalystArtifact({ ...good, tasks: [analystTask({ existing_task_id: "petrit-card" }), analystTask({ title: "Other", existing_task_id: "petrit-card" })] }, operatorTimezone(), new Date(at), known),
    /merge them into one update/,
  );
  // A stored artifact replays without the board it was checked against.
  assert.doesNotThrow(() => validateMeetingAnalystArtifact({ ...good, tasks: [analystTask({ existing_task_id: "ghost" })] }, operatorTimezone(), new Date(at)));
});

test("a second meeting with Petrit lands on Petrit's card instead of beside it", async (t) => {
  const dbPath = fixture(t);
  enqueueMeetingEnvelope(envelope(), { dbPath, now: new Date(at) });
  const requests = [];
  let stored = {
    id: "petrit-card", title: "Send Petrit the onboarding plan", status: "open", project: "Atlas",
    description: "Petrit Krasniqi wants the plan before his team starts.\n- [ ] Draft the plan",
    tags: ["triaged", "meeting-analyst"], due_at: "2026-09-04T17:00:00-07:00", created_at: at, updated_at: at,
  };
  const fetchImpl = async (url, init = {}) => {
    const text = String(url);
    requests.push({ url: text, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    if (text.includes("/api/day-plan")) return new Response(JSON.stringify({ csrfToken: "csrf" }));
    if (text.includes("task_columns")) return new Response(JSON.stringify([{ id: "column", name: "Not Started" }]));
    if (text.includes("/tasks?") && init.method === "PATCH") {
      const body = JSON.parse(init.body);
      assert.equal(body._expected.description, stored.description, "the write is guarded on what was read");
      assert.deepEqual(body._expected.tags, stored.tags);
      stored = { ...stored, description: body.description, tags: body.tags, updated_at: "2026-08-28T12:00:01.000Z" };
      return new Response(JSON.stringify([stored]));
    }
    if (text.includes("/tasks?") && text.includes("id=eq.petrit-card")) return new Response(JSON.stringify([stored]));
    if (text.includes("/tasks?")) return new Response("[]");
    if (text.endsWith("/api/cove-rest/tasks") && init.method === "POST") throw new Error("a second card was created");
    throw new Error(`unexpected request ${text}`);
  };
  const output = {
    meeting_summary: "Petrit confirmed the agenda.", per_contact_notes: [], waiting_on: [], research_requests: [],
    tasks: [analystTask({ existing_task_id: "petrit-card", checklist: ["Draft the plan", "Attach the team agenda"] })],
  };
  const result = await runMeetingAnalysisSweep({
    dbPath, dataDir: path.dirname(dbPath), baseUrl: "http://cove.test", fetchImpl,
    now: () => new Date(at), maxJobs: 1,
    runJobImpl: async (input) => {
      assert.deepEqual(input.schema.properties.tasks.items.properties.existing_task_id.enum, ["petrit-card", "unrelated"]);
      return { ok: true, lane: input.lane, backend: "codex-sol-high", text: JSON.stringify(output), value: output };
    },
  });
  assert.equal(result.processed, 1);
  const patches = requests.filter((request) => request.method === "PATCH");
  assert.equal(patches.length, 1);
  assert.equal(requests.some((request) => request.method === "POST" && request.url.endsWith("/tasks")), false);
  assert.match(stored.description, /^Petrit Krasniqi wants the plan before his team starts\.\n- \[ \] Draft the plan\n\nUpdate from "Petrit onboarding check-in" on .*:\nPetrit asked for the agenda to go out with the plan\.\n- \[ \] Attach the team agenda$/);
  assert.equal(stored.description.split("Draft the plan").length, 2, "a checklist line the card already has is not repeated");
  assert.equal("due_at" in patches[0].body, false, "an existing date is never moved by an append");
  const db = new Database(dbPath);
  assert.equal(db.prepare("SELECT status FROM meeting_analysis_jobs").get().status, "succeeded");
  assert.equal(db.prepare("SELECT task_id FROM inbound_events").get().task_id, "petrit-card", "the meeting event resolves to the card it landed on");
  db.close();
});
