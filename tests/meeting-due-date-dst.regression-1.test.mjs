/**
 * A promise that lands on the other side of a daylight-saving change.
 *
 * validateMeetingAnalystArtifact requires a task's due_at to carry the offset
 * the operator's timezone is in AT THAT INSTANT, which is not the offset today
 * once the date crosses a DST boundary. The prompt asked only for "the
 * <zone> offset", and the rejection said only that the offset was wrong. So a
 * meeting in late October that promises something for mid-November was rejected
 * on the first attempt and told nothing it could act on, and the correction
 * retry reproduced the same answer.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  validateMeetingAnalystArtifact,
  buildMeetingAnalystPrompt,
} from "../src/lib/intake/meeting-analysis.ts";

const TIMEZONE = "America/Los_Angeles";
// Pacific leaves daylight time on 2026-11-01, so a meeting held in October and
// a promise made for November sit on opposite sides of it.
const PROCESSING = new Date("2026-10-26T17:00:00.000Z");

function artifactDue(dueAt) {
  return {
    meeting_summary: "Pipeline review with Ben.",
    per_contact_notes: [],
    waiting_on: [],
    research_requests: [],
    tasks: [
      {
        title: "Send the November pipeline overview",
        description: "Ben asked for the overview before the board meeting.",
        brief: "Ben Ortiz asked for the pipeline overview ahead of the board meeting.",
        due_at: dueAt,
        priority: "medium",
        notification_policy: "none",
        rationale: "He asked for it in the call.",
      },
    ],
  };
}

test("the offset in effect on the due date is the one that is accepted", () => {
  // -08:00 is what Pacific is on 13 November. This is the answer Cove wants.
  assert.doesNotThrow(() =>
    validateMeetingAnalystArtifact(artifactDue("2026-11-13T09:00:00-08:00"), TIMEZONE, PROCESSING),
  );
  // -07:00 is what Pacific is on the day of the meeting, and is the offset a
  // model reasoning from ANALYSIS_NOW would reach for.
  assert.throws(() =>
    validateMeetingAnalystArtifact(artifactDue("2026-11-13T09:00:00-07:00"), TIMEZONE, PROCESSING),
  );
});

test("the rejection says which offset was wanted, so the retry can act on it", () => {
  let message = "";
  try {
    validateMeetingAnalystArtifact(artifactDue("2026-11-13T09:00:00-07:00"), TIMEZONE, PROCESSING);
  } catch (error) {
    message = error.message;
  }
  // The runner prepends this message to the second attempt as a CORRECTION, so
  // everything the model needs to produce a different answer has to be in it.
  // Naming only the rule restates what the model already believes it followed.
  assert.match(message, /-08:00/, "the wanted offset must be in the message");
  assert.match(message, /-07:00/, "the offset it sent must be in the message");
  assert.match(message, /Send the November pipeline overview/, "which task must stay identifiable");
});

test("a reminder across the boundary is told the same thing", () => {
  const artifact = artifactDue("2026-11-13T09:00:00-08:00");
  artifact.tasks[0].remind_at = "2026-11-12T09:00:00-07:00";
  let message = "";
  try {
    validateMeetingAnalystArtifact(artifact, TIMEZONE, PROCESSING);
  } catch (error) {
    message = error.message;
  }
  assert.match(message, /remind_at/);
  assert.match(message, /-08:00/);
});

test("the prompt warns that the offset can differ from today's", () => {
  const prompt = buildMeetingAnalystPrompt({
    envelopes: [],
    contacts: [],
    recentEmailThreads: [],
    goals: "",
    operatorProfile: {},
    timezone: TIMEZONE,
    processingTime: PROCESSING.toISOString(),
  });
  assert.match(
    prompt,
    /offset in effect in America\/Los_Angeles on that date/,
    "the first attempt should be right, not merely correctable",
  );
  assert.match(prompt, /daylight/i);
});
