import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  CONSOLIDATE_MIN_ITEMS,
  claudeMeetingFallback,
  consolidateFollowUps,
} from "../src/lib/intake/meeting-followups.mjs";
import {
  captureSummaryLine,
  planFollowUpCaptures,
} from "../scripts/meeting-followups.mjs";
import {
  createFallbackInboundTask,
  createTriagedInboundTask,
} from "../src/lib/intake/task-writer.ts";

const owned = () => true;

test("the manual Claude meeting fallback keeps its 0.75 dollar cap", async () => {
  const calls = [];
  const result = await claudeMeetingFallback("No explicit next steps.", {
    env: { COVE_JOB_RUNNER: "claude" },
    claudePath: "/fake/claude",
    spawnImpl: (executable, args) => {
      calls.push({ executable, args });
      const child = Object.assign(new EventEmitter(), {
        pid: undefined,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      });
      child.stdin.once("finish", () => queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ structured_output: [] }));
        child.stderr.end();
        child.emit("close", 0, null);
      }));
      return child;
    },
  });
  assert.deepEqual(result, []);
  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0].args.slice(
      calls[0].args.indexOf("--max-budget-usd"),
      calls[0].args.indexOf("--max-budget-usd") + 2,
    ),
    ["--max-budget-usd", "0.75"],
  );
});

test("three operator items become one bundle with checklist lines", () => {
  const items = [
    { owner: "Alex", title: "Send the recap", detail: "Cover pricing." },
    { owner: "Alex", title: "Book the venue", detail: "" },
    { owner: "Alex", title: "Ping legal", detail: "NDA redlines." },
  ];
  const { bundle, operatorItems, otherItems } = consolidateFollowUps(items, {
    meetingTitle: "Dan call",
    isOwned: owned,
  });
  assert.equal(bundle.title, "Follow ups: Dan call");
  assert.equal(
    bundle.text,
    [
      "Follow ups: Dan call",
      "",
      "- [ ] Send the recap: Cover pricing.",
      "- [ ] Book the venue",
      "- [ ] Ping legal: NDA redlines.",
      "Meeting: Dan call",
    ].join("\n"),
  );
  assert.equal(operatorItems.length, 3);
  assert.deepEqual(otherItems, []);
});

test("a missing meeting title still yields a real title and a footer", () => {
  const items = [
    { owner: "Alex", title: "One", detail: "" },
    { owner: "Alex", title: "Two", detail: "" },
  ];
  const { bundle } = consolidateFollowUps(items, { isOwned: owned });
  assert.equal(bundle.title, "Follow ups: Meeting notes");
  assert.equal(
    bundle.text,
    "Follow ups: Meeting notes\n\n- [ ] One\n- [ ] Two\nMeeting: Meeting notes",
  );
});

test("mixed owners keep non-operator items untouched in otherItems", () => {
  const sam = { owner: "Sam Rivera", title: "Send the scope", detail: "PDF." };
  const items = [
    { owner: "Alex", title: "Send the recap", detail: "" },
    sam,
    { owner: "Alex", title: "Book the venue", detail: "" },
  ];
  const { bundle, otherItems } = consolidateFollowUps(items, {
    meetingTitle: "Dan call",
    isOwned: (owner) => owner === "Alex",
  });
  assert.equal(bundle.title, "Follow ups: Dan call");
  assert.equal(bundle.text.match(/- \[ \] /g).length, 2);
  assert.deepEqual(otherItems, [sam]);
  assert.equal(otherItems[0], sam);
});

test("a single operator item stays on the per-item path", () => {
  const items = [{ owner: "Alex", title: "Send the recap", detail: "" }];
  const { bundle, operatorItems, otherItems } = consolidateFollowUps(items, {
    meetingTitle: "Dan call",
    isOwned: owned,
  });
  assert.equal(bundle, null);
  assert.deepEqual(operatorItems, items);
  assert.deepEqual(otherItems, []);
});

test("no items means no bundle and empty partitions", () => {
  const { bundle, operatorItems, otherItems } = consolidateFollowUps([], {
    meetingTitle: "Dan call",
    isOwned: owned,
  });
  assert.equal(bundle, null);
  assert.deepEqual(operatorItems, []);
  assert.deepEqual(otherItems, []);
});

test("the consolidation threshold is two", () => {
  assert.equal(CONSOLIDATE_MIN_ITEMS, 2);
});

test("CLI plan keeps original extraction indices for non-operator items", () => {
  const items = [
    { owner: "Alex", title: "Send the recap", detail: "" },
    { owner: "Sam Rivera", title: "Send the scope", detail: "PDF." },
    { owner: "Alex", title: "Book the venue", detail: "" },
  ];
  const notes = { title: "Dan call", occurrenceId: "occ-1" };
  const plan = planFollowUpCaptures(items, notes, {
    isOwned: (owner) => owner === "Alex",
  });
  assert.equal(plan.bundle.title, "Follow ups: Dan call");
  assert.equal(plan.bundledCount, 2);
  assert.equal(
    plan.bundle.sourceId,
    `meeting:${createHash("sha256").update("occ-1\0followups").digest("hex")}`,
  );
  assert.equal(plan.perItem.length, 1);
  assert.equal(plan.perItem[0].item, items[1]);
  assert.equal(plan.perItem[0].index, 1);
});

test("CLI plan with one operator item keeps every item on the per-item path", () => {
  const items = [
    { owner: "Alex", title: "Send the recap", detail: "" },
    { owner: "Sam Rivera", title: "Send the scope", detail: "" },
  ];
  const plan = planFollowUpCaptures(items, {
    title: "Dan call",
    occurrenceId: "occ-2",
  }, { isOwned: (owner) => owner === "Alex" });
  assert.equal(plan.bundle, null);
  assert.equal(plan.bundledCount, 0);
  assert.deepEqual(
    plan.perItem.map((entry) => entry.index),
    [0, 1],
  );
  assert.equal(plan.perItem[0].item, items[0]);
  assert.equal(plan.perItem[1].item, items[1]);
});

test("CLI summary keeps legacy wording unless a bundle was created", () => {
  assert.equal(
    captureSummaryLine(2, 1, 0),
    "Captured 2 operator follow-ups and 1 waiting-on commitment.",
  );
  assert.equal(
    captureSummaryLine(1, 0, 0),
    "Captured 1 operator follow-up and 0 waiting-on commitments.",
  );
  assert.equal(
    captureSummaryLine(1, 2, 3),
    "Captured 1 follow-up task (3 items) and 2 waiting-on commitments.",
  );
});

function taskWriterFixture(t) {
  const dir = path.join(
    os.tmpdir(),
    `cove-bundle-writer-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function taskWriterFetch(posts) {
  return async (url, init = {}) => {
    const value = String(url);
    if (value.includes("/api/cove-rest/task_columns")) {
      return new Response(JSON.stringify([
        { id: "not-started", name: "Not Started", position: 0 },
        { id: "today", name: "Must happen today", position: 10 },
      ]));
    }
    if (value.includes("/api/cove-rest/tasks?")) {
      return new Response("[]");
    }
    if (value.endsWith("/api/day-plan")) {
      return new Response('{"csrfToken":"csrf"}');
    }
    if (value.endsWith("/api/cove-rest/tasks") && init.method === "POST") {
      const body = JSON.parse(init.body);
      posts.push(body);
      return new Response(JSON.stringify([body]), { status: 201 });
    }
    throw new Error(`unexpected request: ${value}`);
  };
}

const bundleText = [
  "Follow ups: Dan call",
  "",
  "- [ ] Send the recap: Cover pricing.",
  "- [ ] Book the venue",
  "Meeting: Dan call",
].join("\n");

function inboundEvent(id, rawText, source = "meeting") {
  return {
    id,
    source,
    source_id: `${id}:src`,
    raw_text: rawText,
    machine: "test",
    state: "pending",
    task_id: null,
    error: null,
    attempts: 0,
    created_at: "2026-08-01T16:00:00.000Z",
    updated_at: "2026-08-01T16:00:00.000Z",
  };
}

function adversarialTriage() {
  return {
    title: "Renamed by triage",
    description: "Rewritten description that drops the checklist.",
    project: "Atlas",
    priority: "medium",
    due_at: "2026-08-06T09:00:00-07:00",
    autonomy: "none",
    groundwork_notes: null,
    surface: "board",
    surface_at: null,
    urgency_reason: "None.",
    offer: "None.",
    existing_task_id: null,
  };
}

test("triaged bundle tasks keep the captured title and checklist despite triage output", async (t) => {
  const dir = taskWriterFixture(t);
  const posts = [];
  await createTriagedInboundTask(
    inboundEvent("11111111-1111-4111-8111-111111111111", bundleText),
    adversarialTriage(),
    {
      dataDir: dir,
      fetchImpl: taskWriterFetch(posts),
      webBaseUrl: "http://bundle-triaged.test",
      now: () => new Date("2026-08-01T16:00:00.000Z"),
    },
  );
  assert.equal(posts.length, 1);
  assert.equal(posts[0].title, "Follow ups: Dan call");
  assert.equal(
    posts[0].description,
    "- [ ] Send the recap: Cover pricing.\n- [ ] Book the venue\nMeeting: Dan call",
  );
  assert.equal(posts[0].due_at, "2026-08-06T09:00:00-07:00");
  assert.equal(posts[0].priority, "medium");
  assert.equal(posts[0].project, "Atlas");
  assert.equal(posts[0].column_id, "not-started");
});

test("triaged non-bundle tasks still use the triage title and framing", async (t) => {
  const dir = taskWriterFixture(t);
  const posts = [];
  await createTriagedInboundTask(
    inboundEvent(
      "22222222-2222-4222-8222-222222222222",
      "Send the recap\nCover pricing.\nMeeting: Dan call\nNamed owner: Alex",
    ),
    adversarialTriage(),
    {
      dataDir: dir,
      fetchImpl: taskWriterFetch(posts),
      webBaseUrl: "http://plain-triaged.test",
      now: () => new Date("2026-08-01T16:00:00.000Z"),
    },
  );
  assert.equal(posts[0].title, "Renamed by triage");
  assert.match(posts[0].description, /^Rewritten description/);
});

test("a non-meeting capture starting with Follow ups: gets no override", async (t) => {
  const dir = taskWriterFixture(t);
  const posts = [];
  await createTriagedInboundTask(
    inboundEvent("44444444-4444-4444-8444-444444444444", bundleText, "chat"),
    adversarialTriage(),
    {
      dataDir: dir,
      fetchImpl: taskWriterFetch(posts),
      webBaseUrl: "http://chat-triaged.test",
      now: () => new Date("2026-08-01T16:00:00.000Z"),
    },
  );
  assert.equal(posts[0].title, "Renamed by triage");
  assert.match(posts[0].description, /^Rewritten description/);
  assert.doesNotMatch(posts[0].description, /- \[ \]/);
});

test("fallback bundle tasks also keep the captured title and checklist", async (t) => {
  const dir = taskWriterFixture(t);
  const posts = [];
  await createFallbackInboundTask(
    inboundEvent("33333333-3333-4333-8333-333333333333", bundleText),
    {
      dataDir: dir,
      fetchImpl: taskWriterFetch(posts),
      webBaseUrl: "http://bundle-fallback.test",
      now: () => new Date("2026-08-01T16:00:00.000Z"),
    },
  );
  assert.equal(posts[0].title, "Follow ups: Dan call");
  assert.equal(
    posts[0].description,
    "- [ ] Send the recap: Cover pricing.\n- [ ] Book the venue\nMeeting: Dan call" +
      "\n\nArrived via meeting and needs triage.",
  );
});
