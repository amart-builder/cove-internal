// The owner matcher accepted a three-character first-name prefix either way
// round, so an operator called Sam owned everything Samantha committed to in
// the meeting: her work became his task, with her name nowhere on it. The two
// directions are not equally safe.
import test from "node:test";
import assert from "node:assert/strict";
import { isOperatorOwned } from "../src/lib/intake/meeting-followups.mjs";

const NONE = [];

test("a longer name in the notes is somebody else, not the operator", () => {
  assert.equal(isOperatorOwned("Samantha", "Sam Ortiz", NONE), false);
  assert.equal(isOperatorOwned("Samantha Lee", "Sam Ortiz", NONE), false);
  assert.equal(isOperatorOwned("Christopher", "Chris", NONE), false);
  assert.equal(isOperatorOwned("Daniela", "Dan Rivera", NONE), false);
});

test("the notes shortening the operator's own name still lands on them", () => {
  assert.equal(isOperatorOwned("Dan", "Daniel Rivera", NONE), true);
  assert.equal(isOperatorOwned("Dan R.", "Daniel Rivera", NONE), true);
  assert.equal(isOperatorOwned("Chris", "Christopher Ortiz", NONE), true);
  assert.equal(isOperatorOwned("Daniel", "Daniel Rivera", NONE), true);
  assert.equal(isOperatorOwned("Daniel Rivera", "Daniel Rivera", NONE), true);
});

test("an alias settles what the letters cannot", () => {
  // The direction the rule refuses, stated once by the operator instead.
  assert.equal(isOperatorOwned("Christopher", "Chris", ["Christopher Ortiz"]), true);
  assert.equal(isOperatorOwned("Sasha", "Alexandra Petrova", ["Sasha"]), true);
  // An alias is read exactly as the configured name is, first token included,
  // so "Sasha Ivanova" matches an operator who goes by Sasha. That is the same
  // ambiguity "Dan R." already has against a Daniel Rivera, and the same
  // answer; an alias adds a name, it does not add a stricter rule.
  assert.equal(isOperatorOwned("Sasha Ivanova", "Alexandra Petrova", ["Sasha"]), true);
  // What it does not do is widen the guessing: the refused direction stays
  // refused against the configured name.
  assert.equal(isOperatorOwned("Samantha", "Sam Ortiz", ["Sam"]), false);
});

test("the plain cases are unchanged", () => {
  assert.equal(isOperatorOwned("me", "Sam Ortiz", NONE), true);
  assert.equal(isOperatorOwned("self", "Sam Ortiz", NONE), true);
  assert.equal(isOperatorOwned("", "Sam Ortiz", NONE), false);
  assert.equal(isOperatorOwned("Petrit", "Sam Ortiz", NONE), false);
  // Two letters is not a nickname, it is a coincidence.
  assert.equal(isOperatorOwned("Sa", "Samantha", NONE), false);
  // Nobody configured, so routing is not meaningful and own-work wins.
  assert.equal(isOperatorOwned("Anyone at all", "the operator", NONE), true);
});
