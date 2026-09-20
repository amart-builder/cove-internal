/**
 * The two seams where the lanes either fire on real work or silently do not.
 *
 * Every other Jev test injects at the assessor or at the boundary. That leaves
 * the wiring itself untested, which is the one failure nobody would notice: a
 * lane that is switched on, records nothing, and reports no error. These tests
 * drive the real classification handler and the real meeting sweep, and assert
 * that the payload the lane would send is the one it should send.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createRequire } from "node:module";
import { LocalCRMBackend } from "../src/lib/crm/index.ts";
import { createEmailClassificationHandler } from "../src/lib/email/classification-job.ts";
import { observeInboundMessage } from "../src/lib/email/state-machine.ts";
import { openLocalDatabase } from "../src/lib/local/database.ts";

const require = createRequire(import.meta.url);
require("tsx/cjs");
const {
  enqueueMeetingEnvelope,
  meetingAuditItems,
  runMeetingAnalysisSweep,
} = require("../src/lib/intake/meeting-analysis.ts");
const { operatorTimezone } = require("../src/lib/operator.ts");

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "cove-jev-wiring-"));
  const previousDataDir = process.env.COVE_DATA_DIR;
  process.env.COVE_DATA_DIR = dir;
  t.after(() => {
    if (previousDataDir === undefined) delete process.env.COVE_DATA_DIR;
    else process.env.COVE_DATA_DIR = previousDataDir;
  });
  return { dir, dbPath: path.join(dir, "cove.db") };
}

/* The email seam ----------------------------------------------------------- */

function job(observed, messageId) {
  return {
    id: `job-${messageId}`,
    type: "email-classify",
    payload: {
      messageId,
      emailItemId: observed.emailItemId,
      threadVersion: observed.threadVersion,
    },
    priority: 0,
    runAfter: new Date(0).toISOString(),
    leaseUntil: null,
    attempts: 1,
    maxAttempts: 5,
    status: "leased",
    idempotencyKey: `email-classify:${messageId}`,
    createdAt: new Date(0).toISOString(),
    finishedAt: null,
    lastError: null,
  };
}

function emailHandler({ dbPath, messageId, threadId, from, jevAssessor, classification }) {
  return createEmailClassificationHandler({
    dbPath,
    accountEmail: "alex@example.com",
    gateway: {
      getMessage: async () => ({
        id: messageId,
        threadId,
        historyId: "10",
        labelIds: ["INBOX"],
        internalDate: "1000",
        headers: [
          { name: "From", value: from },
          { name: "Subject", value: "Re: the signed SOW" },
        ],
        snippet: "Attached.",
        text: "Attached is the signed SOW. I will send the invoice on Friday.",
      }),
      modifyThreadLabels: async () => {},
    },
    classifier: async () => ({
      bucket: "fyi",
      summary: "The signed SOW arrived.",
      recommendedAction: null,
      draftBody: null,
      commitments: [],
      recordCorrespondence: false,
      modelVersion: "test",
      ...classification,
    }),
    jevAssessor,
  });
}

function knownSenderWithOpenWait(dbPath) {
  const crm = new LocalCRMBackend({ dbPath });
  const created = crm.resolveOrCreateContact({
    name: "Sarah Chen",
    email: "sarah@work.com",
    source: "manual",
  });
  crm.close();
  const db = openLocalDatabase(dbPath);
  try {
    db.prepare(
      `INSERT INTO commitments
         (id, kind, title, details, source_kind, contact_id, status, created_at, updated_at)
       VALUES ('wait-sow', 'waiting_on', 'Their signed SOW', 'Sarah is returning it.',
               'detector', ?, 'open', '2026-08-03T12:00:00.000Z', '2026-08-03T12:00:00.000Z')`,
    ).run(created.contact.id);
  } finally {
    db.close();
  }
  return created.contact.id;
}

test("classifying an email hands the lane the message, the baseline and the open waits", async (t) => {
  const { dbPath } = fixture(t);
  knownSenderWithOpenWait(dbPath);
  const observed = observeInboundMessage({
    messageId: "m-wiring",
    threadId: "t-wiring",
    internalDate: "1000",
    accountEmail: "alex@example.com",
    dbPath,
  });
  const seen = [];
  const result = await emailHandler({
    dbPath,
    messageId: "m-wiring",
    threadId: "t-wiring",
    from: '"Sarah Chen" <sarah@work.com>',
    jevAssessor: async (payload) => {
      seen.push(payload);
      return { ran: false, reason: "test" };
    },
  })(job(observed, "m-wiring"));

  assert.equal(result.actions.applied, true);
  assert.equal(seen.length, 1);
  const payload = seen[0];
  // The assessment has to be traceable back to this exact email.
  assert.equal(payload.refId, "m-wiring");
  assert.equal(payload.evidence.accountEmail, "alex@example.com");
  assert.match(payload.evidence.sender, /sarah@work\.com/);
  assert.match(payload.evidence.text, /signed SOW/);
  // The baseline is what Cove's own classifier just decided, in its terms.
  assert.equal(payload.baseline.bucket, "fyi");
  assert.equal(payload.baseline.urgent, false);
  assert.equal(typeof payload.baseline.chargeNotice, "boolean");
  // The open waiting-on row reached the lane, carrying its own identifier.
  assert.deepEqual(payload.evidence.waiting, [{
    index: 0,
    id: "wait-sow",
    title: "Their signed SOW",
    detail: "Sarah is returning it.",
  }]);
});

test("an unknown sender leaves the waiting lane nothing to ask about", async (t) => {
  const { dbPath } = fixture(t);
  const observed = observeInboundMessage({
    messageId: "m-stranger",
    threadId: "t-stranger",
    internalDate: "1000",
    accountEmail: "alex@example.com",
    dbPath,
  });
  const seen = [];
  await emailHandler({
    dbPath,
    messageId: "m-stranger",
    threadId: "t-stranger",
    from: "Stranger Person <stranger@example.com>",
    jevAssessor: async (payload) => {
      seen.push(payload);
      return { ran: false, reason: "test" };
    },
  })(job(observed, "m-stranger"));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].evidence.waiting, []);
});

test("a lane that throws does not fail the classification job", async (t) => {
  const { dbPath } = fixture(t);
  knownSenderWithOpenWait(dbPath);
  const observed = observeInboundMessage({
    messageId: "m-throws",
    threadId: "t-throws",
    internalDate: "1000",
    accountEmail: "alex@example.com",
    dbPath,
  });
  const result = await emailHandler({
    dbPath,
    messageId: "m-throws",
    threadId: "t-throws",
    from: '"Sarah Chen" <sarah@work.com>',
    jevAssessor: async () => {
      throw new Error("the lane exploded");
    },
  })(job(observed, "m-throws"));
  // The operator-visible write already landed, and it stays landed.
  assert.equal(result.actions.applied, true);
  const db = openLocalDatabase(dbPath);
  try {
    const state = db.prepare(
      "SELECT state FROM cove_email_messages WHERE message_id = 'm-throws'",
    ).get();
    assert.equal(state.state, "processed");
  } finally {
    db.close();
  }
});

/* The meeting seam --------------------------------------------------------- */

function localTimestamp(instant, timezone = operatorTimezone()) {
  const date = new Date(instant);
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date).filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const zone = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  }).formatToParts(date).find((part) => part.type === "timeZoneName").value
    .replace(/^GMT/, "") || "Z";
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}${
    zone === "+00:00" ? "Z" : zone
  }`;
}

function meetingEnvelope(messageId, receivedAt) {
  return {
    gmailMessageId: messageId,
    threadId: `thread-${messageId}`,
    tool: "granola",
    title: "Launch planning",
    sender: "Granola <notes@granola.ai>",
    attendees: [{ name: "Pat External", email: "pat@example.com" }],
    body: "Complete meeting transcript. ".repeat(80),
    receivedAt,
    durationMinutes: 45,
    fragment: false,
  };
}

const MEETING_ARTIFACT = {
  meeting_summary: "The operator agreed on the next launch step.",
  per_contact_notes: [],
  tasks: [{
    title: "Send the launch checklist",
    description: "Send Pat the launch checklist before the freeze.",
    brief: "Send the launch checklist with the full context and standard.",
    due_at: localTimestamp("2030-01-11T17:00:00Z"),
    priority: "high",
    notification_policy: "both",
    remind_at: localTimestamp("2030-01-11T16:00:00Z"),
    rationale: "Pat asked for it on the call.",
  }],
  waiting_on: [{
    counterparty: "Pat External",
    title: "Pat's signed order form",
    detail: "Pat is returning the signed order form this week.",
  }],
  research_requests: [],
};

async function runSweep({ dbPath, at, jevAuditor, actionsRun }) {
  return runMeetingAnalysisSweep({
    dbPath,
    dataDir: path.dirname(dbPath),
    baseUrl: "http://127.0.0.1:3200",
    now: () => new Date(at),
    runJobImpl: async () => ({ ok: true, value: MEETING_ARTIFACT }),
    executeActionImpl: async (action) => {
      actionsRun.push(action.kind);
      return `target-${action.action_key}`;
    },
    jevAuditor,
    maxJobs: 1,
  });
}

test("the meeting lane is handed every proposed item, after they have all been written", async (t) => {
  const { dbPath } = fixture(t);
  const at = "2026-08-28T12:00:00.000Z";
  enqueueMeetingEnvelope(meetingEnvelope("wiring-meeting", at), { dbPath, now: new Date(at) });
  const seen = [];
  const actionsRun = [];
  const result = await runSweep({
    dbPath,
    at,
    actionsRun,
    jevAuditor: async (payload) => {
      // Captured at call time: every side effect is already done.
      seen.push({ payload, actionsSoFar: [...actionsRun] });
      return { ran: false, reason: "test" };
    },
  });

  assert.equal(result.processed, 1);
  assert.equal(seen.length, 1);
  const { payload, actionsSoFar } = seen[0];
  // The audit runs last. Nothing the operator is waiting on was delayed by it.
  assert.equal(actionsSoFar.length, 2);
  assert.deepEqual([...actionsSoFar].sort(), ["commitment", "task"]);
  assert.equal(payload.baseline.fragment, false);
  assert.equal(payload.evidence.title, "Launch planning");
  assert.ok(payload.evidence.attendees.includes("Pat External"));
  assert.match(payload.evidence.notes, /Complete meeting transcript/);
  // Tasks first, then waiting-on rows, with stable indices.
  assert.deepEqual(payload.evidence.items, [
    {
      index: 0,
      kind: "task",
      title: "Send the launch checklist",
      detail: "Send Pat the launch checklist before the freeze.",
    },
    {
      index: 1,
      kind: "waiting_on",
      title: "Pat's signed order form",
      detail: "Pat is returning the signed order form this week.",
      counterparty: "Pat External",
    },
  ]);
  // The assessment is traceable back to the analysis job that produced it.
  const db = new Database(dbPath);
  try {
    const jobId = db.prepare("SELECT id FROM meeting_analysis_jobs").pluck().get();
    assert.equal(payload.refId, jobId);
  } finally {
    db.close();
  }
});

test("a meeting lane that throws does not fail the analysis job", async (t) => {
  const { dbPath } = fixture(t);
  const at = "2026-08-28T12:00:00.000Z";
  enqueueMeetingEnvelope(meetingEnvelope("wiring-throws", at), { dbPath, now: new Date(at) });
  const result = await runSweep({
    dbPath,
    at,
    actionsRun: [],
    jevAuditor: async () => {
      throw new Error("the lane exploded");
    },
  });
  assert.equal(result.processed, 1);
  assert.equal(result.failed, 0);
  const db = new Database(dbPath);
  try {
    assert.equal(
      db.prepare("SELECT status FROM meeting_analysis_jobs").pluck().get(),
      "succeeded",
    );
  } finally {
    db.close();
  }
});

test("a meeting that proposed nothing never reaches the lane", async (t) => {
  const { dbPath } = fixture(t);
  const at = "2026-08-28T12:00:00.000Z";
  enqueueMeetingEnvelope(meetingEnvelope("wiring-empty", at), { dbPath, now: new Date(at) });
  const seen = [];
  await runMeetingAnalysisSweep({
    dbPath,
    dataDir: path.dirname(dbPath),
    baseUrl: "http://127.0.0.1:3200",
    now: () => new Date(at),
    runJobImpl: async () => ({
      ok: true,
      value: { ...MEETING_ARTIFACT, tasks: [], waiting_on: [] },
    }),
    executeActionImpl: async () => null,
    jevAuditor: async (payload) => {
      seen.push(payload);
      return { ran: false, reason: "test" };
    },
    maxJobs: 1,
  });
  assert.deepEqual(seen, []);
});

test("the flattener caps what one meeting can put in front of the lane", () => {
  const items = meetingAuditItems({
    ...MEETING_ARTIFACT,
    tasks: Array.from({ length: 5 }, (_value, index) => ({
      ...MEETING_ARTIFACT.tasks[0],
      title: `Task ${index}`,
    })),
    waiting_on: Array.from({ length: 5 }, (_value, index) => ({
      ...MEETING_ARTIFACT.waiting_on[0],
      title: `Waiting ${index}`,
    })),
  });
  assert.equal(items.length, 6);
  assert.deepEqual(items.map((item) => item.index), [0, 1, 2, 3, 4, 5]);
  // Tasks are the ones that land on the operator's board, so they go first.
  assert.equal(items.filter((item) => item.kind === "task").length, 5);
  assert.equal(items.filter((item) => item.kind === "waiting_on").length, 1);
});
