/**
 * The model was handed two different numbers for the same field.
 *
 * The live brief prompt is PLANNING_QUESTIONS, then the planning instructions,
 * then JSON_SCHEMA, then the writing mandate from prompts/chief-of-staff.md.
 * The mandate says "Five at the very most" for watch items and explains why:
 * they print directly under the brief, so eight is a longer read than the brief
 * itself and the operator skims past the whole section. The schema printed in
 * the same prompt said maxItems 8.
 *
 * Same shape as the 160-word cap and the removed headline field: the writing
 * mandate and the planning contract stating different things in one prompt.
 *
 * The two validators stay at 8 on purpose. A decision stored before this
 * change can hold up to eight watches and must still be readable.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DAILY_PLANNING_SCHEMA,
  dailyPlanningSchema,
  validateDailyDecision,
} from "../src/lib/chief-of-staff/daily-planning.ts";

const MANDATE = readFileSync(
  path.join(process.cwd(), "prompts", "chief-of-staff.md"),
  "utf8",
);

function context(referenceCount) {
  const references = Array.from({ length: referenceCount }, (_unused, index) => ({
    kind: "task",
    id: `task-${index + 1}`,
    version: "v1",
    revision: 1,
    title: `Task ${index + 1}`,
  }));
  return {
    plan: null,
    references,
    text: JSON.stringify({ now: "2026-09-21T15:00:00.000Z" }),
    now: "2026-09-21T15:00:00.000Z",
  };
}

test("the mandate still says five, which is what the schema has to match", () => {
  // If this line is reworded, the schema below needs revisiting with it rather
  // than drifting apart again.
  assert.match(MANDATE, /Five at the very most/);
});

test("the schema the model is shown agrees with the mandate", () => {
  assert.equal(DAILY_PLANNING_SCHEMA.properties.watches.maxItems, 5);
  const runtime = dailyPlanningSchema(context(9));
  assert.equal(
    runtime.properties.watches.maxItems,
    5,
    "the runtime schema is what is printed into the prompt as JSON_SCHEMA",
  );
});

test("an empty board still forbids watches outright", () => {
  const runtime = dailyPlanningSchema(context(0));
  assert.equal(runtime.properties.watches.maxItems, 0);
});

test("a decision stored under the old cap is still readable", () => {
  // The validators keep accepting 8. Tightening them would make yesterday's
  // stored decision unreadable, which is a worse failure than a long list.
  const ctx = context(8);
  const decision = validateDailyDecision(
    {
      narrativeParagraphs: ["A paragraph."],
      actions: [],
      questions: [],
      watches: ctx.references.map((_unused, index) => `ref.${index + 1}`),
    },
    ctx,
  );
  assert.equal(decision.watches.length, 8);
});
