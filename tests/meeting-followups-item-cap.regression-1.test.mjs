/**
 * A long meeting must not have its follow-ups quietly trimmed on the way in.
 *
 * Three contracts govern this list: the JSON schema the model is held to, the
 * validator Cove accepts against, and the deterministic parser. The schema said
 * eight while the validator accepted twenty and the parser capped nothing, so a
 * meeting with eleven real follow-ups had the model choose which three to drop
 * — and the receipt still said "N tasks, M waiting-on" as though that were the
 * whole meeting.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("tsx/cjs");
const {
  MEETING_FOLLOWUPS_JSON_SCHEMA,
  buildMeetingFollowupsPrompt,
  validateMeetingFollowUps,
  parseNextSteps,
} = require("../src/lib/intake/meeting-followups.mjs");

function items(count) {
  return Array.from({ length: count }, (_, index) => ({
    owner: index % 2 === 0 ? "Gary" : "Ben Ortiz",
    title: `Follow-up ${index + 1}`,
    detail: `Detail for follow-up ${index + 1}.`,
  }));
}

test("the model is allowed as many follow-ups as Cove accepts", () => {
  const eleven = items(11);
  assert.equal(validateMeetingFollowUps(eleven).length, 11);
  assert.ok(
    MEETING_FOLLOWUPS_JSON_SCHEMA.maxItems >= 11,
    "the schema does not ask the model to discard them first",
  );
  assert.equal(MEETING_FOLLOWUPS_JSON_SCHEMA.maxItems, 20);
});

test("the prompt states the same limit as the schema", () => {
  const prompt = buildMeetingFollowupsPrompt("Next steps:\n- [Gary] Ship it", "Gary");
  assert.match(prompt, /Return between 0 and 20 items\./);
  assert.equal(/Return between 0 and 8 items\./.test(prompt), false);
});

test("the deterministic parser still reads a long block whole", () => {
  const block = ["Next steps:", ...items(11).map((item) => `- [${item.owner}] ${item.title}`)].join("\n");
  assert.equal(parseNextSteps(block).length, 11);
});

test("the limit Cove accepts is still a limit", () => {
  assert.throws(
    () => validateMeetingFollowUps(items(21)),
    /invalid follow-up list/,
  );
});
