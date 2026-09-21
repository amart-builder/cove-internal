import assert from "node:assert/strict";
import test from "node:test";

import { jobFailureCopy, jobFailureDetail } from "../src/lib/reliability/job-failure-copy.ts";

test("a failed morning brief is named, not filed under 'some background work'", () => {
  // The brief is the first screen of the person's day. Before this case
  // existed it fell to the default branch, so the one job whose output they
  // look at every morning failed with wording that named nothing.
  const copy = jobFailureCopy("morning-brief");
  assert.match(copy.title, /brief/i);
  assert.match(copy.body, /brief/i);
  assert.notDeepEqual(copy, jobFailureCopy("something-unknown"));

  const retrying = jobFailureCopy("morning-brief", true);
  assert.match(retrying.body, /try again automatically/);
});

test("a lapsed sign-in is named as the cause, in the words the CLIs print", () => {
  // src/lib/buddy/errors.ts matches this same family for Buddy's sign-in card.
  // An expired sign-in is the likeliest reason a scheduled job stops for good,
  // and it is the one cause the person can actually do something about.
  for (const diagnostic of [
    "Claude exited 1: Invalid API key · Please run /login",
    "OAuth session expired",
    "credentials could not be refreshed",
    "not logged in",
    "authentication_error",
  ]) {
    assert.match(
      jobFailureDetail("morning-brief", diagnostic),
      /sign-in checked/,
      `no sign-in cause for: ${diagnostic}`,
    );
  }
});

test("product copy never carries provider diagnostics onto the screen", () => {
  const diagnostic = "Claude exited 1: Invalid API key sk-ant-SECRET · /Users/gary/cove";
  for (const type of ["morning-brief", "backup", "chief-of-staff-wake", "email-classify", "whatever"]) {
    const detail = jobFailureDetail(type, diagnostic);
    assert.doesNotMatch(detail, /sk-ant|Users\/|exited 1/, `${type} leaked the diagnostic`);
  }
});
