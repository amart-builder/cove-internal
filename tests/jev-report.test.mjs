import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runLocalMigrations } from "../src/lib/local/migrations.ts";
import { recordJevAttempt } from "../src/lib/jev/ledger.ts";
import { buildJevReport, formatJevReport } from "../src/lib/jev/report.ts";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-jev-report-"));
  const db = new Database(path.join(dir, "cove.db"));
  runLocalMigrations(db);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

function assessment(db, overrides = {}) {
  const row = {
    id: `a${Math.random().toString(36).slice(2)}`,
    feature: "emailTriage",
    mode: "shadow",
    refKind: "email",
    refId: "m1",
    questionKey: "bucket",
    answerKind: "choice",
    choice: "reply",
    noul: null,
    confidence: 0.9,
    baseline: "reply",
    agreed: 1,
    detail: "{}",
    model: "jev-1.13.0",
    createdAt: "2026-09-18T12:00:00.000Z",
    ...overrides,
  };
  db.prepare(
    `INSERT INTO cove_jev_assessments
       (id, feature, mode, ref_kind, ref_id, question_key, answer_kind, choice,
        noul, confidence, baseline, agreed, detail_json, model, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.id,
    row.feature,
    row.mode,
    row.refKind,
    row.refId,
    row.questionKey,
    row.answerKind,
    row.choice,
    row.noul,
    row.confidence,
    row.baseline,
    row.agreed,
    row.detail,
    row.model,
    row.createdAt,
  );
}

test("agreement is counted per question and disagreements are listed", (t) => {
  const db = fixture(t);
  for (let index = 0; index < 8; index += 1) assessment(db, { refId: `m${index}` });
  assessment(db, { refId: "m8", choice: "noise", agreed: 0, confidence: 0.55 });
  assessment(db, { refId: "m9", choice: "fyi", agreed: 0, confidence: 0.4 });

  const report = buildJevReport({ db, since: "2026-09-01T00:00:00.000Z" });
  const bucket = report.questions.find((row) => row.questionKey === "bucket");
  assert.equal(bucket.total, 10);
  assert.equal(bucket.comparable, 10);
  assert.equal(bucket.agreed, 8);
  assert.equal(bucket.agreementRate, 0.8);
  assert.equal(bucket.disagreements.length, 2);
  assert.deepEqual(
    bucket.disagreements.map((row) => row.jev).sort(),
    ["fyi", "noise"],
  );
  assert.equal(bucket.disagreements[0].cove, "reply");
});

test("per-candidate commitment questions are reported as one question", (t) => {
  const db = fixture(t);
  assessment(db, {
    feature: "commitmentAudit",
    questionKey: "commitment_0_real",
    answerKind: "noul",
    choice: null,
    noul: 0.95,
    confidence: null,
    baseline: "true",
    agreed: 1,
  });
  assessment(db, {
    feature: "commitmentAudit",
    questionKey: "commitment_1_real",
    answerKind: "noul",
    choice: null,
    noul: 0.1,
    confidence: null,
    baseline: "true",
    agreed: 0,
  });
  const report = buildJevReport({ db, since: "2026-09-01T00:00:00.000Z" });
  const keys = report.questions.map((row) => row.questionKey);
  assert.deepEqual(keys, ["commitment_real"]);
  assert.equal(report.questions[0].total, 2);
  assert.equal(report.questions[0].agreementRate, 0.5);
});

test("reported probability is banded so calibration can be read", (t) => {
  const db = fixture(t);
  // Confident and right.
  for (let index = 0; index < 4; index += 1) {
    assessment(db, { refId: `h${index}`, confidence: 0.95, agreed: 1 });
  }
  // Unsure and wrong, which is the shape a usable threshold depends on.
  for (let index = 0; index < 4; index += 1) {
    assessment(db, { refId: `l${index}`, confidence: 0.35, agreed: 0, choice: "noise" });
  }
  const report = buildJevReport({ db, since: "2026-09-01T00:00:00.000Z" });
  const bands = report.questions[0].calibration;
  const high = bands.find((band) => band.from === 0.9);
  const low = bands.find((band) => band.from === 0.3);
  assert.equal(high.count, 4);
  assert.equal(high.agreementRate, 1);
  assert.equal(low.count, 4);
  assert.equal(low.agreementRate, 0);
});

test("attempts report latency, failures and reserved spend", (t) => {
  const db = fixture(t);
  const at = "2026-09-18T12:00:00.000Z";
  for (const latency of [200, 300, 400, 900]) {
    recordJevAttempt({
      db,
      feature: "emailTriage",
      outcome: "ok",
      usage: { inputTokens: 300, outputTokens: 20 },
      reservedInputTokens: 4_000,
      latencyMs: latency,
      occurredAt: at,
    });
  }
  recordJevAttempt({
    db,
    feature: "emailTriage",
    outcome: "jev_overloaded",
    status: 529,
    reservedInputTokens: 4_000,
    latencyMs: 3_000,
    occurredAt: at,
  });
  const report = buildJevReport({ db, since: "2026-09-01T00:00:00.000Z" });
  assert.equal(report.attempts.attempts, 5);
  assert.equal(report.attempts.succeeded, 4);
  assert.deepEqual(report.attempts.failuresByCode, { jev_overloaded: 1 });
  assert.equal(report.attempts.unknownUsage, 1);
  // Five attempts, including the 3,000 ms failure: 200, 300, 400, 900, 3000.
  assert.equal(report.attempts.medianLatencyMs, 400);
  assert.equal(report.attempts.p95LatencyMs, 3_000);
  assert.ok(report.attempts.estimatedCostUsd > 0);
});

test("the readout says plainly that agreement is not accuracy", (t) => {
  const db = fixture(t);
  assessment(db);
  const text = formatJevReport(buildJevReport({ db, since: "2026-09-01T00:00:00.000Z" }));
  assert.match(text, /agreement with Cove's current classifier/);
  assert.match(text, /not ground/);
  assert.match(text, /bucket \(emailTriage, choice\)/);
});

test("an empty window reports nothing rather than a misleading zero rate", (t) => {
  const db = fixture(t);
  const report = buildJevReport({ db, since: "2026-09-01T00:00:00.000Z" });
  assert.deepEqual(report.questions, []);
  assert.equal(report.attempts.attempts, 0);
  assert.match(formatJevReport(report), /No assessments were recorded/);
});
