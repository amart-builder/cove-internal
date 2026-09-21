/**
 * Cove told the model to change +00:00 into Z, which is the same offset.
 *
 * validateMeetingAnalystArtifact compared the offset the model wrote against
 * the one the operator's timezone is in, as strings. localOffset spells a zero
 * offset "Z"; RFC 3339's own canonical spelling for it is "+00:00", and that is
 * what a model writes at least as often. So for an operator at UTC, or in
 * London between October and March, a correct due date was rejected, the
 * CORRECTION retry asked for a synonym of what it had just sent, and the
 * meeting's commitments were dropped after the second attempt.
 *
 * Nothing in the prompt discloses a preferred spelling, so the model cannot
 * reliably comply: both attempts are lost to a distinction Cove never stated.
 *
 * validateTaskTiming in src/lib/local/db.ts already folds "+00:00" to "Z"
 * before comparing. This lane is the one place that forgot to.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { validateMeetingAnalystArtifact } from "../src/lib/intake/meeting-analysis.ts";

function artifact(dueAt, remindAt) {
  const task = {
    title: "Send the deck",
    description: "Priya asked for the deck after the sync.",
    brief: "Priya asked for the deck after the sync.",
    due_at: dueAt,
    priority: "medium",
    notification_policy: "none",
    rationale: "She asked for it in the call.",
  };
  if (remindAt) task.remind_at = remindAt;
  return {
    meeting_summary: "Sync with Priya.",
    per_contact_notes: [],
    waiting_on: [],
    research_requests: [],
    tasks: [task],
  };
}

const WINTER = new Date("2026-01-12T10:00:00.000Z");
const SUMMER = new Date("2026-07-10T10:00:00.000Z");

test("a zero offset written the RFC 3339 way is the same offset as Z", () => {
  for (const timezone of ["UTC", "Europe/London"]) {
    assert.doesNotThrow(
      () => validateMeetingAnalystArtifact(artifact("2026-01-15T09:00:00+00:00"), timezone, WINTER),
      `${timezone} rejected +00:00, which is what it is in`,
    );
    assert.doesNotThrow(
      () => validateMeetingAnalystArtifact(artifact("2026-01-15T09:00:00Z"), timezone, WINTER),
      `${timezone} must keep accepting the Z spelling too`,
    );
  }
});

test("a negative zero offset is still a zero offset", () => {
  assert.doesNotThrow(
    () => validateMeetingAnalystArtifact(artifact("2026-01-15T09:00:00-00:00"), "UTC", WINTER),
  );
});

test("the check is not loosened: a wrong offset is still wrong", () => {
  // London is on BST in July, so a zero offset there names a different instant
  // than the one the model meant and must still be rejected.
  assert.throws(
    () => validateMeetingAnalystArtifact(artifact("2026-07-15T09:00:00+00:00"), "Europe/London", SUMMER),
    /must use \+01:00/,
  );
  assert.throws(
    () => validateMeetingAnalystArtifact(artifact("2026-01-15T09:00:00-08:00"), "UTC", WINTER),
    /must use Z/,
  );
});

test("a reminder is held to the same rule", () => {
  assert.doesNotThrow(
    () => validateMeetingAnalystArtifact(
      artifact("2026-01-15T09:00:00+00:00", "2026-01-14T09:00:00+00:00"),
      "UTC",
      WINTER,
    ),
  );
  assert.throws(
    () => validateMeetingAnalystArtifact(
      artifact("2026-01-15T09:00:00Z", "2026-01-14T09:00:00+05:00"),
      "UTC",
      WINTER,
    ),
    /remind_at must use Z/,
  );
});
