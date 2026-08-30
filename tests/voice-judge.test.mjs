import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEmailClassificationHandler } from "../src/lib/email/classification-job.ts";
import { observeInboundMessage } from "../src/lib/email/state-machine.ts";
import { buildVoiceJudgePrompt } from "../src/lib/email/voice-judge.ts";
import { openLocalDatabase } from "../src/lib/local/database.ts";

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cove-voice-judge-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, dbPath: path.join(dir, "cove.db") };
}

test("voice judge prompt uses only the measured fingerprint and draft as forensic evidence", () => {
  const prompt = buildVoiceJudgePrompt(
    "Median reply is 45 words. No exclamation marks.",
    "Hi Pat,\n\nAbsolutely thrilled to help!",
  );
  assert.match(prompt, /fresh forensic reader/i);
  assert.match(prompt, /Median reply is 45 words/);
  assert.match(prompt, /Absolutely thrilled to help!/);
  assert.match(prompt, /single most betraying line/i);
  assert.doesNotMatch(prompt, /conversation history supplied/i);
});

test("judge failure leaves the classified draft flow intact and unjudged", async (t) => {
  const { dir, dbPath } = await fixture(t);
  const fingerprintPath = path.join(dir, "fingerprint.md");
  await writeFile(fingerprintPath, "Short replies. Opens with Hi.");
  await writeFile(path.join(dir, "cove-email.json"), JSON.stringify({
    voiceFingerprintPath: fingerprintPath,
    voiceReview: { enabled: false, judgeEnabled: true },
  }));
  const observed = observeInboundMessage({
    messageId: "judge-message",
    threadId: "judge-thread",
    internalDate: "1000",
    accountEmail: "alex@example.com",
    dbPath,
  });
  let judgeCalls = 0;
  const labels = [];
  const handler = createEmailClassificationHandler({
    dbPath,
    dataDir: dir,
    accountEmail: "alex@example.com",
    gateway: {
      getMessage: async () => ({
        id: "judge-message",
        threadId: "judge-thread",
        labelIds: ["INBOX"],
        internalDate: "1000",
        headers: [
          { name: "From", value: "Pat <pat@example.com>" },
          { name: "Subject", value: "Question" },
        ],
        snippet: "Can you help?",
        text: "Can you help?",
      }),
      modifyThreadLabels: async (input) => labels.push(input),
    },
    classifier: async () => ({
      bucket: "reply",
      summary: "Pat asked for help.",
      recommendedAction: "reply",
      draftBody: "Hi Pat,\n\nYes, happy to help.",
      modelVersion: "test",
    }),
    runJobImpl: async () => {
      judgeCalls += 1;
      return {
        ok: false,
        error: { code: "runner_timeout", lane: "voice-judge", message: "timed out" },
      };
    },
  });
  const result = await handler({
    id: "classification-job",
    type: "email-classify",
    payload: {
      messageId: "judge-message",
      emailItemId: observed.emailItemId,
      threadVersion: observed.threadVersion,
    },
  });
  assert.equal(result.actions.applied, true);
  assert.equal(judgeCalls, 1);
  assert.equal(labels.length, 1);

  const db = openLocalDatabase(dbPath);
  try {
    const operation = db.prepare(
      "SELECT payload_json FROM cove_gmail_operations WHERE id = ?",
    ).get(result.actions.operationId);
    assert.deepEqual(JSON.parse(operation.payload_json), {
      body: "Hi Pat,\n\nYes, happy to help.",
      existingDraftId: null,
      voiceJudgeScore: null,
      voiceJudgeVerdict: null,
    });
  } finally {
    db.close();
  }
});
