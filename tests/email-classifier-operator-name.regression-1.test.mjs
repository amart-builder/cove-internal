import assert from "node:assert/strict";
import test from "node:test";

import { buildEmailClassifierPrompt } from "../src/lib/email/classifier.ts";

function prompt(operatorName) {
  return buildEmailClassifierPrompt({
    accountEmail: "gary@example.com",
    ...(operatorName === undefined ? {} : { operatorName }),
    sender: "ben@harper.example",
    subject: "Scope for next quarter",
    text: "Can you send the revised scope by Friday?",
    voice: "",
  });
}

test("the bucket rules name the person whose inbox this is", () => {
  const written = prompt("Gary");
  assert.match(written, /- reply: Gary should reply\./);
  assert.match(written, /- action: Gary needs to do or review something/);
});

test("no other operator's name is baked into the prompt", () => {
  assert.doesNotMatch(
    prompt("Gary"),
    /\bAlex\b/,
    "the developer's own name used to be hardcoded here, so every install classified mail against instructions about a stranger",
  );
});

test("an install with no configured name still reads sensibly", () => {
  const written = prompt("   ");
  assert.match(written, /- reply: The operator should reply\./);
});
