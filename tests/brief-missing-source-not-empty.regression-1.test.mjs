/**
 * A morning Cove cannot see must not read like a morning with nothing in it.
 *
 * The brief prompt handed the model a coverage map and told it the manifest
 * says what it can see, and stopped there. A brief built with
 * `coverage.calendar: "missing"` was free to open with an unusually free
 * morning, and the operator had no way to tell which one he was looking at.
 * The wake loop's planning contract has said the equivalent about its own
 * sources all along.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("tsx/cjs");
const { buildMorningBriefPrompt } = require("../src/lib/claude-execution/brief-commands.ts");
const { PLANNING_QUESTIONS } = require("../src/lib/chief-of-staff/planning-contract.ts");

function prompt(coverage) {
  return buildMorningBriefPrompt({
    targetLocalDate: "2026-09-22",
    targetTimezone: "America/Los_Angeles",
    sections: [{ id: "tasks", label: "OPEN_TASKS", text: "[]" }],
    manifest: {
      sources: [
        { id: "calendar", asOf: null, freshness: "missing", trimmed: false },
        { id: "tasks", asOf: "2026-09-22T12:00:00.000Z", freshness: "fresh", trimmed: false },
      ],
      coverage,
    },
  });
}

test("the brief is told that a missing source is not an empty one", () => {
  const text = prompt({ calendar: "missing", tasks: "included" });
  assert.match(text, /A source marked missing or stale in SOURCE_MANIFEST is one you cannot see, not one that is empty\./);
  assert.match(text, /Never read an absent source as an open day, an empty inbox or a quiet week\./);
  assert.match(text, /say so once in the narrative in their own terms/);
});

test("the coverage the instruction refers to is actually in the prompt", () => {
  const text = prompt({ calendar: "missing", tasks: "included" });
  assert.match(text, /"coverage":\{"calendar":"missing","tasks":"included"\}/);
});

test("the wake loop already carried the same rule, which is why the brief should", () => {
  assert.match(
    PLANNING_QUESTIONS,
    /If coverage is partial, stale, unavailable, outside the window or on an unconnected calendar, retain that uncertainty\./,
  );
});
