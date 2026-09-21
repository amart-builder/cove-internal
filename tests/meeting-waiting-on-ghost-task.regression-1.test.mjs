/**
 * A waiting-on item recorded while the inbound database was unreachable must
 * not come back as a task on the operator's own board.
 *
 * Someone else's follow-up is written as a waiting-on commitment, and the
 * inbound event beside it is only provenance. When that event could not be
 * written it went to the spool as `pending`, the drain inserted it as a
 * capture nobody had triaged, and the inbound sweep turned it into a full
 * task thirty minutes later — one whose text ends "Named owner: Ben".
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { LocalCRMBackend } from "../src/lib/crm/index.ts";
import { processMeetingNotesEmail } from "../src/lib/intake/meeting-pipeline.ts";
import {
  countSpooledEvents,
  drainSpoolFiles,
  listUnresolved,
} from "../src/lib/intake/inbox.ts";

const START = new Date("2026-07-29T15:00:00.000Z");

const email = {
  messageId: "gmail-waiting-on-1",
  threadId: "thread-waiting-on-1",
  sender: "Gemini <gemini-noreply@google.com>",
  subject: "Notes: Client planning",
  body: "Next steps\n- [Ben Ortiz] Share the security questionnaire: Before Friday.",
  detectedTool: "gemini",
};

function fixture(t) {
  const dir = path.join(
    os.tmpdir(),
    `cove-waiting-on-ghost-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "cove.db");
  const previous = new Map([
    ["COVE_DB_PATH", process.env.COVE_DB_PATH],
    ["NEXT_PUBLIC_COVE_RUNTIME", process.env.NEXT_PUBLIC_COVE_RUNTIME],
    ["NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL],
    ["SUPABASE_SERVICE_ROLE_KEY", process.env.SUPABASE_SERVICE_ROLE_KEY],
  ]);
  process.env.COVE_DB_PATH = dbPath;
  const crm = new LocalCRMBackend({ dbPath, now: () => START });
  t.after(() => {
    crm.close();
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, dbPath, crm };
}

test("a spooled waiting-on does not become a task on the operator's board", async (t) => {
  const files = fixture(t);

  // The inbound database is unreachable, which is what sends the event to the
  // spool. The waiting-on commitment itself is written by another path and
  // still succeeds.
  process.env.NEXT_PUBLIC_COVE_RUNTIME = "supabase";
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;

  const commitments = [];
  const result = await processMeetingNotesEmail(email, {
    sourceDoor: "watcher",
    dbPath: files.dbPath,
    dataDir: files.dir,
    baseUrl: "http://cove.test",
    now: () => START,
    crmBackend: files.crm,
    extractFollowUps: async () => [{
      owner: "Ben Ortiz",
      title: "Share the security questionnaire",
      detail: "Before Friday.",
    }],
    isOperatorOwnedImpl: () => false,
    writeCommitmentImpl: async (item) => {
      commitments.push(item.title);
      return "commitment-1";
    },
  });

  assert.equal(result.status, "processed");
  assert.equal(result.summary.waitingOn, 1, "the waiting-on is still recorded");
  assert.deepEqual(commitments, ["Share the security questionnaire"]);
  assert.equal(countSpooledEvents(files.dir), 1, "the event went to the spool");

  // The database comes back and the spool drains, as it does on every sweep.
  process.env.NEXT_PUBLIC_COVE_RUNTIME = "local";
  await drainSpoolFiles(files.dir);
  assert.equal(countSpooledEvents(files.dir), 0);

  // This is the sweep that used to mint the task: anything still pending half
  // an hour later becomes one.
  // The event's own timestamps come from the real clock inside recordEvent,
  // so the sweep is run against a clock an hour past it rather than past the
  // meeting's fixture date.
  const unresolved = await listUnresolved({
    olderThanMinutes: 30,
    now: new Date(Date.now() + 60 * 60_000),
  });
  assert.deepEqual(
    unresolved.map((event) => event.raw_text),
    [],
    "nothing is left for the inbound sweep to turn into a task",
  );

  const db = new Database(files.dbPath, { readonly: true });
  const states = db.prepare("SELECT state FROM inbound_events").pluck().all();
  db.close();
  assert.deepEqual(
    states,
    ["dismissed"],
    "the drained event carries a decision, not an untriaged capture",
  );
});
