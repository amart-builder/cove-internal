/**
 * A commitment extracted from an email must carry a deadline the rest of Cove
 * can read, or none at all.
 *
 * The classifier schema types due_at as a bounded string with no format, and
 * nothing between the model and the commitments table parsed it. "next Friday"
 * was stored as the deadline. Every reader of that column parses it, so the
 * commitment quietly behaved like an undated one: it never counted as due, and
 * Cove never chased it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("tsx/cjs");
const { validateEmailClassification } = require("../src/lib/email/classifier.ts");
const { captureEmailCommitments } = require("../src/lib/email/automation.ts");
const { followUpsDue } = require("../src/lib/day-plan/gap-detectors.ts");

function classification(dueAt) {
  return {
    bucket: "action",
    summary: "Ben asked for the pricing sheet.",
    recommended_action: "Send the pricing sheet.",
    draft_body: null,
    commitments: [{
      kind: "follow_up",
      title: "Send Ben the pricing sheet",
      source_quote: "Can you send the pricing sheet over?",
      due_at: dueAt,
    }],
    record_correspondence: false,
    urgent: false,
    urgency_reason: null,
  };
}

function dueAtOf(value) {
  return validateEmailClassification(classification(value)).commitments[0].dueAt;
}

test("a due date the model wrote in words is not stored as a deadline", () => {
  assert.equal(dueAtOf("next Friday"), null);
  assert.equal(dueAtOf("end of week"), null);
  assert.equal(dueAtOf("ASAP"), null);
  assert.equal(dueAtOf("  "), null);
  assert.equal(dueAtOf(42), null);
});

test("a day the calendar does not have is not stored either", () => {
  assert.equal(dueAtOf("2026-02-30"), null);
  assert.equal(dueAtOf("2026-13-45"), null);
  assert.equal(dueAtOf("2026-09-25T25:00:00-07:00"), null);
});

test("a readable deadline is kept exactly as the model wrote it", () => {
  assert.equal(dueAtOf("2026-09-25T17:00:00-07:00"), "2026-09-25T17:00:00-07:00");
  assert.equal(dueAtOf("2026-09-25"), "2026-09-25");
  assert.equal(dueAtOf("2028-02-29T09:00:00Z"), "2028-02-29T09:00:00Z");
});

test("what reaches the commitments table is a date the follow-up detector can read", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "cove-email-commitment-"));
  const dbPath = path.join(dir, "cove.db");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const validated = validateEmailClassification(classification("2026-09-25T17:00:00-07:00"));
  const vague = validateEmailClassification(classification("next Friday"));
  captureEmailCommitments({
    commitments: [...validated.commitments, {
      ...vague.commitments[0],
      title: "Send Ben the security questionnaire",
      sourceQuote: "And the security questionnaire when you can.",
    }].map((commitment) => ({
      ...commitment,
      threadId: `thread-${commitment.title.length}`,
      threadLink: "https://mail.google.com/mail/u/?authuser=gary%40example.com#all/thread",
    })),
    dbPath,
    now: new Date("2026-09-21T12:00:00.000Z"),
  });

  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare("SELECT title, due_at, status FROM commitments ORDER BY title").all();
  db.close();
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.due_at),
    ["2026-09-25T17:00:00-07:00", null],
    "the phrase is stored as no deadline rather than an unreadable one",
  );

  // The detector reads the column, and this is what it could never do with a
  // phrase in it.
  const due = followUpsDue(
    rows.map((row, index) => ({
      id: `commitment-${index}`,
      status: row.status,
      due_at: row.due_at,
      review_at: null,
    })),
    "2026-09-25",
  );
  assert.deepEqual(due.map((row) => row.due_at), ["2026-09-25T17:00:00-07:00"]);
});
