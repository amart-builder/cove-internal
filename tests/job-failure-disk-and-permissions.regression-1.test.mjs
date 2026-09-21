import assert from "node:assert/strict";
import test from "node:test";

import { jobFailureDetail } from "../src/lib/reliability/job-failure-copy.ts";

// Found by filling the disk under a real install and running the worker. Cove
// stored `"error": "database or disk is full"` and showed the person "Cove
// couldn't create a fresh backup. Cove will try again automatically." -- the
// one fact that would have let them fix it in ten seconds, and a reassurance
// that could not come true, since every retry fails the same way.

test("a full disk is named, and Cove does not promise a retry that cannot work", () => {
  const text = jobFailureDetail("backup", "database or disk is full", true);
  assert.match(text, /disk is full/i);
  assert.match(text, /Free up space/i);
  assert.doesNotMatch(
    text,
    /try again automatically/i,
    "retrying never clears a full disk; saying so sends the person away to wait",
  );
});

test("the same holds once it has stopped retrying", () => {
  const text = jobFailureDetail("backup", "ENOSPC: no space left on device", false);
  assert.match(text, /disk is full/i);
  assert.match(text, /Free up space/i);
  assert.doesNotMatch(
    text,
    /Ask your Cove setup agent/i,
    "the cause is named and the person can fix it themselves",
  );
});

test("a file Cove cannot write is named as that, not as a sign-in", () => {
  for (const diagnostic of [
    "EACCES: permission denied, open '/Users/gary/cove/data/cove.db'",
    "SQLITE_READONLY: attempt to write a readonly database",
    "EROFS: read-only file system",
  ]) {
    const text = jobFailureDetail("backup", diagnostic, true);
    assert.match(text, /could not write to its own files/i, diagnostic);
    assert.match(text, /permissions on Cove's data folder/i, diagnostic);
  }
});

test("a provider's own refusal is not read as a local permission problem", () => {
  // Google says both of these. Sending somebody to chmod their data folder
  // over a revoked Gmail scope is the wrong-cause failure that costs a morning.
  for (const diagnostic of ["Permission denied", "403 The caller does not have permission"]) {
    assert.doesNotMatch(
      jobFailureDetail("email-classify", diagnostic, true),
      /data folder/i,
      diagnostic,
    );
  }
  // And the causes that were already recognised still are.
  assert.match(
    jobFailureDetail("email-classify", "invalid_grant", true),
    /Google Workspace connection needs renewing/,
  );
  assert.match(
    jobFailureDetail("backup", "fetch failed", true),
    /could not reach the internet/,
  );
  assert.match(jobFailureDetail("backup", "the job timed out", true), /time limit/);
});
