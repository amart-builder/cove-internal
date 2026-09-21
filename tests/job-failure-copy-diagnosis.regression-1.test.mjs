import assert from "node:assert/strict";
import test from "node:test";

import { jobFailureDetail } from "../src/lib/reliability/job-failure-copy.ts";

test("ordinary English in a diagnostic does not produce a wrong diagnosis", () => {
  // "Please" contains "lease"; a rate-limited provider says exactly this.
  const busy = jobFailureDetail("email-classify", "Rate limited. Please try again later.", true);
  assert.doesNotMatch(
    busy,
    /background worker stopped/,
    "the worker did not stop; the provider asked Cove to wait",
  );

  // "redesign in progress" contains "sign in".
  const redesign = jobFailureDetail("backup", "redesign in progress", true);
  assert.doesNotMatch(
    redesign,
    /sign-in/,
    "sending a person to re-authenticate a working account wastes their morning",
  );
});

test("the real causes are still recognised", () => {
  assert.match(
    jobFailureDetail("chief-of-staff-wake", "Lease expired before the job completed.", true),
    /background worker stopped/,
  );
  assert.match(
    jobFailureDetail("email-classify", "401 unauthorized", true),
    /sign-in/,
  );
  assert.match(
    jobFailureDetail("email-classify", "Could not sign in to the account.", true),
    /sign-in/,
  );
  assert.match(
    jobFailureDetail("backup", "the job timed out", true),
    /time limit/,
  );
});

test("the allowance cause is said in words a person already knows", () => {
  const text = jobFailureDetail("chief-of-staff-wake", "background_usage_limit: retry later", true);
  assert.doesNotMatch(text, /model call/i, "'model call allowance' is Cove's vocabulary, not the reader's");
  assert.match(text, /allowance|limit/i);
});
