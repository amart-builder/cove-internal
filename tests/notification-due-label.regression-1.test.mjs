/**
 * The screen a Cove notification opens contradicted the board it came from.
 *
 * `NotificationTaskSheet` is what a person sees when they click through a Cove
 * notification. It printed a task's `due_at` two ways: a bare `YYYY-MM-DD` at
 * local noon as a plain date, and anything else through `toLocaleString`, with
 * a clock time. The board's date pickers write a picked day as that day at UTC
 * midnight, which is neither -- so for a card the board labels October 2, the
 * sheet opened by that card's own reminder read:
 *
 *     Open · Due 10/1/2026, 5:00:00 PM
 *
 * The wrong day, and a clock time nobody chose. This is finding 53's encoding
 * again, on the screen the reminder lands on, and it is the same shape as the
 * bare-date branch immediately beside it: the day form is a day, and a day is
 * rendered as a date.
 *
 * `taskDueLabel` asks `src/lib/attention/due-date.mjs`, which is where the
 * reminder lanes and the progress reconciler ask, so the sheet and the lanes
 * cannot disagree about which day a deadline is on again.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("tsx/cjs");
const { taskDueLabel } = require("../src/lib/tasks/due-label.ts");

test("a day the person picked on the board is shown as that day", () => {
  // 2026-10-02T00:00:00.000Z is 5pm on October 1 in Los Angeles.
  assert.equal(taskDueLabel("2026-10-02T00:00:00.000Z"), "10/2/2026");
  assert.equal(taskDueLabel("2026-10-02T00:00:00Z"), "10/2/2026");
});

test("the bare form it already handled is unchanged", () => {
  assert.equal(taskDueLabel("2026-10-02"), "10/2/2026");
});

test("a deadline with a real time of day still shows the time", () => {
  const label = taskDueLabel("2026-10-02T15:00:00");
  assert.match(label, /10\/2\/2026/);
  assert.match(label, /3:00:00 PM|3:00:00 PM/);
});

test("the sheet asks the shared rule rather than carrying its own", () => {
  const sheet = readFileSync("src/components/tasks/NotificationTaskSheet.tsx", "utf8");
  assert.match(sheet, /taskDueLabel\(task\.due_at\)/);
  assert.doesNotMatch(
    sheet,
    /task\.due_at\.length===10/,
    "the inline two-branch version is what got the day wrong",
  );
});
