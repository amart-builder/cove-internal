/**
 * The meeting watcher wrote decent copy and then overrode it with raw errors.
 *
 * This is the same shape as the terminal branch of the meeting-notes lane
 * fixed in d3bd9e8: a receipt's `summary` is written in the person's words,
 * and then `failureMessage` replaces it on the Issues screen, because
 * recordReceipt records `input.failureMessage ?? input.summary`
 * (src/lib/reliability/receipts.ts:125).
 *
 * The watcher joined every entry in `summary.error_messages` with "; ", and
 * those are `boundedError(error)` — the thrown message. So a Granola outage or
 * a locked database was printed to the person, verbatim, on the screen Cove
 * uses to tell them something needs them.
 *
 * That sweep looked at src/ and missed scripts/. This case lives at the far
 * end: it drives the real recordReceipt into a real database and reads back
 * what the Issues screen renders, so it cannot pass on a message that only
 * looks right at the seam.
 *
 * One string is deliberately still passed through. failures.ts recognises
 * "Meeting analysis jobs failed=N dead=M." and turns it into a sentence; the
 * watcher forwards it rather than restating it, because two copies of one
 * sentence is how the copy drifts.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main as meetingWatchMain } from "../scripts/cove-meeting-watch.mjs";
import { listFailures } from "../src/lib/reliability/failures.ts";
import { recordReceipt } from "../src/lib/reliability/receipts.ts";

function tempDatabase(t) {
  const file = path.join(
    os.tmpdir(),
    `cove-meeting-issue-${process.pid}-${Date.now()}-${Math.random()}.db`,
  );
  t.after(() => {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
  });
  return file;
}

// Drives the real script entry point, with only the watch pass itself stubbed,
// through the real receipt writer into a real database.
async function issueScreenMessage(t, errorMessages, { exitCode = 0 } = {}) {
  const dbPath = tempDatabase(t);
  const summary = {
    processed: 0,
    errors: errorMessages.length,
    error_messages: errorMessages,
  };
  await meetingWatchMain([], {
    dbPath,
    runMeetingWatchImpl: async () => ({ exitCode, summary }),
    recordRunReceiptImpl: (input) => recordReceipt({ ...input, dbPath }),
  });
  const items = listFailures({ dbPath });
  assert.equal(items.length, 1, "exactly one issue should be raised");
  return items[0];
}

test("a provider outage does not print its own error on the Issues screen", async (t) => {
  const item = await issueScreenMessage(t, [{
    source: "granola",
    error: "request to https://api.granola.ai/v1/documents failed, reason: ECONNREFUSED",
  }]);

  assert.doesNotMatch(item.message, /ECONNREFUSED|api\.granola\.ai|request to/);
  assert.match(item.message, /meeting notes/i);
  // The diagnostic is not lost, it just is not the headline.
  assert.match(JSON.stringify(item.details), /ECONNREFUSED/);
});

test("a thrown database error does not reach the person either", async (t) => {
  const item = await issueScreenMessage(t, [
    { message_id: "msg-1", error: "SQLITE_BUSY: database is locked" },
    { error: "heartbeat: ENOENT: no such file or directory, open '/tmp/x'" },
  ]);

  assert.doesNotMatch(item.message, /SQLITE_BUSY|ENOENT|heartbeat:/);
  assert.match(JSON.stringify(item.details), /SQLITE_BUSY/);
});

test("the one message failures.ts knows how to say is still forwarded", async (t) => {
  const item = await issueScreenMessage(t, [
    { error: "Meeting analysis jobs failed=2 dead=1." },
  ]);

  assert.match(item.message, /Some meeting reviews did not finish/);
  assert.doesNotMatch(item.message, /failed=2/, "the machine form is not what is shown");
});

test("a mixed run is described, not itemised", async (t) => {
  const item = await issueScreenMessage(t, [
    { error: "Meeting analysis jobs failed=2 dead=1." },
    { message_id: "msg-2", error: "Unexpected token < in JSON at position 0" },
  ]);

  assert.doesNotMatch(item.message, /Unexpected token|failed=2/);
  assert.match(item.message, /meeting notes/i);
});
