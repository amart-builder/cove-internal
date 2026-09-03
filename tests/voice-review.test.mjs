import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildVoiceReviewPrompt,
  runVoiceReview,
} from "../scripts/cove-voice-review.mjs";
import { openLocalDatabase } from "../src/lib/local/database.ts";
import { writeSignature } from "../src/lib/email/signature.ts";

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cove-voice-review-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, dbPath: path.join(dir, "cove.db") };
}

function insertOutcome(db, input) {
  db.prepare(
    `INSERT INTO email_draft_outcomes
       (email_item_id, thread_id, gmail_draft_id, draft_body,
        draft_body_hash, drafted_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.emailItemId,
    input.threadId,
    `draft-${input.emailItemId}`,
    input.draftBody,
    createHash("sha256").update(input.draftBody).digest("hex"),
    input.draftedAt,
  );
}

function message({ id, threadId, text, internalDate, subject = "Subject" }) {
  return {
    id,
    threadId,
    labelIds: ["SENT"],
    internalDate: String(new Date(internalDate).getTime()),
    headers: [{ name: "Subject", value: subject }],
    snippet: text,
    text,
  };
}

test("weekly review resolves outcomes, finds own writing, writes a digest, and marks rows", async (t) => {
  const { dir, dbPath } = await fixture(t);
  const now = new Date("2026-08-30T18:00:00.000Z");
  const db = openLocalDatabase(dbPath);
  try {
    insertOutcome(db, {
      emailItemId: 1,
      threadId: "thread-unedited",
      draftBody: "Looks good.",
      draftedAt: "2026-08-28T12:00:00.000Z",
    });
    insertOutcome(db, {
      emailItemId: 2,
      threadId: "thread-edited",
      draftBody: "Looks good.",
      draftedAt: "2026-08-28T13:00:00.000Z",
    });
    insertOutcome(db, {
      emailItemId: 3,
      threadId: "thread-abandoned",
      draftBody: "Checking in.",
      draftedAt: "2026-08-10T12:00:00.000Z",
    });
  } finally {
    db.close();
  }
  // 5 non-empty lines on purpose: longer than stripTrailingSignature's 4-line
  // lookback, so this only passes through the literal-trailing-signature strip.
  writeSignature({
    dataDir: dir,
    html: "<div>Best,<br>Alex Example<br>Founder, Example Co<br>+1 555 123 4567<br>edge-ai.example</div>",
    metadata: {
      sendAsEmail: "alex@example.com",
      fetchedAt: now.toISOString(),
      sourceMessageId: "signature-source",
    },
  });
  const threads = {
    "thread-unedited": [message({
      id: "sent-unedited",
      threadId: "thread-unedited",
      text: "Looks good.\n\nBest,\nAlex Example\nFounder, Example Co\n+1 555 123 4567\nedge-ai.example",
      internalDate: "2026-08-28T14:00:00.000Z",
    })],
    "thread-edited": [message({
      id: "sent-edited",
      threadId: "thread-edited",
      text: "Looks great.\n\nBest,\nAlex Example\nFounder, Example Co\n+1 555 123 4567\nedge-ai.example",
      internalDate: "2026-08-28T15:00:00.000Z",
    })],
    "thread-abandoned": [],
  };
  const own = message({
    id: "sent-own",
    threadId: "thread-own",
    text: "I wrote this myself and kept it short.",
    internalDate: "2026-08-29T16:00:00.000Z",
    subject: "Own note",
  });
  const createdTasks = [];
  const result = await runVoiceReview({
    dataDir: dir,
    dbPath,
    now,
    settings: {
      voiceFingerprintPath: null,
      voiceReview: { enabled: true, judgeEnabled: false },
    },
    gateway: {
      accountEmail: "alex@example.com",
      getThread: async ({ threadId }) => ({
        id: threadId,
        historyId: null,
        messages: threads[threadId],
      }),
      listMessages: async () => ({
        messages: [{ id: own.id, threadId: own.threadId }],
      }),
      getMessage: async () => own,
    },
    runJobImpl: async (input) => ({
      ok: true,
      lane: input.lane,
      backend: "codex-sol-high",
      text: "Voice review\n\nPROPOSED RULES:\n- Keep it short.\n\nCORPUS CANDIDATES:\n- Own note",
    }),
    createTaskImpl: async (task) => createdTasks.push(task),
    log: () => {},
    warn: () => {},
  });
  assert.equal(result.status, "written");
  assert.equal(result.resolved, 3);
  assert.equal(result.candidates, 1);
  assert.equal(createdTasks.length, 1);
  assert.equal(createdTasks[0].title, "Review weekly voice digest");
  assert.match(createdTasks[0].description, /voice-reviews\/2026-08-30\.md/);
  assert.match(await readFile(result.reviewPath, "utf8"), /PROPOSED RULES:/);

  const verify = openLocalDatabase(dbPath);
  try {
    const rows = verify.prepare(
      `SELECT thread_id, outcome, sent_body, reviewed_at
       FROM email_draft_outcomes ORDER BY id`,
    ).all();
    assert.equal(rows[0].outcome, "sent_unedited");
    assert.equal(rows[0].sent_body, "Looks good.");
    assert.equal(rows[1].outcome, "sent_edited");
    assert.equal(rows[1].sent_body, "Looks great.");
    assert.equal(rows[2].outcome, "abandoned");
    assert.ok(rows.every((row) => row.reviewed_at === now.toISOString()));
  } finally {
    verify.close();
  }
});

test("disabled weekly review is a clean one-line no-op", async () => {
  const logs = [];
  const result = await runVoiceReview({
    dataDir: "/path/that/does/not/need/to/exist",
    settings: {
      voiceFingerprintPath: null,
      voiceReview: { enabled: false, judgeEnabled: false },
    },
    log: (line) => logs.push(line),
  });
  assert.equal(result.status, "disabled");
  assert.deepEqual(logs, ["Cove weekly voice review is disabled."]);
});

test("digest prompt includes verbatim before and after text and proposes only", () => {
  const prompt = buildVoiceReviewPrompt([
    {
      id: 1,
      outcome: "sent_edited",
      draftBody: "Before exact quote.",
      sentBody: "After exact quote.",
    },
  ], [{ subject: "Own note", excerpt: "Written without Cove." }]);
  assert.match(prompt, /BEFORE:\nBefore exact quote\./);
  assert.match(prompt, /AFTER:\nAfter exact quote\./);
  assert.match(prompt, /You must propose only\. Nothing in this review is applied automatically\./);
  assert.match(prompt, /PROPOSED RULES:/);
  assert.match(prompt, /CORPUS CANDIDATES:/);
});
