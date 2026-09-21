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

test("a network drop is named, rather than sent to the setup agent", () => {
  // Observed against the real Claude CLI: with no reachable API it exits 1 and
  // prints to stderr, which is what reaches this function verbatim. None of
  // these shapes matched a cause before, so a closed lid or a dropped wifi
  // read as "ask your Cove setup agent to diagnose the failure" — the one
  // cause the person can fix alone, described as one only someone else can.
  for (const diagnostic of [
    "fetch failed",
    "getaddrinfo ENOTFOUND api.anthropic.com",
    "Connection error.",
    "connect ECONNREFUSED 160.79.104.10:443",
    "request to https://api.anthropic.com/v1/messages failed, reason: socket hang up",
    "getaddrinfo EAI_AGAIN api.anthropic.com",
  ]) {
    assert.match(
      jobFailureDetail("morning-brief", diagnostic),
      /could not reach the internet/,
      `no network cause for: ${diagnostic}`,
    );
  }
});

test("the network cause sits above the worker branch, because 'Please' contains 'lease'", () => {
  // The provider's own retry advice is the trap: "Connection error. Please try
  // again later." carries both signals, and the worker wording would send the
  // person to look at a worker that is fine.
  const detail = jobFailureDetail("morning-brief", "Connection error. Please try again later.");
  assert.match(detail, /could not reach the internet/);
  assert.doesNotMatch(detail, /background worker stopped/);
});

test("a lapsed sign-in still wins over the network wording", () => {
  // Both families can appear in one message. A sign-in is the more specific
  // and more actionable of the two, so it must stay ahead of the network case.
  const detail = jobFailureDetail("morning-brief", "Invalid API key · Please run /login");
  assert.match(detail, /sign-in checked/);
  assert.doesNotMatch(detail, /could not reach the internet/);
});

test("a lapsed Google connection is named, in every shape it arrives in", () => {
  // Finding 18: an OAuth client left in Testing publishing status expires its
  // refresh tokens after seven days, so this is the failure a new install is
  // most likely to file first. Each string below is what actually reaches this
  // function -- WorkspaceGatewayError's message is its safeMessage, and the
  // bare provider code arrives when the refresh response is logged raw. None
  // of them carries a word the sign-in branch looks for, so all of them used
  // to produce no cause at all.
  for (const diagnostic of [
    "Google Workspace needs to be connected again.",
    "WorkspaceGatewayError: Google Workspace needs to be connected again.",
    "invalid_grant",
    "oauth_refresh failed: invalid_grant",
    "Google Workspace is not connected.",
    "Google did not allow the requested Workspace access.",
  ]) {
    assert.match(
      jobFailureDetail("email-classify", diagnostic),
      /Google Workspace connection needs renewing/,
      `no Google cause for: ${diagnostic}`,
    );
  }
});

test("the Google cause is more specific than the generic sign-in wording", () => {
  // Both describe a lapsed credential, and a message can carry both signals.
  // The one that names which account is the one worth showing.
  const detail = jobFailureDetail(
    "email-classify",
    "unauthorized: Google Workspace needs to be connected again.",
  );
  assert.match(detail, /Google Workspace connection needs renewing/);
  assert.doesNotMatch(detail, /sign-in checked/);
});

test("a CLI sign-in lapse is not relabelled as a Google problem", () => {
  const detail = jobFailureDetail("morning-brief", "Invalid API key · Please run /login");
  assert.match(detail, /sign-in checked/);
  assert.doesNotMatch(detail, /Google Workspace/);
});
