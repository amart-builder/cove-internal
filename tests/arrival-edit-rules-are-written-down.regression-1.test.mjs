import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { validateAssistantProposal } from "../src/lib/day-plan/assistant-patch.ts";

const TEMPLATE = readFileSync(
  path.join(process.cwd(), "buddy", "CLAUDE.md.template"),
  "utf8",
);

const plan = {
  items: [
    { id: "item-a", decision: "pending" },
    { id: "item-b", decision: "preselected" },
  ],
};

const propose = (operations) =>
  validateAssistantProposal(plan, {
    assistantText: "Buddy updated the day plan.",
    needsClarification: false,
    operations,
  });

const edit = (itemId, patch = { title: "Renamed" }) => ({ operation: "edit_item", itemId, ...patch });
const create = (clientId, patch = {}) => ({
  operation: "create_item",
  clientId,
  title: "New item",
  outcome: "A stated outcome",
  position: 0,
  ...patch,
});

test("the owner words Arrival accepts are named where Buddy can read them", () => {
  // The only clue in the instructions used to be one example saying "claude",
  // so "me" and "together" were unreachable and a person's own name was the
  // natural guess.
  assert.match(TEMPLATE, /`owner` is exactly `me`, `claude` or `together`/);
  assert.doesNotThrow(() => propose([{ operation: "set_owner", itemId: "item-a", owner: "me" }]));
  assert.doesNotThrow(() => propose([{ operation: "set_owner", itemId: "item-a", owner: "together" }]));
  assert.throws(
    () => propose([{ operation: "set_owner", itemId: "item-a", owner: "Gary" }]),
    /invalid owner/,
  );
  assert.throws(() => propose([create("c1", { owner: "Gary" })]), /invalid owner/);
});

test("a reorder cannot ride along with a create or a complete, and the template says so", () => {
  assert.match(TEMPLATE, /A `reorder` cannot appear alongside `create_item` or `complete_item`/);
  assert.throws(
    () => propose([create("c1"), { operation: "reorder", orderedItemIds: ["item-a", "item-b"] }]),
    /Use item positions/,
  );
  assert.throws(
    () => propose([
      { operation: "complete_item", itemId: "item-a" },
      { operation: "reorder", orderedItemIds: ["item-a", "item-b"] },
    ]),
    /Use item positions/,
  );
  assert.doesNotThrow(
    () => propose([{ operation: "reorder", orderedItemIds: ["item-b", "item-a"] }]),
  );
});

test("one apply carries twelve operations, and touches each item once", () => {
  assert.match(TEMPLATE, /at most twelve operations/);
  assert.match(TEMPLATE, /edits or completes any one item only once/);
  const thirteen = Array.from({ length: 13 }, (unused, index) => create(`c${index}`));
  assert.throws(() => propose(thirteen), /too many operations/);
  assert.doesNotThrow(() => propose(thirteen.slice(0, 12)));
  assert.throws(
    () => propose([edit("item-a", { title: "One" }), edit("item-a", { outcome: "Two" })]),
    /edits an item more than once/,
  );
  assert.throws(
    () => propose([
      { operation: "complete_item", itemId: "item-a" },
      { operation: "complete_item", itemId: "item-a" },
    ]),
    /completes an item more than once/,
  );
});

test("the lengths and the position range are stated, not discovered by rejection", () => {
  assert.match(TEMPLATE, /A `position` is a whole number from 0 to 20/);
  assert.match(TEMPLATE, /240 characters[\s\S]{0,120}1200[\s\S]{0,120}120/);
  assert.throws(() => propose([create("c1", { position: 21 })]), /invalid position/);
  assert.throws(() => propose([edit("item-a", { position: -1 })]), /position is invalid/);
  assert.doesNotThrow(() => propose([create("c1", { position: 20 })]));
  assert.throws(() => propose([create("c1", { title: "t".repeat(241) })]), /content is invalid/);
  assert.throws(() => propose([create("c1", { outcome: "o".repeat(1201) })]), /content is invalid/);
  assert.throws(() => propose([create("c1", { project: "p".repeat(121) })]), /details are too long/);
  assert.throws(
    () => propose([edit("item-a", { definitionOfDone: "d".repeat(1201) })]),
    /definition of done is too long/,
  );
});

test("a rejected proposal changes nothing, which is why the rules are worth stating", () => {
  assert.match(TEMPLATE, /checked before any of it is applied/);
  const before = JSON.stringify(plan);
  assert.throws(
    () => propose([edit("item-a"), { operation: "set_owner", itemId: "item-b", owner: "nobody" }]),
    /invalid owner/,
  );
  assert.equal(JSON.stringify(plan), before, "the valid edit beside the invalid one is not applied either");
});
