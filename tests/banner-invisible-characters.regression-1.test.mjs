/**
 * One invisible character walked a domain past the banner sanitizer.
 *
 * sanitizeAttentionContent exists because an email subject or a meeting line
 * becomes a banner on the person's Mac, and a banner must not carry a link, an
 * address, a phone number or a domain. It stripped all four -- as long as the
 * attacker wrote them in plain characters.
 *
 *     "Visit evil⁠.example now"  ->  "Visit evil⁠.example now"
 *
 * U+2060 WORD JOINER renders as nothing, so that banner reads "Visit
 * evil.example now". The joiner breaks the label-dot-label shape the domain
 * pattern looks for, and the remaining ".example" has no leading label, so
 * nothing matches and the whole domain survives.
 *
 * The bidi controls were worse, because they do not need to defeat a pattern.
 * U+202E flips the text that follows it, so what is stored and what is read
 * are different strings, and neither the sanitizer nor cleanAttentionText
 * touched them. The C0 and C1 ranges were already stripped; this is the family
 * next door.
 *
 * ZWJ and ZWNJ are deliberately kept. They carry meaning -- emoji sequences,
 * and Persian and Devanagari orthography -- and they are not a bypass: the
 * domain rule already mangles a domain containing one.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanAttentionText,
  sanitizeAttentionContent,
} from "../src/lib/attention/safety.mjs";

test("an invisible character cannot smuggle a domain into a banner", () => {
  for (const invisible of ["⁠", "​", "﻿", "­"]) {
    const out = sanitizeAttentionContent(`Visit evil${invisible}.example now`);
    assert.doesNotMatch(out, /example/, `U+${invisible.codePointAt(0).toString(16)} carried the domain through`);
  }
});

test("bidi controls are removed, so what is stored is what is read", () => {
  for (const control of ["‪", "‫", "‬", "‭", "‮", "⁦", "⁧", "⁨", "⁩", "‎", "‏"]) {
    const out = cleanAttentionText(`Approve ${control}payment now`);
    assert.equal(out, "Approve payment now", `U+${control.codePointAt(0).toString(16)} survived`);
  }
});

test("the joiners that carry meaning are kept", () => {
  // A family emoji is one grapheme only because of the joiners inside it, and
  // Persian needs ZWNJ to spell ordinary words. Neither is a bypass: the case
  // above shows the domain rule already breaks a domain containing one.
  assert.match(cleanAttentionText("Send \u{1F468}‍\u{1F469}‍\u{1F467} the note"), /‍/);
  assert.match(cleanAttentionText("می‌خواهم"), /‌/);
  assert.doesNotMatch(sanitizeAttentionContent("Visit pay‍pal.com now"), /pal\.com/);
});

test("the guarantees this sanitizer already made still hold", () => {
  assert.equal(sanitizeAttentionContent("Go to https://evil.example/login"), "Go to");
  assert.equal(sanitizeAttentionContent("Email ben@harper.example today"), "Email today");
  assert.equal(sanitizeAttentionContent("Call +1 415 555 0134 about the invoice"), "Call about the invoice");
  assert.equal(sanitizeAttentionContent("Wire the deposit to evil.example now"), "Wire the deposit to now");
});

test("ordinary text, including accented text, is left alone", () => {
  assert.equal(
    cleanAttentionText("Prépare le dossier Réunion 3. Merci"),
    "Prépare le dossier Réunion 3. Merci",
  );
  assert.equal(sanitizeAttentionContent("Prepare the Tuesday deck"), "Prepare the Tuesday deck");
});
