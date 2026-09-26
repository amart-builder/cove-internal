/**
 * Friday 2026-09-25: Alex read his board and found the titles indirect.
 *
 * Every title below is copied from his saved task list or from that day's
 * plan. They are the shapes that kept coming back after each lane was told,
 * in its own words, how a title should read: Cove's bookkeeping about its own
 * reminders ("Use Monday's existing reminder to review ..."), an approval
 * step named as preparation ("Prepare X for Alex's approval"), an explanatory
 * clause carried into the title, a meeting-notes subject line kept verbatim
 * ("Follow ups: Notes: “Zac Bright and Edge AI” Aug 5, 2026"), pasted prose
 * cut mid-word at 80 characters, and the operator addressed by name on his
 * own board.
 *
 * `cardTitle` (src/lib/tasks/card-title.ts) is applied at every write of a
 * machine-written card: the inbound task writer (triage, meeting analyst,
 * meeting bundle, fallback), the planner's cards, and accepted suggestions.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CARD_TITLE_MAX, cardTitle } from "../src/lib/tasks/card-title.ts";
import {
  createAnalystInboundTask,
  createFallbackInboundTask,
} from "../src/lib/intake/task-writer.ts";

const REWRITES = [
  ["Use Monday's existing reminder to review Kia's booking status and the discovery-link text for your own send.",
    "Review Kia's booking status and the discovery-link text"],
  ["Review David Jacobs's booking status and discovery-link text alongside Kia's existing Monday reminder.",
    "Review David Jacobs's booking status and discovery-link text"],
  ["Prepare Radius's focused team-onboarding agenda, using the current booking and checking the existing Zoom work.",
    "Prepare Radius's focused team-onboarding agenda"],
  ["Confirm what remains of Gary's Dispatch and Cowork review, starting with his referenced material.",
    "Confirm what remains of Gary's Dispatch and Cowork review"],
  ["Prepare Porter Grieve's proposal for Alex's approval", "Approve Porter Grieve's proposal"],
  ["Prepare Ryan's Edge AI follow-up for approval", "Approve Ryan's Edge AI follow-up"],
  ["Prepare IRT deal information email for Alex's approval", "Approve IRT deal information email"],
  ["Follow ups: Notes: “Zac Bright and Edge AI” Aug 5, 2026", "Work through follow-ups from Zac Bright and Edge AI"],
  ["Follow ups: Notes: “BayBridge & Edge AI Kickoff” Aug 27, 2026", "Work through follow-ups from BayBridge & Edge AI Kickoff"],
  ["Follow ups: Gary Gersh and Edge AI", "Work through follow-ups from Gary Gersh and Edge AI"],
  ["Mock up the data deal marketplace. Due today, September 22, 2026. Alex wants thi",
    "Mock up the data deal marketplace"],
  ["Alex, first verify whether the new passkey and Plaid connection were yours.",
    "Verify whether the new passkey and Plaid connection were yours"],
];

// Titles that already read the way the board should: left exactly as they are.
const KEPT = [
  "Text David Jacobs to book the AI discovery call",
  "Build the ramp plan for Asher, Ben and Ryan",
  "Spend 2 hours finalizing Slipstream",
  "Prepare and cover model selection with Asher on Friday",
  "Review Joseph Black’s referral terms and draft a reply",
  "Send Zoom meeting details to Radius office email",
  "Email",
];

test("Friday's indirect titles are rewritten as the operator's move", () => {
  for (const [before, after] of REWRITES) assert.equal(cardTitle(before), after, before);
});

test("titles that already read well are not touched", () => {
  for (const title of KEPT) assert.equal(cardTitle(title), title);
});

test("the rewrite is idempotent and bounded", () => {
  const long = "Finish the remaining Edge OS sales dashboard changes and verify the saved client and next-action view";
  for (const title of [...REWRITES.flat(), ...KEPT, long]) {
    const once = cardTitle(title);
    assert.equal(cardTitle(once), once, title);
    assert.ok(once.length <= CARD_TITLE_MAX, once);
    assert.doesNotMatch(once, /\.$/);
    assert.doesNotMatch(once, /\b(existing reminder|for (\w+'s )?approval|own send)\b/i);
  }
  assert.match(cardTitle(long), /…$/);
  assert.doesNotMatch(cardTitle(long), /\bsa…$/);
});

function writerFixture(t) {
  const dir = path.join(os.tmpdir(), `cove-card-title-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writerFetch(posts) {
  return async (url, init = {}) => {
    const value = String(url);
    if (value.includes("/api/cove-rest/task_columns")) {
      return new Response(JSON.stringify([
        { id: "not-started", name: "Not Started", position: 0 },
        { id: "today", name: "Must happen today", position: 10 },
      ]));
    }
    if (value.includes("/api/cove-rest/tasks?")) return new Response("[]");
    if (value.endsWith("/api/day-plan")) return new Response('{"csrfToken":"csrf"}');
    if (value.endsWith("/api/cove-rest/tasks") && init.method === "POST") {
      const body = JSON.parse(init.body);
      posts.push(body);
      return new Response(JSON.stringify([body]), { status: 201 });
    }
    throw new Error(`unexpected request: ${value}`);
  };
}

function event(id, rawText, source) {
  return {
    id, source, source_id: `${id}:src`, raw_text: rawText, machine: "test", state: "pending",
    task_id: null, error: null, attempts: 0,
    created_at: "2026-09-25T16:00:00.000Z", updated_at: "2026-09-25T16:00:00.000Z",
  };
}

test("the meeting analyst's card is written with the direct title", async (t) => {
  const posts = [];
  await createAnalystInboundTask(
    event("55555555-5555-4555-8555-555555555555", "meeting", "meeting"),
    {
      title: "Prepare Porter Grieve's proposal for Alex's approval.",
      description: "Porter asked for the proposal by Monday.",
      brief: "",
      dueAt: "2026-09-28T09:00:00-07:00",
      priority: "medium",
      notificationPolicy: "due",
    },
    {
      dataDir: writerFixture(t),
      fetchImpl: writerFetch(posts),
      webBaseUrl: "http://card-title-analyst.test",
      now: () => new Date("2026-09-25T16:00:00.000Z"),
    },
  );
  assert.equal(posts[0].title, "Approve Porter Grieve's proposal");
});

test("an untriaged capture is titled by its first sentence, not cut mid-word", async (t) => {
  const posts = [];
  await createFallbackInboundTask(
    event(
      "66666666-6666-4666-8666-666666666666",
      "Mock up the data deal marketplace. Due today, September 22, 2026. Alex wants this before the Petrit call.",
      "chat",
    ),
    {
      dataDir: writerFixture(t),
      fetchImpl: writerFetch(posts),
      webBaseUrl: "http://card-title-fallback.test",
      now: () => new Date("2026-09-22T16:00:00.000Z"),
    },
  );
  assert.equal(posts[0].title, "Mock up the data deal marketplace");
  assert.match(posts[0].description, /Alex wants this before the Petrit call/);
});
