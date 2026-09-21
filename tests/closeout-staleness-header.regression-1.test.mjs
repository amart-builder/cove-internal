/**
 * The staler the closeout, the quieter Cove was about it.
 *
 * closeoutTimestampHeader warns how many working days went by without a
 * closeout, and it takes that count from closeoutGapWeekdays, which searches a
 * window of the previous ten weekdays. A closeout older than that is not in the
 * window, so the count came back undefined and the branch that writes the
 * warning was skipped entirely. A closeout from eight working days ago named
 * every skipped day; one from a month ago said nothing at all, which reads
 * exactly like the one written yesterday.
 *
 * Someone who tries Cove for a week, stops, and comes back is the ordinary way
 * to land there.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  closeoutTimestampHeader,
  closeoutGapWeekdays,
} from "../src/lib/day-plan/brief-sources.ts";

const TARGET = "2026-09-21"; // a Monday
const TIMEZONE = "America/Los_Angeles";

function header(closeoutLocalDate) {
  return closeoutTimestampHeader({
    asOf: `${closeoutLocalDate}T23:00:00Z`,
    closeoutLocalDate,
    targetLocalDate: TARGET,
    targetTimezone: TIMEZONE,
  });
}

test("a closeout older than the counting window still says it is old", () => {
  // Outside the ten-weekday window, so there is no number to report.
  assert.equal(closeoutGapWeekdays("2026-08-24", TARGET), undefined);
  const text = header("2026-08-24");
  assert.match(
    text,
    /more than two working weeks/,
    "silence here reads like the closeout written yesterday",
  );
  assert.match(text, /out of date/);
});

test("the closeout still inside the window keeps its exact count", () => {
  const text = header("2026-09-08");
  assert.match(text, /8 working days/);
  assert.doesNotMatch(text, /more than two working weeks/);
});

test("yesterday's closeout is still named as the most recent word", () => {
  const text = header("2026-09-18");
  assert.match(text, /most recent word/);
  assert.doesNotMatch(text, /out of date/);
  assert.doesNotMatch(text, /went by without a closeout/);
});

test("a closeout with no recorded day claims no staleness either way", () => {
  // Nothing is known about when it covers, so inventing a verdict would be
  // worse than the missing one. It must not claim recency either.
  const text = closeoutTimestampHeader({
    asOf: undefined,
    closeoutLocalDate: undefined,
    targetLocalDate: TARGET,
    targetTimezone: TIMEZONE,
  });
  assert.match(text, /The day it covers was not recorded\./);
  assert.doesNotMatch(text, /more than two working weeks/);
  assert.doesNotMatch(text, /most recent word/);
});

test("a closeout dated on or after the brief's own day claims nothing", () => {
  // A clock skew or a hand-edited dump, not a staleness question.
  for (const date of [TARGET, "2026-09-22"]) {
    const text = header(date);
    assert.doesNotMatch(text, /more than two working weeks/);
    assert.doesNotMatch(text, /went by without a closeout/);
    assert.doesNotMatch(text, /most recent word/);
  }
});
