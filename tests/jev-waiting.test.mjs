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
import { readJevAssessments } from "../src/lib/jev/ledger.ts";
import { resetJevLeases } from "../src/lib/jev/policy.ts";
import {
  assessEmailWithJev,
  planJevEmailRequest,
  readWaitingAnswers,
} from "../src/lib/jev/email.ts";
import {
  buildJevWaitingOutcomes,
  formatJevWaitingReport,
} from "../src/lib/jev/report.ts";

const KEY = "apikey_test_do_not_use";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-jev-waiting-"));
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

function settings(features = {}) {
  return {
    ...DEFAULT_JEV_SETTINGS,
    mode: "shadow",
    features: {
      emailTriage: false,
      commitmentAudit: false,
      meetingAudit: false,
      waitingResolution: true,
      ...features,
    },
  };
}

const EVIDENCE = {
  accountEmail: "operator@example.com",
  sender: "Dana Okafor <dana@example.com>",
  subject: "Re: NDA",
  text: "Attached is the countersigned NDA. Sorry for the wait.",
  waiting: [
    { index: 0, id: "cmt-nda", title: "Signed NDA from Northwind", detail: "Dana is returning it after legal review." },
    { index: 1, id: "cmt-quote", title: "Updated pricing sheet", detail: null },
  ],
};

const BASELINE = { bucket: "fyi", urgent: false, chargeNotice: false };

function waitingAnswers(overrides = {}) {
  return {
    ok: true,
    model: "jev-1.13.0",
    latencyMs: 210,
    usage: { inputTokens: 400, outputTokens: 30 },
    answers: {
      waiting_0_delivered: { type: "noul", noul: 0.95 },
      waiting_0_still_outstanding: { type: "noul", noul: 0.04 },
      waiting_1_delivered: { type: "noul", noul: 0.03 },
      waiting_1_still_outstanding: { type: "noul", noul: 0.93 },
      ...overrides,
    },
  };
}

/* Settings ----------------------------------------------------------------- */

test("waiting resolution is off on a fresh install", (t) => {
  const { dir } = fixture(t);
  const stored = readJevSettings({ dataDir: dir, env: {} });
  assert.equal(stored.features.waitingResolution, false);
  assert.equal(
    jevFeatureEnabled(stored, "waitingResolution", { COVE_TYPESAFE_API_KEY: KEY }),
    false,
  );
});

test("waiting resolution can be turned on without the other lanes", (t) => {
  const { dir } = fixture(t);
  writeFileSync(
    path.join(dir, "cove-jev.json"),
    JSON.stringify({ mode: "shadow", features: { waitingResolution: true } }),
  );
  const stored = readJevSettings({ dataDir: dir, env: {} });
  const env = { COVE_TYPESAFE_API_KEY: KEY };
  assert.equal(jevFeatureEnabled(stored, "waitingResolution", env), true);
  assert.equal(jevFeatureEnabled(stored, "emailTriage", env), false);
  assert.equal(jevFeatureEnabled(stored, "meetingAudit", env), false);
});

/* The request -------------------------------------------------------------- */

test("each open waiting row gets both halves of the question", () => {
  const plan = planJevEmailRequest({
    evidence: EVIDENCE,
    triage: false,
    commitmentAudit: false,
    waitingResolution: true,
  });
  assert.deepEqual(Object.keys(plan.questions).sort(), [
    "waiting_0_delivered",
    "waiting_0_still_outstanding",
    "waiting_1_delivered",
    "waiting_1_still_outstanding",
  ]);
  assert.equal(validateJevQuestions(plan.questions), undefined);
  assert.equal(plan.auditedWaiting.length, 2);
  assert.deepEqual(plan.dropped, []);
});

test("the waiting questions never ask when anything is due", () => {
  const plan = planJevEmailRequest({
    evidence: EVIDENCE,
    triage: false,
    commitmentAudit: false,
    waitingResolution: true,
  });
  for (const [key, question] of Object.entries(plan.questions)) {
    const text = JSON.stringify(question).toLowerCase();
    assert.equal(
      /\bwhen is\b|\bdue date\b|\bhow many days\b|\bhow long ago\b/.test(text),
      false,
      `${key} asks about a date`,
    );
  }
});

test("an over-budget request drops waiting rows before commitment candidates", () => {
  const evidence = {
    ...EVIDENCE,
    text: "x".repeat(6_000),
    commitments: Array.from({ length: 5 }, (_value, index) => ({
      index,
      kind: "follow_up",
      title: `Commitment ${index} `.repeat(20),
      sourceQuote: `Quote ${index} `.repeat(40),
    })),
    waiting: Array.from({ length: 6 }, (_value, index) => ({
      index,
      id: `cmt-${index}`,
      title: `Waiting ${index} `.repeat(20),
      detail: `Detail ${index} `.repeat(40),
    })),
  };
  const plan = planJevEmailRequest({
    evidence,
    triage: true,
    commitmentAudit: true,
    waitingResolution: true,
  });
  assert.ok(plan.requestBytes <= JEV_MAX_REQUEST_BYTES, `${plan.requestBytes} bytes`);
  assert.ok(Object.keys(plan.questions).length <= JEV_MAX_QUESTIONS);
  assert.equal(validateJevQuestions(plan.questions), undefined);
  // Triage is the judgment the lane exists to compare against, so it survives.
  for (const key of ["bucket", "urgent", "money_out", "needs_reply"]) {
    assert.ok(plan.questions[key], `${key} was dropped`);
  }
  assert.ok(plan.dropped.length > 0);
  // Everything dropped before the first commitment is a waiting row.
  const firstCommitment = plan.dropped.findIndex((key) => key.startsWith("commitment:"));
  const beforeCommitments = firstCommitment === -1
    ? plan.dropped
    : plan.dropped.slice(0, firstCommitment);
  for (const key of beforeCommitments) {
    assert.match(key, /^waiting:/);
  }
});

/* Composition -------------------------------------------------------------- */

test("the verdict says whether the wait is over, and the reason says why", () => {
  assert.deepEqual(
    readWaitingAnswers({ delivered: 0.9, stillOutstanding: 0.05 }),
    { resolved: true, reason: "arrived" },
  );
  // Called off rather than delivered. The wait is over either way, and the
  // operator needs to be told which it was.
  assert.deepEqual(
    readWaitingAnswers({ delivered: 0.1, stillOutstanding: 0.05 }),
    { resolved: true, reason: "no_longer_owed" },
  );
  // Part of it arrived, so the commitment stays open.
  assert.deepEqual(
    readWaitingAnswers({ delivered: 0.9, stillOutstanding: 0.8 }),
    { resolved: false, reason: "partly_arrived" },
  );
  assert.deepEqual(
    readWaitingAnswers({ delivered: 0.1, stillOutstanding: 0.9 }),
    { resolved: false, reason: "still_coming" },
  );
  assert.deepEqual(
    readWaitingAnswers({ delivered: null, stillOutstanding: 0.9 }),
    { resolved: null, reason: null },
  );
});

/* Recording ---------------------------------------------------------------- */

test("waiting answers are written against the commitment, not the email", async (t) => {
  const { db } = fixture(t);
  const result = await assessEmailWithJev({
    db,
    settings: settings(),
    evidence: EVIDENCE,
    baseline: BASELINE,
    refId: "msg-1",
    apiKey: KEY,
    env: { COVE_TYPESAFE_API_KEY: KEY },
    askImpl: async () => waitingAnswers(),
  });
  assert.equal(result.ran, true);
  assert.equal(result.recorded, 4);

  const rows = readJevAssessments({ db, limit: 20 });
  for (const row of rows) {
    assert.equal(row.feature, "waitingResolution");
    assert.equal(row.refKind, "commitment");
    // Nothing in Cove answers this today, so there is no baseline to agree with.
    assert.equal(row.baseline, null);
    assert.equal(row.agreed, null);
  }
  const delivered = rows.filter((row) => row.questionKey === "waiting_delivered");
  assert.deepEqual(delivered.map((row) => row.refId).sort(), ["cmt-nda", "cmt-quote"]);
  const nda = delivered.find((row) => row.refId === "cmt-nda");
  assert.equal(nda.detail.composedVerdict, true);
  assert.equal(nda.detail.reason, "arrived");
  assert.equal(nda.detail.messageId, "msg-1");
  const quote = delivered.find((row) => row.refId === "cmt-quote");
  assert.equal(quote.detail.composedVerdict, false);
  assert.equal(quote.detail.reason, "still_coming");
});

test("a partial delivery does not resolve the commitment", async (t) => {
  const { db } = fixture(t);
  await assessEmailWithJev({
    db,
    settings: settings(),
    evidence: EVIDENCE,
    baseline: BASELINE,
    refId: "msg-2",
    apiKey: KEY,
    env: { COVE_TYPESAFE_API_KEY: KEY },
    // The first half arrived; the rest follows next week.
    askImpl: async () => waitingAnswers({ waiting_0_still_outstanding: { type: "noul", noul: 0.88 } }),
  });
  const rows = readJevAssessments({ db, limit: 20 });
  const nda = rows.find((row) =>
    row.refId === "cmt-nda" && row.questionKey === "waiting_delivered"
  );
  assert.equal(nda.detail.delivered, 0.95);
  assert.equal(nda.detail.stillOutstanding, 0.88);
  assert.equal(nda.detail.composedVerdict, false);
  assert.equal(nda.detail.reason, "partly_arrived");
});

test("an email with no open waiting rows asks nothing of this lane", async (t) => {
  const { db } = fixture(t);
  const result = await assessEmailWithJev({
    db,
    settings: settings(),
    evidence: { ...EVIDENCE, waiting: [] },
    baseline: BASELINE,
    refId: "msg-3",
    apiKey: KEY,
    env: { COVE_TYPESAFE_API_KEY: KEY },
    askImpl: async () => {
      throw new Error("should not be called");
    },
  });
  assert.equal(result.ran, false);
  assert.match(result.reason, /Nothing to ask/);
});

/* The outcome report ------------------------------------------------------- */

function commitment(db, id, status, updatedAt) {
  db.prepare(
    `INSERT INTO commitments
       (id, kind, title, source_kind, status, created_at, updated_at)
     VALUES (?, 'waiting_on', ?, 'detector', ?, ?, ?)`,
  ).run(id, `Commitment ${id}`, status, "2026-09-01T00:00:00.000Z", updatedAt);
}

function reading(db, id, composedVerdict, createdAt) {
  db.prepare(
    `INSERT INTO cove_jev_assessments
       (id, feature, mode, ref_kind, ref_id, question_key, answer_kind, noul,
        baseline, agreed, detail_json, model, created_at)
     VALUES (?, 'waitingResolution', 'shadow', 'commitment', ?, 'waiting_delivered',
             'noul', 0.9, NULL, NULL, ?, 'jev-1.13.0', ?)`,
  ).run(
    `row-${id}-${createdAt}`,
    id,
    JSON.stringify({ title: `Commitment ${id}`, composedVerdict, messageId: "m" }),
    createdAt,
  );
}

test("the operator's own later action is what scores this lane", (t) => {
  const { db } = fixture(t);
  // Jev read it as delivered and the operator later closed it, two days on.
  commitment(db, "c-confirmed", "done", "2026-09-12T00:00:00.000Z");
  reading(db, "c-confirmed", true, "2026-09-10T00:00:00.000Z");
  // Jev read it as delivered and it is still sitting open.
  commitment(db, "c-unconfirmed", "open", "2026-09-10T00:00:00.000Z");
  reading(db, "c-unconfirmed", true, "2026-09-10T00:00:00.000Z");
  // Jev read it as still owed and the operator closed it anyway.
  commitment(db, "c-missed", "done", "2026-09-11T00:00:00.000Z");
  reading(db, "c-missed", false, "2026-09-10T00:00:00.000Z");
  // Jev read it as still owed and it is still open.
  commitment(db, "c-consistent", "open", "2026-09-10T00:00:00.000Z");
  reading(db, "c-consistent", false, "2026-09-10T00:00:00.000Z");

  const report = buildJevWaitingOutcomes({ db, since: "2026-09-01T00:00:00.000Z" });
  assert.equal(report.total, 4);
  assert.deepEqual(report.confirmed.map((row) => row.commitmentId), ["c-confirmed"]);
  assert.deepEqual(report.unconfirmed.map((row) => row.commitmentId), ["c-unconfirmed"]);
  assert.deepEqual(report.missed.map((row) => row.commitmentId), ["c-missed"]);
  assert.deepEqual(report.consistent.map((row) => row.commitmentId), ["c-consistent"]);
  assert.equal(report.confirmed[0].daysAhead, 2);
  assert.equal(report.medianDaysAhead, 2);

  const text = formatJevWaitingReport(report);
  assert.match(text, /Still open although Jev read the thing as delivered/);
  assert.match(text, /Closed by the operator although Jev read it as still owed/);
  assert.match(text, /Nothing here is accuracy/);
});

test("a reading whose commitment Cove no longer holds is not scored either way", (t) => {
  const { db } = fixture(t);
  reading(db, "c-gone", true, "2026-09-10T00:00:00.000Z");
  const report = buildJevWaitingOutcomes({ db, since: "2026-09-01T00:00:00.000Z" });
  assert.equal(report.total, 1);
  assert.equal(report.confirmed.length, 0);
  assert.equal(report.unconfirmed.length, 0);
  assert.equal(report.missed.length, 0);
  assert.equal(report.consistent.length, 0);
  assert.equal(report.medianDaysAhead, null);
});

test("readings older than the window are left out", (t) => {
  const { db } = fixture(t);
  commitment(db, "c-old", "done", "2026-08-02T00:00:00.000Z");
  reading(db, "c-old", true, "2026-08-01T00:00:00.000Z");
  const report = buildJevWaitingOutcomes({ db, since: "2026-09-01T00:00:00.000Z" });
  assert.equal(report.total, 0);
});
