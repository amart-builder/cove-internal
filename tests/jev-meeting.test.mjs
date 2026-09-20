import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runLocalMigrations } from "../src/lib/local/migrations.ts";
import { JEV_MAX_QUESTIONS, JEV_MAX_REQUEST_BYTES, validateJevQuestions } from "../src/lib/jev/client.ts";
import {
  DEFAULT_JEV_SETTINGS,
  jevFeatureEnabled,
  readJevSettings,
} from "../src/lib/jev/settings.ts";
import { readJevAssessments, recordJevAttempt } from "../src/lib/jev/ledger.ts";
import { resetJevLeases } from "../src/lib/jev/policy.ts";
import {
  JEV_MAX_AUDITED_MEETING_ITEMS,
  JEV_MEETING_NOTES_LIMIT,
  assessMeetingWithJev,
  buildJevMeetingState,
  composeMeetingItemVerdict,
  planJevMeetingRequest,
} from "../src/lib/jev/meeting.ts";
import { runJevMeetingShadow } from "../src/lib/jev/meeting-shadow.ts";
import {
  formatJevMeetingEvaluation,
  prepareJevMeetingCases,
  scoreJevMeetingCases,
} from "../src/lib/jev/evaluation.ts";
import { loadMeetingCases } from "../scripts/cove-jev-eval.mjs";

const KEY = "apikey_test_do_not_use";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-jev-meeting-"));
  const dbPath = path.join(dir, "cove.db");
  const db = new Database(dbPath);
  runLocalMigrations(db);
  resetJevLeases();
  t.after(() => {
    resetJevLeases();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, dbPath, db };
}

function meetingSettings(overrides = {}) {
  return {
    ...DEFAULT_JEV_SETTINGS,
    mode: "shadow",
    features: { emailTriage: false, commitmentAudit: false, meetingAudit: true },
    ...overrides,
  };
}

const EVIDENCE = {
  operator: "the operator",
  title: "Northwind pricing review",
  attendees: ["the operator", "Dana Okafor"],
  notes: "The operator said they would send a revised quote by Friday. "
    + "Dana said she would return the signed NDA once legal has seen it.",
  items: [
    {
      index: 0,
      kind: "task",
      title: "Send Northwind a revised quote",
      detail: "Apply the volume discount and send the revised quote to Dana.",
    },
    {
      index: 1,
      kind: "waiting_on",
      title: "Signed NDA from Northwind",
      detail: "Dana is returning the signed NDA after legal review.",
      counterparty: "Dana Okafor",
    },
  ],
};

const BASELINE = { fragment: false };

function owner(choice) {
  return {
    type: "choice",
    choice,
    probabilities: { operator: 0.1, another_person: 0.1, nobody: 0.1, unclear: 0.1, [choice]: 0.7 },
    confidence: 0.8,
  };
}

function meetingResponse(overrides = {}) {
  return {
    ok: true,
    model: "jev-1.13.0",
    latencyMs: 240,
    usage: { inputTokens: 900, outputTokens: 60 },
    answers: {
      notes_fragment: { type: "noul", noul: 0.05 },
      item_0_grounded: { type: "noul", noul: 0.94 },
      item_0_future_action: { type: "noul", noul: 0.92 },
      item_0_unconditional: { type: "noul", noul: 0.9 },
      item_0_owner: owner("operator"),
      item_1_grounded: { type: "noul", noul: 0.93 },
      item_1_future_action: { type: "noul", noul: 0.95 },
      item_1_unconditional: { type: "noul", noul: 0.88 },
      item_1_owner: owner("another_person"),
    },
    ...overrides,
  };
}

/* Settings ----------------------------------------------------------------- */

test("the meeting audit is off on a fresh install", (t) => {
  const { dir } = fixture(t);
  const settings = readJevSettings({ dataDir: dir, env: {} });
  assert.equal(settings.features.meetingAudit, false);
  assert.equal(
    jevFeatureEnabled(settings, "meetingAudit", { COVE_TYPESAFE_API_KEY: KEY }),
    false,
  );
});

test("the meeting audit needs the mode, its own flag and a credential", (t) => {
  const { dir } = fixture(t);
  writeFileSync(
    path.join(dir, "cove-jev.json"),
    JSON.stringify({ mode: "shadow", features: { meetingAudit: true } }),
  );
  const settings = readJevSettings({ dataDir: dir, env: {} });
  assert.equal(settings.features.meetingAudit, true);
  assert.equal(jevFeatureEnabled(settings, "meetingAudit", {}), false);
  assert.equal(
    jevFeatureEnabled(settings, "meetingAudit", { COVE_TYPESAFE_API_KEY: KEY }),
    true,
  );
  // Turning the meeting lane on does not turn the email lanes on.
  assert.equal(
    jevFeatureEnabled(settings, "emailTriage", { COVE_TYPESAFE_API_KEY: KEY }),
    false,
  );
});

test("the environment can turn the meeting audit off again", (t) => {
  const { dir } = fixture(t);
  writeFileSync(
    path.join(dir, "cove-jev.json"),
    JSON.stringify({ mode: "shadow", features: { meetingAudit: true } }),
  );
  const settings = readJevSettings({
    dataDir: dir,
    env: { COVE_JEV_MEETING_AUDIT: "0" },
  });
  assert.equal(settings.features.meetingAudit, false);
});

/* The request -------------------------------------------------------------- */

test("the state carries the meeting and nothing of Cove's own records", () => {
  const state = buildJevMeetingState(EVIDENCE);
  assert.deepEqual(Object.keys(state).sort(), [
    "attendees",
    "meeting_title",
    "operator",
    "untrusted_meeting_notes",
  ]);
  const serialized = JSON.stringify(state).toLowerCase();
  for (const leak of ["goal", "profile", "pipeline", "crm", "dossier"]) {
    assert.equal(serialized.includes(leak), false, `leaked ${leak}`);
  }
});

test("a plan asks the fragment question and four questions per item", () => {
  const plan = planJevMeetingRequest(EVIDENCE);
  assert.deepEqual(Object.keys(plan.questions).sort(), [
    "item_0_future_action",
    "item_0_grounded",
    "item_0_owner",
    "item_0_unconditional",
    "item_1_future_action",
    "item_1_grounded",
    "item_1_owner",
    "item_1_unconditional",
    "notes_fragment",
  ]);
  assert.equal(validateJevQuestions(plan.questions), undefined);
  assert.equal(plan.audited.length, 2);
  assert.deepEqual(plan.dropped, []);
});

test("no meeting question asks Jev to reason about a date", () => {
  const plan = planJevMeetingRequest(EVIDENCE);
  for (const [key, question] of Object.entries(plan.questions)) {
    const text = JSON.stringify(question).toLowerCase();
    assert.equal(
      /\bwhen is\b|\bdue date\b|\bhow many days\b|\bwhich date\b/.test(text),
      false,
      `${key} asks about a date`,
    );
  }
});

function bigItem(index) {
  return {
    index,
    kind: index % 2 === 0 ? "task" : "waiting_on",
    title: `Item ${index} `.repeat(60),
    detail: `Detail ${index} `.repeat(120),
    counterparty: `Counterparty ${index} `.repeat(20),
  };
}

test("a request that would not fit drops items rather than being rejected whole", () => {
  const evidence = {
    ...EVIDENCE,
    notes: "n".repeat(JEV_MEETING_NOTES_LIMIT * 2),
    items: Array.from({ length: 12 }, (_value, index) => bigItem(index)),
  };
  const plan = planJevMeetingRequest(evidence);
  assert.ok(plan.requestBytes <= JEV_MAX_REQUEST_BYTES, `${plan.requestBytes} bytes`);
  assert.ok(Object.keys(plan.questions).length <= JEV_MAX_QUESTIONS);
  assert.equal(validateJevQuestions(plan.questions), undefined);
  assert.ok(plan.audited.length >= 1);
  assert.equal(plan.audited.length + plan.dropped.length, 12);
  // The fragment question survives whatever else does not.
  assert.ok(plan.questions.notes_fragment);
});

test("more items than the question cap allows are dropped, in order", () => {
  const evidence = {
    ...EVIDENCE,
    items: Array.from({ length: JEV_MAX_AUDITED_MEETING_ITEMS + 3 }, (_value, index) => ({
      index,
      kind: "task",
      title: `Item ${index}`,
      detail: "Short.",
    })),
  };
  const plan = planJevMeetingRequest(evidence);
  assert.equal(plan.audited.length, JEV_MAX_AUDITED_MEETING_ITEMS);
  assert.equal(plan.dropped.length, 3);
  assert.deepEqual(plan.dropped.map((item) => item.index), [
    JEV_MAX_AUDITED_MEETING_ITEMS,
    JEV_MAX_AUDITED_MEETING_ITEMS + 1,
    JEV_MAX_AUDITED_MEETING_ITEMS + 2,
  ]);
});

/* Composition -------------------------------------------------------------- */

test("an item is real only when all three halves agree", () => {
  const all = { grounded: 0.9, futureAction: 0.9, unconditional: 0.9 };
  assert.equal(composeMeetingItemVerdict(all), true);
  assert.equal(composeMeetingItemVerdict({ ...all, grounded: 0.2 }), false);
  assert.equal(composeMeetingItemVerdict({ ...all, futureAction: 0.2 }), false);
  assert.equal(composeMeetingItemVerdict({ ...all, unconditional: 0.2 }), false);
});

test("a missing half is no verdict rather than a guess", () => {
  assert.equal(
    composeMeetingItemVerdict({ grounded: 0.9, futureAction: null, unconditional: 0.9 }),
    null,
  );
});

/* Recording ---------------------------------------------------------------- */

test("a shadow pass records every answer against what the analyst decided", async (t) => {
  const { db } = fixture(t);
  const result = await assessMeetingWithJev({
    db,
    settings: meetingSettings(),
    evidence: EVIDENCE,
    baseline: BASELINE,
    refId: "job-1",
    apiKey: KEY,
    env: { COVE_TYPESAFE_API_KEY: KEY },
    askImpl: async () => meetingResponse(),
  });
  assert.equal(result.ran, true);
  assert.equal(result.dropped, 0);
  assert.equal(result.recorded, 9);

  const rows = readJevAssessments({ db, limit: 50 });
  assert.equal(rows.length, 9);
  for (const row of rows) {
    assert.equal(row.feature, "meetingAudit");
    assert.equal(row.refKind, "meeting");
    assert.equal(row.refId, "job-1");
  }
  const byKey = Object.fromEntries(rows.map((row) => [row.questionKey, row]));
  // The analyst proposed both items, so its baseline is that both are real.
  assert.equal(byKey.item_0_grounded.baseline, "true");
  assert.equal(byKey.item_0_grounded.agreed, true);
  // A task is the operator's; a waiting-on row is somebody else's.
  assert.equal(byKey.item_0_owner.baseline, "operator");
  assert.equal(byKey.item_1_owner.baseline, "another_person");
  assert.equal(byKey.item_1_owner.agreed, true);
  // Diagnostics have nothing honest to be scored against.
  assert.equal(byKey.item_0_future_action.baseline, null);
  assert.equal(byKey.item_0_future_action.agreed, null);
  // The envelope's own fragment verdict is the baseline for the notes question.
  assert.equal(byKey.notes_fragment.baseline, "false");
  assert.equal(byKey.notes_fragment.agreed, true);
});

test("the composed verdict rides with the headline answer", async (t) => {
  const { db } = fixture(t);
  const response = meetingResponse();
  // The notes describe it, but it was only ever floated.
  response.answers.item_0_unconditional = { type: "noul", noul: 0.05 };
  await assessMeetingWithJev({
    db,
    settings: meetingSettings(),
    evidence: EVIDENCE,
    baseline: BASELINE,
    refId: "job-2",
    apiKey: KEY,
    env: { COVE_TYPESAFE_API_KEY: KEY },
    askImpl: async () => response,
  });
  const rows = readJevAssessments({ db, limit: 50 });
  const headline = rows.find((row) => row.questionKey === "item_0_grounded");
  assert.equal(headline.agreed, true);
  assert.equal(headline.detail.composedVerdict, false);
  assert.equal(headline.detail.unconditional, 0.05);
  assert.equal(headline.detail.kind, "task");
});

test("a noul answer stores no confidence, because Jev reports none", async (t) => {
  const { db } = fixture(t);
  await assessMeetingWithJev({
    db,
    settings: meetingSettings(),
    evidence: EVIDENCE,
    baseline: BASELINE,
    refId: "job-3",
    apiKey: KEY,
    env: { COVE_TYPESAFE_API_KEY: KEY },
    askImpl: async () => meetingResponse(),
  });
  const rows = readJevAssessments({ db, limit: 50 });
  for (const row of rows.filter((item) => item.answerKind === "noul")) {
    assert.equal(row.confidence, null, row.questionKey);
  }
});

/* Failing soft ------------------------------------------------------------- */

test("a disabled lane asks nothing and records nothing", async (t) => {
  const { db } = fixture(t);
  const result = await assessMeetingWithJev({
    db,
    settings: meetingSettings({ mode: "off" }),
    evidence: EVIDENCE,
    baseline: BASELINE,
    refId: "job-4",
    apiKey: KEY,
    env: { COVE_TYPESAFE_API_KEY: KEY },
    askImpl: async () => {
      throw new Error("should not be called");
    },
  });
  assert.equal(result.ran, false);
  assert.equal(readJevAssessments({ db, limit: 10 }).length, 0);
});

test("a meeting that proposed nothing is not a request", async (t) => {
  const { db } = fixture(t);
  const result = await assessMeetingWithJev({
    db,
    settings: meetingSettings(),
    evidence: { ...EVIDENCE, items: [] },
    baseline: BASELINE,
    refId: "job-5",
    apiKey: KEY,
    env: { COVE_TYPESAFE_API_KEY: KEY },
    askImpl: async () => {
      throw new Error("should not be called");
    },
  });
  assert.equal(result.ran, false);
  assert.match(result.reason, /nothing to audit/);
});

test("a transport that throws is recorded and never escapes", async (t) => {
  const { db } = fixture(t);
  const result = await assessMeetingWithJev({
    db,
    settings: meetingSettings(),
    evidence: EVIDENCE,
    baseline: BASELINE,
    refId: "job-6",
    apiKey: KEY,
    env: { COVE_TYPESAFE_API_KEY: KEY },
    askImpl: async () => {
      throw new Error("socket hang up");
    },
  });
  assert.equal(result.ran, false);
  assert.match(result.reason, /socket hang up/);
  const attempts = db.prepare("SELECT * FROM cove_jev_attempts").all();
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].feature, "meetingAudit");
  assert.equal(attempts[0].outcome, "jev_transient");
  // The lease was released, so the next meeting is not locked out.
  const again = await assessMeetingWithJev({
    db,
    settings: meetingSettings(),
    evidence: EVIDENCE,
    baseline: BASELINE,
    refId: "job-7",
    apiKey: KEY,
    env: { COVE_TYPESAFE_API_KEY: KEY },
    askImpl: async () => meetingResponse(),
  });
  assert.equal(again.ran, true);
});

test("a failed call is recorded with its code and stores no assessment", async (t) => {
  const { db } = fixture(t);
  const result = await assessMeetingWithJev({
    db,
    settings: meetingSettings(),
    evidence: EVIDENCE,
    baseline: BASELINE,
    refId: "job-8",
    apiKey: KEY,
    env: { COVE_TYPESAFE_API_KEY: KEY },
    askImpl: async () => ({
      ok: false,
      latencyMs: 120,
      error: { code: "jev_rate_limited", status: 429, message: "Too many requests." },
    }),
  });
  assert.equal(result.ran, false);
  assert.equal(readJevAssessments({ db, limit: 10 }).length, 0);
  const attempts = db.prepare("SELECT * FROM cove_jev_attempts").all();
  assert.equal(attempts[0].outcome, "jev_rate_limited");
  assert.equal(attempts[0].status, 429);
});

test("the boundary does nothing on an install that has no credential", async (t) => {
  const { dir, dbPath } = fixture(t);
  const result = await runJevMeetingShadow({
    evidence: EVIDENCE,
    baseline: BASELINE,
    refId: "job-9",
    dbPath,
    dataDir: dir,
    env: {},
  });
  assert.equal(result.ran, false);
  assert.match(result.reason, /credential/);
});

test("the boundary does nothing when only the email lanes are on", async (t) => {
  const { dir, dbPath } = fixture(t);
  writeFileSync(
    path.join(dir, "cove-jev.json"),
    JSON.stringify({ mode: "shadow", features: { emailTriage: true } }),
  );
  const result = await runJevMeetingShadow({
    evidence: EVIDENCE,
    baseline: BASELINE,
    refId: "job-10",
    dbPath,
    dataDir: dir,
    env: { COVE_TYPESAFE_API_KEY: KEY },
  });
  assert.equal(result.ran, false);
  assert.match(result.reason, /not enabled/);
});

/* The labelled cases ------------------------------------------------------- */

test("the committed meeting cases parse and carry frozen labels on both splits", () => {
  const cases = loadMeetingCases();
  assert.ok(cases.length >= 8);
  assert.ok(cases.some((item) => item.split === "dev"));
  assert.ok(cases.some((item) => item.split === "heldout"));
  // A label set that only ever says "this was real" cannot catch the failure
  // this lane exists for.
  assert.ok(cases.some((item) => item.items.some((entry) => !entry.labels.real)));
  assert.ok(cases.some((item) => item.labels.fragment));
});

test("every meeting case builds a request the API would accept, offline", () => {
  const cases = loadMeetingCases();
  const prepared = prepareJevMeetingCases(cases);
  assert.equal(prepared.length, cases.length);
  for (const item of prepared) {
    assert.equal(validateJevQuestions(item.questions), undefined, item.id);
    assert.ok(item.requestBytes < JEV_MAX_REQUEST_BYTES, item.id);
    assert.deepEqual(Object.keys(item.state).sort(), [
      "attendees",
      "meeting_title",
      "operator",
      "untrusted_meeting_notes",
    ]);
  }
});

test("an item the meeting never agreed to is named, not averaged", () => {
  const cases = loadMeetingCases().filter((item) => item.id === "meeting-floated-idea");
  const summary = scoreJevMeetingCases({
    cases,
    answersById: {
      "meeting-floated-idea": {
        notes_fragment: { type: "noul", noul: 0.05 },
        item_0_grounded: { type: "noul", noul: 0.9 },
        item_0_future_action: { type: "noul", noul: 0.9 },
        // Jev misses the hedge, so the phantom survives.
        item_0_unconditional: { type: "noul", noul: 0.8 },
        item_0_owner: owner("operator"),
      },
    },
  });
  assert.equal(summary.acceptedPhantoms.length, 1);
  assert.equal(summary.acceptedPhantoms[0].id, "meeting-floated-idea");
  assert.equal(summary.byQuestion.item_real_composed.rate, 0);
  assert.match(
    formatJevMeetingEvaluation(summary),
    /Accepted an item the meeting never agreed to/,
  );
});

test("catching the hedge is what keeps the phantom off the board", () => {
  const cases = loadMeetingCases().filter((item) => item.id === "meeting-floated-idea");
  const summary = scoreJevMeetingCases({
    cases,
    answersById: {
      "meeting-floated-idea": {
        notes_fragment: { type: "noul", noul: 0.05 },
        item_0_grounded: { type: "noul", noul: 0.9 },
        item_0_future_action: { type: "noul", noul: 0.9 },
        item_0_unconditional: { type: "noul", noul: 0.05 },
        item_0_owner: owner("nobody"),
      },
    },
  });
  assert.deepEqual(summary.acceptedPhantoms, []);
  assert.equal(summary.byQuestion.item_real_composed.rate, 1);
  assert.equal(summary.byQuestion.item_owner.rate, 1);
  assert.match(
    formatJevMeetingEvaluation(summary),
    /No item the meeting never agreed to was accepted/,
  );
});

test("a meeting with no answers is skipped rather than counted as wrong", () => {
  const summary = scoreJevMeetingCases({ cases: loadMeetingCases(), answersById: {} });
  assert.equal(summary.scored, 0);
  assert.deepEqual(summary.byQuestion, {});
  assert.match(formatJevMeetingEvaluation(summary), /Scored 0 meeting/);
});

test("a recorded meeting pass applies the retention windows to the ledger", async (t) => {
  const { db } = fixture(t);
  const day = 24 * 60 * 60 * 1000;
  const today = new Date("2026-09-20T12:00:00.000Z");
  recordJevAttempt({
    db,
    feature: "meetingAudit",
    outcome: "ok",
    reservedInputTokens: 10,
    latencyMs: 20,
    occurredAt: new Date(today.getTime() - 100 * day).toISOString(),
  });
  const run = (at, refId) => assessMeetingWithJev({
    db,
    settings: meetingSettings(),
    evidence: EVIDENCE,
    baseline: BASELINE,
    refId,
    apiKey: KEY,
    env: { COVE_TYPESAFE_API_KEY: KEY },
    askImpl: async () => meetingResponse(),
    now: () => at,
  });
  assert.equal((await run(new Date(today.getTime() - 40 * day), "old")).ran, true);
  assert.equal((await run(today, "new")).ran, true);
  assert.equal(readJevAssessments({ db, refId: "old" }).length, 0);
  assert.equal(readJevAssessments({ db, refId: "new" }).length, 9);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cove_jev_attempts").get().n, 2);
});
