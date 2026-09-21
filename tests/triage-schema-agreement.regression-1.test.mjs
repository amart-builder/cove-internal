/**
 * The triage JSON schema and the triage validator have to agree about empty
 * strings.
 *
 * The schema is what the model is held to; the validator is what Cove accepts.
 * The schema permitted "" on every string field and the validator rejects it,
 * so a schema-valid answer could still be refused — and a refused triage costs
 * the capture its title, deadline, priority and project.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("tsx/cjs");
const {
  TRIAGE_JSON_SCHEMA,
  validateTriageOutput,
} = require("../src/lib/triage/protocol.ts");

const PROJECTS = ["Atlas"];

function output(overrides = {}) {
  return {
    title: "Send the revised scope",
    description: "Send the revised scope to the client before Friday.",
    project: "Atlas",
    priority: "high",
    due_at: "2030-01-11T17:00:00-08:00",
    autonomy: "none",
    groundwork_notes: null,
    surface: "board",
    surface_at: null,
    urgency_reason: "The client asked for it by Friday.",
    offer: "I can draft the scope for you to review.",
    ...overrides,
  };
}

const EMPTY_REJECTED = [
  "title",
  "description",
  "project",
  "urgency_reason",
  "offer",
  "groundwork_notes",
];

test("every field the validator refuses when empty is refused by the schema too", () => {
  const schema = JSON.parse(TRIAGE_JSON_SCHEMA);
  for (const field of EMPTY_REJECTED) {
    assert.throws(
      () => validateTriageOutput(output({ [field]: "" }), PROJECTS),
      new RegExp(`triage_${field}_(required|invalid)`),
      `${field}: the validator should refuse an empty string`,
    );
    const property = schema.properties[field];
    const alternatives = property.anyOf ?? [property];
    for (const alternative of alternatives) {
      if (alternative.type === "null") continue;
      assert.equal(
        alternative.minLength,
        1,
        `${field}: the schema should not offer the model an empty string`,
      );
    }
  }
});

test("the shapes the contract does allow are still accepted", () => {
  assert.equal(validateTriageOutput(output(), PROJECTS).groundwork_notes, null);
  assert.equal(
    validateTriageOutput(output({
      autonomy: "groundwork",
      groundwork_notes: "Pulled the last scope and the client's redlines.",
    }), PROJECTS).groundwork_notes,
    "Pulled the last scope and the client's redlines.",
  );
  assert.equal(
    validateTriageOutput(output({
      surface: "scheduled",
      surface_at: "2030-01-10T09:00:00-08:00",
    }), PROJECTS).surface_at,
    "2030-01-10T09:00:00-08:00",
  );
});
