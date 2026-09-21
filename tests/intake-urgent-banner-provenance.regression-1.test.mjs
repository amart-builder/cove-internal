/**
 * The urgent capture's banner said nothing about whose words it carried.
 *
 * enforceSurfacePolicy (src/lib/intake/run.ts) already gets the harder half
 * right: when the triage model marks an email or meeting capture
 * `surface: "now"`, the immediate text is suppressed and the capture is
 * downgraded to the board, because email and meeting content never reaches the
 * phone. What it still did was hand `policy.triage.title` to notifyNativeOnly
 * unchanged, so the Mac banner read
 *
 *     Cove / Needs attention
 *     Confirm your account at pay.example
 *
 * over Cove's name, with nothing to say the sentence came from an email a
 * stranger sent. That title is the triage model's wording of the capture, and
 * under an email capture the words beneath it are not the operator's.
 *
 * Third path with this gap in one night, after the scheduled reminder
 * (5deab4d) and the reminder script's own sanitizer copy (2a51c41).
 *
 * The rule is asserted directly rather than through runCoveIntake, because
 * notifyNativeOnly returns early off macOS, so an end-to-end case would pass
 * on Linux by never producing a banner at all -- which is the failure mode
 * this file exists to prevent.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { urgentBannerText } from "../src/lib/intake/run.ts";

const RUN_TS = readFileSync(path.join(process.cwd(), "src/lib/intake/run.ts"), "utf8");

test("an email capture says where the words came from", () => {
  assert.equal(
    urgentBannerText("Approve the payment today", "email"),
    "from email: Approve the payment today",
  );
});

test("it carries no address the person could act on", () => {
  const banner = urgentBannerText(
    "Confirm your account at pay.example or call +1 (555) 010-9999",
    "email",
  );

  assert.doesNotMatch(banner, /pay\.example/, "no domain");
  assert.doesNotMatch(banner, /555/, "no phone number");
  assert.match(banner, /^from email: /, "still labelled");
});

test("a meeting capture is labelled from meeting", () => {
  assert.equal(
    urgentBannerText("Send Dana the deck", "meeting"),
    "from meeting: Send Dana the deck",
  );
});

test("the invisible characters cannot hide a domain here either", () => {
  const banner = urgentBannerText("Visit evil⁠.example now", "email");

  assert.doesNotMatch(banner.replace(/[⁠-⁤]/g, ""), /evil\.example/);
});

test("every direct source keeps its words and is not relabelled", () => {
  for (const source of ["chat", "imessage", "voice", "buddy", "day-plan"]) {
    const banner = urgentBannerText("Book the flights at united.example", source);
    assert.equal(banner, "Book the flights at united.example", source);
  }
});

test("a direct title is still cleaned of what would misrepresent it", () => {
  const banner = urgentBannerText("Invoice ‮paid‬ now", "chat");

  assert.doesNotMatch(banner, /[‪-‮⁦-⁩]/);
  assert.match(banner, /Invoice/);
});

test("an empty or unusable title still produces something to read", () => {
  assert.equal(urgentBannerText("", "chat"), "Open Cove to review this item.");
  assert.equal(urgentBannerText("", "email"), "from email: Open Cove to review this item.");
});

test("an unrecognised source is treated as outside words", () => {
  assert.match(urgentBannerText("Wire the deposit to acct.example", ""), /^from unknown source: /);
  assert.doesNotMatch(urgentBannerText("Wire the deposit to acct.example", ""), /acct\.example/);
});

// A rule nothing calls is the buildGroundworkCommand trap: a tidy function and
// a green suite, with the live path going around it. These two assertions are
// what make the cases above mean anything.
test("the urgent banner path actually goes through the rule", () => {
  assert.match(
    RUN_TS,
    /notifyNativeOnly\([\s\S]{0,400}?nativeNotificationCommand\(urgentBannerText\(title, source\)/,
    "notifyNativeOnly must build its banner with urgentBannerText",
  );
  assert.match(
    RUN_TS,
    /await notifyNativeOnly\(policy\.triage\.title, event\.source,/,
    "the caller must pass the source the label is derived from",
  );
});
