// The measured voice fingerprint and the voice judge are shipped features that
// did nothing. com.cove.jobs drains every queue every five minutes and is in
// practice the runner that classifies mail; it registered the handler without
// dataDir or repoDir and with its own four-line reader of ~/.claude/voice.md,
// so the fingerprint never reached the model and the judge -- guarded on
// dataDir -- never ran. com.cove.email-triage, which passes all of them, runs a
// few times a day.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEmailVoiceGuide, VOICE_FINGERPRINT_SEPARATOR } from "../src/lib/email/voice-guide.ts";

const ROOT = process.cwd();

function registration(file) {
  const source = readFileSync(path.join(ROOT, "scripts", file), "utf8");
  const start = source.indexOf('scheduler.register("email-classify", createEmailClassificationHandler({');
  assert.ok(start > 0, `${file} no longer registers email-classify`);
  const end = source.indexOf("}));", start);
  const block = source.slice(start, end);
  return new Set(block.split("\n").slice(1)
    .map((line) => line.trim().replace(/[:,].*$/, ""))
    .filter((key) => /^[a-zA-Z]+$/.test(key)));
}

test("the runner that does the work passes what the lane needs", () => {
  const jobs = registration("cove-jobs.ts");
  // dataDir gates the voice judge; repoDir is how the handler finds the prompt.
  for (const key of ["dataDir", "repoDir", "gateway", "accountEmail", "dbPath", "signatureText", "voice"]) {
    assert.ok(jobs.has(key), `cove-jobs.ts must pass ${key} to the classification handler`);
  }
});

test("both runners agree on what the classification handler is given", () => {
  const jobs = registration("cove-jobs.ts");
  const triage = registration("cove-email-runner.ts");
  // The triage runner may pass its own test seams; the drain runner may not be
  // missing anything the triage runner considers part of the lane.
  const seams = new Set(["classifier", "now", "warn"]);
  const missing = [...triage].filter((key) => !seams.has(key) && !jobs.has(key));
  assert.deepEqual(missing, [], `cove-jobs.ts is missing ${missing.join(", ")}`);
});

test("the voice reader the runners share is the one that carries the fingerprint", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-voice-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = path.join(dir, "voice.md");
  writeFileSync(base, "Write plainly.\n");
  const fingerprint = path.join(dir, "fingerprint.md");
  writeFileSync(fingerprint, "Measured: short sentences, no exclamation marks.\n");
  writeFileSync(path.join(dir, "cove-email.json"), JSON.stringify({ voiceFingerprintPath: fingerprint }));

  const guide = readEmailVoiceGuide({ dataDir: dir, baseGuidePath: base });
  assert.match(guide, /Write plainly\./);
  assert.match(guide, new RegExp(VOICE_FINGERPRINT_SEPARATOR.replace(/[()]/g, "\\$&")));
  assert.match(guide, /short sentences, no exclamation marks/);

  // What the drain runner used to send instead: the base guide alone, with the
  // measurement Cove took of the operator's own writing left on disk.
  const baseOnly = readFileSync(base, "utf8").slice(0, 12_000);
  assert.doesNotMatch(baseOnly, /short sentences, no exclamation marks/);
});
