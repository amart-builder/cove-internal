import assert from "node:assert/strict";
import test from "node:test";
import {
  JEV_MAX_REQUEST_BYTES,
  validateJevQuestions,
} from "../src/lib/jev/client.ts";
import {
  formatJevEvaluation,
  prepareJevEmailCases,
  scoreJevEmailCases,
} from "../src/lib/jev/evaluation.ts";
import { loadCases } from "../scripts/cove-jev-eval.mjs";

const cases = loadCases();

test("the committed cases parse and carry frozen labels on both splits", () => {
  assert.ok(cases.length >= 10);
  assert.ok(cases.some((item) => item.split === "dev"));
  assert.ok(cases.some((item) => item.split === "heldout"));
  for (const item of cases) {
    assert.ok(["reply", "action", "fyi", "noise"].includes(item.labels.bucket), item.id);
    assert.equal(typeof item.labels.urgent, "boolean", item.id);
  }
});

test("every case builds a request the API would accept, offline", () => {
  const prepared = prepareJevEmailCases(cases);
  assert.equal(prepared.length, cases.length);
  for (const item of prepared) {
    assert.equal(validateJevQuestions(item.questions), undefined, item.id);
    assert.ok(item.requestBytes < JEV_MAX_REQUEST_BYTES, item.id);
    // The state is the email and nothing else.
    assert.deepEqual(Object.keys(item.state).sort(), [
      "account",
      "sender",
      "subject",
      "untrusted_email_body",
    ]);
  }
});

test("a case with no commitment asks no commitment question", () => {
  const prepared = prepareJevEmailCases(cases);
  const plain = prepared.find((item) => item.id === "noise-newsletter");
  assert.deepEqual(Object.keys(plain.questions).sort(), [
    "bucket",
    "money_out",
    "needs_reply",
    "urgent",
  ]);
});

function noul(value) {
  return { type: "noul", noul: value };
}

test("scoring compares answers against the frozen labels", () => {
  const subject = cases.filter((item) =>
    item.id === "reply-client-question" || item.id === "noise-newsletter"
  );
  const summary = scoreJevEmailCases({
    cases: subject,
    answersById: {
      "reply-client-question": {
        bucket: {
          type: "choice",
          choice: "reply",
          probabilities: { reply: 0.9, action: 0.1 },
          confidence: 0.9,
        },
        urgent: noul(0.05),
        money_out: noul(0.01),
        needs_reply: noul(0.97),
      },
      "noise-newsletter": {
        bucket: {
          type: "choice",
          choice: "noise",
          probabilities: { noise: 0.95, fyi: 0.05 },
          confidence: 0.95,
        },
        urgent: noul(0.02),
        money_out: noul(0.01),
        needs_reply: noul(0.03),
      },
    },
  });
  assert.equal(summary.scored, 2);
  assert.equal(summary.byQuestion.bucket.rate, 1);
  assert.equal(summary.byQuestion.needs_reply.rate, 1);
  assert.deepEqual(summary.missedRequests, []);
});

test("an email that needed the operator and was dismissed is named, not averaged", () => {
  const subject = cases.filter((item) => item.id === "reply-client-question");
  const summary = scoreJevEmailCases({
    cases: subject,
    answersById: {
      "reply-client-question": {
        bucket: {
          type: "choice",
          choice: "noise",
          probabilities: { noise: 0.8, reply: 0.2 },
          confidence: 0.8,
        },
        urgent: noul(0.02),
        money_out: noul(0.01),
        needs_reply: noul(0.1),
      },
    },
  });
  assert.equal(summary.missedRequests.length, 1);
  assert.equal(summary.missedRequests[0].id, "reply-client-question");
  assert.equal(summary.missedRequests[0].expected, "reply");
  assert.equal(summary.missedRequests[0].got, "noise");
  assert.match(formatJevEvaluation(summary), /Dismissed an email that needed the operator/);
});

test("composing the atomic halves is scored beside the direct answer", () => {
  const subject = cases.filter((item) => item.id === "commitment-pleasantry-is-not-real");
  const answers = {
    bucket: {
      type: "choice",
      choice: "fyi",
      probabilities: { fyi: 0.9, noise: 0.1 },
      confidence: 0.9,
    },
    urgent: noul(0.02),
    money_out: noul(0.01),
    needs_reply: noul(0.1),
    // The broad question gets it wrong: the sentence mentions a deliverable.
    commitment_0_real: noul(0.8),
    commitment_0_future_action: noul(0.9),
    // The atomic half catches it: the offer is conditional on being asked.
    commitment_0_unconditional: noul(0.05),
    commitment_0_owner: {
      type: "choice",
      choice: "nobody",
      probabilities: { nobody: 0.7, sender: 0.3 },
      confidence: 0.7,
    },
  };
  const summary = scoreJevEmailCases({
    cases: subject,
    answersById: { "commitment-pleasantry-is-not-real": answers },
  });
  assert.equal(summary.byQuestion.commitment_real.rate, 0);
  assert.equal(summary.byQuestion.commitment_real_composed.rate, 1);
  assert.equal(summary.byQuestion.commitment_owner.rate, 1);
});

test("a case with no answers is skipped rather than counted as wrong", () => {
  const summary = scoreJevEmailCases({ cases, answersById: {} });
  assert.equal(summary.scored, 0);
  assert.deepEqual(summary.byQuestion, {});
  assert.match(formatJevEvaluation(summary), /Scored 0 case/);
});
