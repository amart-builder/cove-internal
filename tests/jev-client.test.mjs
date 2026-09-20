import assert from "node:assert/strict";
import test from "node:test";
import {
  askJev,
  JEV_ENDPOINT,
  JEV_MAX_REQUEST_BYTES,
  JEV_PINNED_MODEL,
  redactSecret,
  validateJevQuestions,
} from "../src/lib/jev/client.ts";

const KEY = "apikey_test_do_not_use";

/**
 * These pin the published wire contract (docs.typesafe.ai, read 2026-09-18).
 * If TypeSafe changes the shape, these fail before anything in Cove starts
 * reading a field that no longer exists.
 */
function respond(body, { status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  };
  return { fetchImpl, calls };
}

const QUESTIONS = {
  bucket: {
    type: "choice",
    instructions: "Which category?",
    criteria: { reply: "Write back.", noise: "Ignore it." },
  },
  urgent: { type: "noul", instructions: "Is it urgent?" },
};

test("a successful call decodes the published answer shapes", async () => {
  const { fetchImpl, calls } = respond({
    model: "jev-1.13.0",
    answers: {
      bucket: {
        type: "choice",
        choice: "reply",
        probabilities: { reply: 0.93, noise: 0.07 },
        confidence: 0.86,
      },
      urgent: { type: "noul", noul: 0.12 },
    },
    usage: { input_tokens: 312, output_tokens: 48 },
  });
  const result = await askJev({ state: "hello", questions: QUESTIONS }, {
    apiKey: KEY,
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.model, "jev-1.13.0");
  assert.equal(result.answers.bucket.type, "choice");
  assert.equal(result.answers.bucket.choice, "reply");
  assert.equal(result.answers.bucket.confidence, 0.86);
  assert.equal(result.answers.urgent.type, "noul");
  assert.equal(result.answers.urgent.noul, 0.12);
  assert.deepEqual(result.usage, { inputTokens: 312, outputTokens: 48 });

  const [call] = calls;
  assert.equal(call.url, JEV_ENDPOINT);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(call.init.headers["Content-Type"], "application/json");
  // A moved endpoint is a configuration change, never something to follow with
  // a bearer token attached.
  assert.equal(call.init.redirect, "error");
  const sent = JSON.parse(call.init.body);
  assert.equal(sent.model, JEV_PINNED_MODEL);
  assert.deepEqual(Object.keys(sent).sort(), ["model", "questions", "state"]);
});

test("a noul answer never gains a confidence field", async () => {
  const { fetchImpl } = respond({
    model: "jev-1.13.0",
    answers: { urgent: { type: "noul", noul: 0.5 } },
    usage: { input_tokens: 10, output_tokens: 1 },
  });
  const result = await askJev({
    state: "x",
    questions: { urgent: QUESTIONS.urgent },
  }, { apiKey: KEY, fetchImpl });
  assert.equal(result.ok, true);
  assert.deepEqual(result.answers.urgent, { type: "noul", noul: 0.5 });
  assert.equal("confidence" in result.answers.urgent, false);
});

test("an answer choosing an option that was not offered is rejected", async () => {
  const { fetchImpl } = respond({
    model: "jev-1.13.0",
    answers: {
      bucket: {
        type: "choice",
        choice: "invented",
        probabilities: { reply: 1 },
        confidence: 1,
      },
      urgent: { type: "noul", noul: 0 },
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const result = await askJev({ state: "x", questions: QUESTIONS }, {
    apiKey: KEY,
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "jev_invalid_response");
});

test("an out-of-range noul is rejected", async () => {
  const { fetchImpl } = respond({
    model: "jev-1.13.0",
    answers: { urgent: { type: "noul", noul: 1.4 } },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const result = await askJev({
    state: "x",
    questions: { urgent: QUESTIONS.urgent },
  }, { apiKey: KEY, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "jev_invalid_response");
});

test("a missing answer is rejected rather than silently dropped", async () => {
  const { fetchImpl } = respond({
    model: "jev-1.13.0",
    answers: { urgent: { type: "noul", noul: 0.2 } },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const result = await askJev({ state: "x", questions: QUESTIONS }, {
    apiKey: KEY,
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /answer bucket is missing/);
});

test("a response with no usage is rejected so spend is never undercounted", async () => {
  const { fetchImpl } = respond({
    model: "jev-1.13.0",
    answers: { urgent: { type: "noul", noul: 0.2 } },
  });
  const result = await askJev({
    state: "x",
    questions: { urgent: QUESTIONS.urgent },
  }, { apiKey: KEY, fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /carried no usage/);
});

test("status codes map to the documented failures and only retryable ones retry", async () => {
  for (const [status, code, retryable] of [
    [401, "jev_unauthorized", false],
    [403, "jev_unauthorized", false],
    [422, "jev_contract", false],
    [429, "jev_rate_limited", true],
    [529, "jev_overloaded", true],
  ]) {
    const { fetchImpl, calls } = respond({ error: "no" }, { status });
    const result = await askJev({
      state: "x",
      questions: { urgent: QUESTIONS.urgent },
    }, { apiKey: KEY, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code, `status ${status}`);
    assert.equal(result.error.status, status);
    assert.equal(result.error.retryable, retryable);
    assert.equal(calls.length, retryable ? 2 : 1, `status ${status} attempts`);
  }
});

test("no credential fails closed without calling out", async () => {
  const { fetchImpl, calls } = respond({});
  const result = await askJev({
    state: "x",
    questions: { urgent: QUESTIONS.urgent },
  }, { apiKey: "", fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "jev_not_configured");
  assert.equal(calls.length, 0);
});

test("an oversized request is refused before it leaves the machine", async () => {
  const { fetchImpl, calls } = respond({});
  const result = await askJev({
    state: "x".repeat(JEV_MAX_REQUEST_BYTES + 100),
    questions: { urgent: QUESTIONS.urgent },
  }, { apiKey: KEY, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "jev_request_too_large");
  assert.equal(calls.length, 0);
});

test("transport errors never carry the credential", async () => {
  const fetchImpl = async () => {
    throw new Error(`connect failed with Authorization: Bearer ${KEY}`);
  };
  const result = await askJev({
    state: "x",
    questions: { urgent: QUESTIONS.urgent },
  }, { apiKey: KEY, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.error.message.includes(KEY), false);
  assert.match(result.error.message, /\[redacted\]/);
});

test("redactSecret removes the key and any bearer header", () => {
  const text = `Bearer ${KEY} and a bare ${KEY}`;
  const scrubbed = redactSecret(text, KEY);
  assert.equal(scrubbed.includes(KEY), false);
});

test("question validation refuses shapes the API would reject", () => {
  assert.match(validateJevQuestions({}), /at least one question/);
  assert.match(
    validateJevQuestions({
      a: { type: "choice", instructions: "x", criteria: { only: "one" } },
    }),
    /at least two options/,
  );
  assert.match(
    validateJevQuestions({ a: { type: "noul", instructions: "  " } }),
    /no instructions/,
  );
  assert.match(
    validateJevQuestions({ a: { type: "score", instructions: "x" } }),
    /unsupported type/,
  );
  assert.equal(validateJevQuestions(QUESTIONS), undefined);
});
