import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runLocalMigrations } from "../src/lib/local/migrations.ts";
import {
  DEFAULT_JEV_SETTINGS,
  estimateJevCostUsd,
  jevFeatureEnabled,
  readJevCredential,
  readJevSettings,
} from "../src/lib/jev/settings.ts";
import {
  pruneJevLedger,
  readJevAssessments,
  readJevSpendSince,
  recordJevAttempt,
} from "../src/lib/jev/ledger.ts";
import {
  acquireJevLease,
  readJevBreaker,
  releaseJevLease,
  resetJevLeases,
} from "../src/lib/jev/policy.ts";
import {
  assessEmailWithJev,
  buildJevEmailQuestions,
  buildJevEmailState,
} from "../src/lib/jev/email.ts";
import { runJevEmailShadow } from "../src/lib/jev/email-shadow.ts";

const KEY = "apikey_test_do_not_use";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-jev-"));
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

function shadowSettings(overrides = {}) {
  return {
    ...DEFAULT_JEV_SETTINGS,
    mode: "shadow",
    features: { emailTriage: true, commitmentAudit: true },
    ...overrides,
  };
}

const EVIDENCE = {
  accountEmail: "alex@example.com",
  sender: "Taylor Reed <taylor@example.com>",
  subject: "Can we move tomorrow's meeting?",
  text: "Could we move tomorrow later in the day? I will send the revised deck by Friday.",
  commitments: [{
    index: 0,
    kind: "waiting_on",
    title: "Taylor sends the revised deck",
    sourceQuote: "I will send the revised deck by Friday",
  }],
};

const BASELINE = { bucket: "reply", urgent: false, chargeNotice: false };

function jevResponse(overrides = {}) {
  return {
    ok: true,
    model: "jev-1.13.0",
    latencyMs: 280,
    usage: { inputTokens: 320, outputTokens: 40 },
    answers: {
      bucket: {
        type: "choice",
        choice: "reply",
        probabilities: { reply: 0.9, action: 0.05, fyi: 0.03, noise: 0.02 },
        confidence: 0.88,
      },
      urgent: { type: "noul", noul: 0.1 },
      money_out: { type: "noul", noul: 0.02 },
      needs_reply: { type: "noul", noul: 0.94 },
      commitment_0_real: { type: "noul", noul: 0.91 },
      commitment_0_future_action: { type: "noul", noul: 0.96 },
      commitment_0_unconditional: { type: "noul", noul: 0.89 },
      commitment_0_owner: {
        type: "choice",
        choice: "sender",
        probabilities: {
          account_holder: 0.04,
          sender: 0.9,
          third_party: 0.02,
          nobody: 0.02,
          unclear: 0.02,
        },
        confidence: 0.87,
      },
    },
    ...overrides,
  };
}

test("a fresh install has Jev off and every feature off", (t) => {
  const { dir } = fixture(t);
  const settings = readJevSettings({ dataDir: dir, env: {} });
  assert.equal(settings.mode, "off");
  assert.equal(settings.features.emailTriage, false);
  assert.equal(settings.features.commitmentAudit, false);
  assert.equal(settings.model, "jev-1.13.0");
  assert.equal(jevFeatureEnabled(settings, "emailTriage", { COVE_TYPESAFE_API_KEY: KEY }), false);
});

test("a feature stays off unless the mode, the flag and a credential all agree", (t) => {
  const { dir } = fixture(t);
  writeFileSync(
    path.join(dir, "cove-jev.json"),
    JSON.stringify({ mode: "shadow", features: { emailTriage: true } }),
  );
  const settings = readJevSettings({ dataDir: dir, env: {} });
  assert.equal(settings.mode, "shadow");
  assert.equal(settings.features.emailTriage, true);
  // No credential, so still off.
  assert.equal(jevFeatureEnabled(settings, "emailTriage", {}), false);
  assert.equal(
    jevFeatureEnabled(settings, "emailTriage", { COVE_TYPESAFE_API_KEY: KEY }),
    true,
  );
  // The flag it was never given stays off.
  assert.equal(
    jevFeatureEnabled(settings, "commitmentAudit", { COVE_TYPESAFE_API_KEY: KEY }),
    false,
  );
});

test("the credential is read from the environment under both names", () => {
  assert.equal(readJevCredential({ COVE_TYPESAFE_API_KEY: KEY }), KEY);
  assert.equal(readJevCredential({ FORGE_TYPESAFE_API_KEY: KEY }), KEY);
  assert.equal(readJevCredential({ COVE_TYPESAFE_API_KEY: "   " }), undefined);
  assert.equal(readJevCredential({}), undefined);
});

test("the state carries only the email, never Cove's own records", () => {
  const state = buildJevEmailState(EVIDENCE);
  assert.deepEqual(Object.keys(state).sort(), [
    "account",
    "sender",
    "subject",
    "untrusted_email_body",
  ]);
  const serialized = JSON.stringify(state);
  for (const leak of ["voice", "profile", "pipeline", "commitment", "crm"]) {
    assert.equal(serialized.toLowerCase().includes(leak), false, `leaked ${leak}`);
  }
});

test("no question asks Jev to reason about a date", () => {
  const questions = buildJevEmailQuestions({
    evidence: EVIDENCE,
    triage: true,
    commitmentAudit: true,
  });
  // jev-1.13 treats dates as text rather than ordered quantities, so deadlines
  // stay with the frontier model and with code.
  for (const [key, question] of Object.entries(questions)) {
    const text = JSON.stringify(question).toLowerCase();
    assert.equal(
      /\bwhen is\b|\bdue date\b|\bhow many days\b|\bwhich date\b/.test(text),
      false,
      key,
    );
  }
  assert.deepEqual(Object.keys(questions).sort(), [
    "bucket",
    "commitment_0_future_action",
    "commitment_0_owner",
    "commitment_0_real",
    "commitment_0_unconditional",
    "money_out",
    "needs_reply",
    "urgent",
  ]);
  assert.deepEqual(Object.keys(questions.bucket.criteria).sort(), [
    "action",
    "fyi",
    "noise",
    "reply",
  ]);
});

test("options say what they are not for, which is what decides the boundaries", () => {
  const questions = buildJevEmailQuestions({
    evidence: EVIDENCE,
    triage: true,
    commitmentAudit: false,
  });
  // Jev reads criteria literally, so every bucket names its neighbour.
  for (const [option, criteria] of Object.entries(questions.bucket.criteria)) {
    assert.equal(typeof criteria.what, "string", option);
    assert.equal(typeof criteria.not_for, "string", option);
    assert.ok(Array.isArray(criteria.examples), option);
  }
  // The account holder cannot be inferred from the body, so it is stated.
  assert.equal(
    questions.bucket.instructions.participants.account_holder,
    "alex@example.com",
  );
});

test("turning one feature off removes only its questions", () => {
  const triageOnly = buildJevEmailQuestions({
    evidence: EVIDENCE,
    triage: true,
    commitmentAudit: false,
  });
  assert.equal("commitment_0_real" in triageOnly, false);
  assert.equal("commitment_0_future_action" in triageOnly, false);
  const auditOnly = buildJevEmailQuestions({
    evidence: EVIDENCE,
    triage: false,
    commitmentAudit: true,
  });
  assert.equal("bucket" in auditOnly, false);
  assert.equal("commitment_0_real" in auditOnly, true);
});

test("a shadow pass records agreement against what Cove already decided", async (t) => {
  const { db } = fixture(t);
  const result = await assessEmailWithJev({
    db,
    settings: shadowSettings(),
    evidence: EVIDENCE,
    baseline: BASELINE,
    refId: "message-1",
    env: { COVE_TYPESAFE_API_KEY: KEY },
    askImpl: async () => jevResponse(),
  });
  assert.equal(result.ran, true);
  assert.equal(result.recorded, 8);

  const rows = readJevAssessments({ db, refId: "message-1" });
  const byKey = Object.fromEntries(rows.map((row) => [row.questionKey, row]));
  assert.equal(byKey.bucket.choice, "reply");
  assert.equal(byKey.bucket.baseline, "reply");
  assert.equal(byKey.bucket.agreed, true);
  assert.equal(byKey.bucket.confidence, 0.88);
  // A noul row keeps the raw probability and stores no invented confidence.
  assert.equal(byKey.urgent.noul, 0.1);
  assert.equal(byKey.urgent.confidence, null);
  assert.equal(byKey.urgent.agreed, true);
  assert.equal(byKey.commitment_0_owner.baseline, "sender");
  assert.equal(byKey.commitment_0_owner.agreed, true);
  assert.equal(byKey.commitment_0_real.noul, 0.91);
  // The atomic halves explain the headline answer and are deliberately not
  // scored against a baseline Cove's classifier never produced.
  assert.equal(byKey.commitment_0_real.detail.composedVerdict, true);
  assert.equal(byKey.commitment_0_future_action.baseline, null);
  assert.equal(byKey.commitment_0_future_action.agreed, null);
  assert.equal(byKey.commitment_0_unconditional.noul, 0.89);
});

test("a disagreement is recorded rather than acted on", async (t) => {
  const { db } = fixture(t);
  const answers = jevResponse().answers;
  const result = await assessEmailWithJev({
    db,
    settings: shadowSettings(),
    evidence: EVIDENCE,
    baseline: BASELINE,
    refId: "message-2",
    env: { COVE_TYPESAFE_API_KEY: KEY },
    askImpl: async () => jevResponse({
      answers: {
        ...answers,
        bucket: { ...answers.bucket, choice: "noise" },
        commitment_0_real: { type: "noul", noul: 0.04 },
        commitment_0_unconditional: { type: "noul", noul: 0.06 },
      },
    }),
  });
  assert.equal(result.ran, true);
  const rows = readJevAssessments({ db, refId: "message-2" });
  const byKey = Object.fromEntries(rows.map((row) => [row.questionKey, row]));
  assert.equal(byKey.bucket.choice, "noise");
  assert.equal(byKey.bucket.baseline, "reply");
  assert.equal(byKey.bucket.agreed, false);
  assert.equal(byKey.commitment_0_real.agreed, false);
  // Composition happens in code: a conditional offer is not an obligation.
  assert.equal(byKey.commitment_0_real.detail.composedVerdict, false);
  // The commitment candidate itself is untouched: shadow mode records only.
  assert.equal(byKey.commitment_0_real.detail.title, "Taylor sends the revised deck");
});

test("an attempt whose usage never came back reserves spend instead of zero", (t) => {
  const { db } = fixture(t);
  recordJevAttempt({
    db,
    feature: "emailTriage",
    outcome: "jev_timeout",
    reservedInputTokens: 4_000,
    latencyMs: 3_000,
    occurredAt: "2026-09-18T12:00:00.000Z",
  });
  const window = readJevSpendSince({ db, since: "2026-09-18T00:00:00.000Z" });
  assert.equal(window.attempts, 1);
  assert.ok(window.estimatedCostUsd > 0);
  assert.equal(window.estimatedCostUsd, estimateJevCostUsd(4_000));
});

test("five transient failures trip the breaker, and it reopens for one probe", (t) => {
  const { db } = fixture(t);
  const trippedAt = new Date("2026-09-18T12:00:00.000Z");
  for (let index = 0; index < 5; index += 1) {
    recordJevAttempt({
      db,
      feature: "emailTriage",
      outcome: "jev_overloaded",
      reservedInputTokens: 10,
      latencyMs: 10,
      occurredAt: new Date(trippedAt.getTime() - index * 1_000).toISOString(),
    });
  }
  const open = readJevBreaker({
    db,
    feature: "emailTriage",
    now: new Date(trippedAt.getTime() + 60_000),
  });
  assert.equal(open.state, "open");

  const probe = readJevBreaker({
    db,
    feature: "emailTriage",
    now: new Date(trippedAt.getTime() + 6 * 60_000),
  });
  assert.equal(probe.state, "probe");

  const blocked = acquireJevLease({
    db,
    feature: "emailTriage",
    limits: DEFAULT_JEV_SETTINGS.limits,
    now: new Date(trippedAt.getTime() + 60_000),
    reservedInputTokens: 10,
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "breaker_open");
});

test("a success inside the window clears the failure run", (t) => {
  const { db } = fixture(t);
  const at = new Date("2026-09-18T12:00:00.000Z");
  for (let index = 0; index < 5; index += 1) {
    recordJevAttempt({
      db,
      feature: "emailTriage",
      outcome: "jev_overloaded",
      reservedInputTokens: 10,
      latencyMs: 10,
      occurredAt: new Date(at.getTime() - (index + 1) * 1_000).toISOString(),
    });
  }
  recordJevAttempt({
    db,
    feature: "emailTriage",
    outcome: "ok",
    usage: { inputTokens: 100, outputTokens: 10 },
    reservedInputTokens: 10,
    latencyMs: 200,
    occurredAt: at.toISOString(),
  });
  const state = readJevBreaker({
    db,
    feature: "emailTriage",
    now: new Date(at.getTime() + 1_000),
  });
  assert.equal(state.state, "closed");
});

test("a rejected credential stops the lane until configuration changes", (t) => {
  const { db } = fixture(t);
  recordJevAttempt({
    db,
    feature: "emailTriage",
    outcome: "jev_unauthorized",
    status: 401,
    reservedInputTokens: 10,
    latencyMs: 20,
    occurredAt: "2026-09-18T12:00:00.000Z",
  });
  const decision = acquireJevLease({
    db,
    feature: "emailTriage",
    limits: DEFAULT_JEV_SETTINGS.limits,
    now: new Date("2026-09-18T18:00:00.000Z"),
    reservedInputTokens: 10,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "credential_rejected");
});

test("the daily attempt ceiling is enforced from the ledger, not from memory", (t) => {
  const { db } = fixture(t);
  const limits = { ...DEFAULT_JEV_SETTINGS.limits, attemptsPerDay: 3, attemptsPerHour: 100 };
  for (let index = 0; index < 3; index += 1) {
    recordJevAttempt({
      db,
      feature: "emailTriage",
      outcome: "ok",
      usage: { inputTokens: 10, outputTokens: 1 },
      reservedInputTokens: 10,
      latencyMs: 10,
      occurredAt: new Date(Date.parse("2026-09-18T12:00:00.000Z") + index).toISOString(),
    });
  }
  const decision = acquireJevLease({
    db,
    feature: "emailTriage",
    limits,
    now: new Date("2026-09-18T13:00:00.000Z"),
    reservedInputTokens: 10,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "daily_limit");
});

test("the daily spend reservation is enforced before the call", (t) => {
  const { db } = fixture(t);
  const limits = { ...DEFAULT_JEV_SETTINGS.limits, dailySpendUsd: 0.0000001 };
  recordJevAttempt({
    db,
    feature: "emailTriage",
    outcome: "ok",
    usage: { inputTokens: 5_000, outputTokens: 10 },
    reservedInputTokens: 5_000,
    latencyMs: 10,
    occurredAt: "2026-09-18T12:00:00.000Z",
  });
  const decision = acquireJevLease({
    db,
    feature: "emailTriage",
    limits,
    now: new Date("2026-09-18T13:00:00.000Z"),
    reservedInputTokens: 5_000,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "spend_limit");
});

test("concurrent leases are capped and released", (t) => {
  const { db } = fixture(t);
  const limits = { ...DEFAULT_JEV_SETTINGS.limits, maxConcurrent: 1 };
  const now = new Date("2026-09-18T12:00:00.000Z");
  const first = acquireJevLease({
    db,
    feature: "emailTriage",
    limits,
    now,
    reservedInputTokens: 10,
  });
  assert.equal(first.allowed, true);
  const second = acquireJevLease({
    db,
    feature: "emailTriage",
    limits,
    now,
    reservedInputTokens: 10,
  });
  assert.equal(second.allowed, false);
  assert.equal(second.reason, "concurrency");
  releaseJevLease();
  const third = acquireJevLease({
    db,
    feature: "emailTriage",
    limits,
    now,
    reservedInputTokens: 10,
  });
  assert.equal(third.allowed, true);
  releaseJevLease();
});

test("a failed call still records the attempt and never throws at the caller", async (t) => {
  const { db } = fixture(t);
  const result = await assessEmailWithJev({
    db,
    settings: shadowSettings(),
    evidence: EVIDENCE,
    baseline: BASELINE,
    refId: "message-3",
    env: { COVE_TYPESAFE_API_KEY: KEY },
    askImpl: async () => {
      throw new Error("socket hang up");
    },
  });
  assert.equal(result.ran, false);
  const window = readJevSpendSince({ db, since: "2000-01-01T00:00:00.000Z" });
  assert.equal(window.attempts, 1);
  assert.equal(readJevAssessments({ db }).length, 0);
  // The lease must come back even on the throwing path.
  const decision = acquireJevLease({
    db,
    feature: "emailTriage",
    limits: { ...DEFAULT_JEV_SETTINGS.limits, maxConcurrent: 1 },
    now: new Date(),
    reservedInputTokens: 10,
  });
  assert.equal(decision.allowed, true);
  releaseJevLease();
});

test("the shadow entry point does nothing on an install that never enabled Jev", async (t) => {
  const { dir, dbPath, db } = fixture(t);
  const result = await runJevEmailShadow({
    evidence: EVIDENCE,
    baseline: BASELINE,
    refId: "message-4",
    dbPath,
    dataDir: dir,
    env: {},
  });
  assert.equal(result.ran, false);
  assert.match(result.reason, /No TypeSafe credential/);
  assert.equal(readJevAssessments({ db }).length, 0);
  assert.equal(readJevSpendSince({ db, since: "2000-01-01T00:00:00.000Z" }).attempts, 0);
});

test("a credential alone does not switch Jev on", async (t) => {
  const { dir, dbPath, db } = fixture(t);
  const result = await runJevEmailShadow({
    evidence: EVIDENCE,
    baseline: BASELINE,
    refId: "message-5",
    dbPath,
    dataDir: dir,
    env: { COVE_TYPESAFE_API_KEY: KEY },
  });
  assert.equal(result.ran, false);
  assert.match(result.reason, /Jev is off/);
  assert.equal(readJevSpendSince({ db, since: "2000-01-01T00:00:00.000Z" }).attempts, 0);
});

test("pruning drops assessment detail first and keeps usage longer", (t) => {
  const { db } = fixture(t);
  const now = new Date("2026-09-18T12:00:00.000Z");
  const old = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString();
  recordJevAttempt({
    db,
    feature: "emailTriage",
    outcome: "ok",
    usage: { inputTokens: 10, outputTokens: 1 },
    reservedInputTokens: 10,
    latencyMs: 10,
    occurredAt: old,
  });
  db.prepare(
    `INSERT INTO cove_jev_assessments
       (id, feature, mode, ref_kind, ref_id, question_key, answer_kind, choice,
        noul, confidence, baseline, agreed, detail_json, model, created_at)
     VALUES ('a1','emailTriage','shadow','email','m','bucket','choice','reply',
             NULL, 0.9, 'reply', 1, '{}', 'jev-1.13.0', ?)`,
  ).run(old);
  const pruned = pruneJevLedger({
    db,
    now,
    assessmentRetentionDays: 30,
    usageRetentionDays: 90,
  });
  assert.equal(pruned.assessments, 1);
  assert.equal(pruned.attempts, 0);
  assert.equal(readJevAssessments({ db }).length, 0);
  assert.equal(readJevSpendSince({ db, since: "2000-01-01T00:00:00.000Z" }).attempts, 1);
});
