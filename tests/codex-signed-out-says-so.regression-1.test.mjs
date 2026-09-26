// On 2026-09-25 a signed-out Codex stopped every lane on the operator's Mac for
// forty-two minutes -- the brief, email sorting, meeting notes, the
// chief-of-staff review -- and the Issues screen said only that some background
// work did not finish. The CLI had said why; nothing read it, because the
// diagnostic the scheduler files is `stderr || error || "Codex exited 1."` and
// the refusal arrived on stdout.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { providerFailureDiagnostic } from "../src/lib/model-runner-runtime.mjs";
import { jobOutputSaysSignedOut, signedOutDiagnostic } from "../src/lib/provider-signin-runtime.mjs";
import { isProviderNotSignedIn } from "../src/lib/buddy/errors.ts";
import { diagnosticCause, jobFailureDetail } from "../src/lib/reliability/job-failure-copy.ts";
import { openLocalDatabase } from "../src/lib/local/database.ts";
import { recordFailureInDatabase, listFailures } from "../src/lib/reliability/failures.ts";
import { reconcileRecoveredFailures } from "../src/lib/reliability/recoveries.ts";

const before = "2026-09-25T15:48:00Z";
const after = "2026-09-25T16:30:00Z";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-signed-out-"));
  const db = openLocalDatabase(path.join(dir, "cove.db"));
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return db;
}

function job(db, id, type, status, at) {
  db.prepare("INSERT INTO cove_jobs(id,type,run_after,status,idempotency_key,created_at,finished_at) VALUES(?,?,?,?,?,?,?)")
    .run(id, type, at, status, id, at, at);
}

function openRows(db) {
  return db.prepare("SELECT source_id FROM cove_failure_inbox WHERE dismissed_at IS NULL").pluck().all();
}

test("what the screen said on the day, and what it says now", () => {
  // The old diagnostic. Every branch of the cause ladder misses it, so the
  // person is told that something failed and to fetch their setup agent.
  const old = jobFailureDetail("morning-brief", "Codex exited 1.");
  assert.doesNotMatch(old, /signed out/i);
  assert.match(old, /Ask your Cove setup agent/);

  const now = jobFailureDetail("morning-brief", signedOutDiagnostic("codex"));
  assert.match(now, /Codex is signed out\./);
  assert.match(now, /Sign back in to Codex on this Mac/);
  assert.doesNotMatch(now, /Ask your Cove setup agent/);
});

test("a signed-out provider is never promised a retry", () => {
  // Retrying cannot sign anybody in, so the reassurance is the one sentence
  // that must not appear -- it is what keeps a person waiting.
  for (const retrying of [true, false]) {
    const detail = jobFailureDetail("email-classify", signedOutDiagnostic("codex"), retrying);
    assert.doesNotMatch(detail, /try again automatically/);
    assert.match(detail, /Sign back in to Codex/);
  }
  const { remedy } = diagnosticCause(signedOutDiagnostic("claude"));
  assert.match(remedy, /Sign back in to Claude/);
});

test("the runner reads the CLI's own words, wherever it printed them", () => {
  const onStderr = { ok: false, code: 1, stderr: "Error: not logged in. Run `codex login`.", stdout: "" };
  assert.equal(providerFailureDiagnostic("codex", onStderr, "Codex exited 1."), "Codex is signed out.");

  // The failure that started this: the CLI refused on stdout and stderr was
  // empty, so the stored diagnostic was the fallback sentence.
  const onStdout = { ok: false, code: 1, stderr: "", stdout: "You are not signed in. Run codex login to continue." };
  assert.equal(providerFailureDiagnostic("codex", onStdout, "Codex exited 1."), "Codex is signed out.");

  const other = { ok: false, code: 1, stderr: "panic: index out of range", stdout: "" };
  assert.equal(providerFailureDiagnostic("codex", other, "Codex exited 1."), "panic: index out of range");

  const silent = { ok: false, code: 1, stderr: "", stdout: "" };
  assert.equal(providerFailureDiagnostic("codex", silent, "Codex exited 1."), "Codex exited 1.");

  assert.equal(providerFailureDiagnostic("claude", onStderr, "Claude exited 1."), "Claude is signed out.");
});

test("the model's own writing cannot put a sign-in row on the screen", () => {
  // stdout is read only when stderr is empty, and only against the strict
  // pattern. A brief or a task list may talk about signing in to anything.
  for (const text of [
    "Renew the domain and log in to the registrar before Friday.",
    "Ask Petrit for the login page copy.",
    "Task: sign in to payroll and approve the timesheets.",
  ]) {
    assert.equal(jobOutputSaysSignedOut(text), false, text);
    assert.equal(
      providerFailureDiagnostic("codex", { ok: false, code: 1, stderr: "", stdout: text }, "Codex exited 1."),
      "Codex exited 1.",
    );
  }

  // And the refusals a CLI actually prints still match.
  for (const text of [
    "not logged in",
    "Please run `codex login`",
    "authentication_error",
    "401 Unauthorized",
    "Your session has expired; reauthenticate to continue.",
  ]) {
    assert.equal(jobOutputSaysSignedOut(text), true, text);
  }
});

test("Buddy's looser reading is unchanged by sharing the markers", () => {
  // Buddy matches the text of a turn the person is watching, where a false
  // positive costs a card they can ignore. Moving the markers into the shared
  // module must not tighten it.
  assert.equal(isProviderNotSignedIn("codex", "please sign in"), true);
  assert.equal(isProviderNotSignedIn("claude", "OAuth session expired"), true);
  assert.equal(isProviderNotSignedIn("claude", "something else"), false);
  assert.equal(isProviderNotSignedIn("codex", null), false);
});

test("Issues shows the sign-in row, and any later success clears it", (t) => {
  const db = fixture(t);
  job(db, "brief-failed", "morning-brief", "dead", before);
  recordFailureInDatabase(db, {
    source: "job",
    sourceId: "brief-failed",
    message: "Failed",
    details: { jobId: "brief-failed", type: "morning-brief", attempts: 3, retrying: false, error: signedOutDiagnostic("codex") },
    occurredAt: before,
  });
  assert.deepEqual(openRows(db), ["brief-failed"]);

  // A success from before the sign-out proves nothing about it.
  job(db, "earlier", "backup", "done", "2026-09-25T15:00:00Z");
  reconcileRecoveredFailures(db, new Date(after));
  assert.deepEqual(openRows(db), ["brief-failed"]);

  // Any lane succeeding afterwards means the sign-in is back: the row is about
  // the Mac, not about the brief.
  job(db, "later", "backup", "done", after);
  reconcileRecoveredFailures(db, new Date(after));
  assert.deepEqual(openRows(db), []);
});

test("the row a person reads names Codex and what to do", (t) => {
  const db = fixture(t);
  const dbPath = db.name;
  job(db, "sorted-failed", "email-classify", "dead", before);
  recordFailureInDatabase(db, {
    source: "job",
    sourceId: "sorted-failed",
    message: "Failed",
    details: { jobId: "sorted-failed", type: "email-classify", attempts: 3, retrying: false, error: signedOutDiagnostic("codex") },
    occurredAt: before,
  });
  db.close();

  const [row] = listFailures({ dbPath });
  assert.match(row.message, /Codex is signed out\./);
  assert.match(row.message, /Sign back in to Codex on this Mac/);
  assert.doesNotMatch(row.message, /try again automatically/);
});
