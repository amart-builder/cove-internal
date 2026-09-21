import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { recordEvent, resolveEvent } from "../src/lib/intake/inbox.ts";
import { listFailures } from "../src/lib/reliability/failures.ts";
import { buildTriagePrompt, goalsText } from "../src/lib/intake/run.ts";

function fixture(t) {
  const dir = path.join(os.tmpdir(), `cove-degraded-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  const previous = new Map([
    ["COVE_DB_PATH", process.env.COVE_DB_PATH],
    ["COVE_DATA_DIR", process.env.COVE_DATA_DIR],
    ["NEXT_PUBLIC_COVE_RUNTIME", process.env.NEXT_PUBLIC_COVE_RUNTIME],
    ["COVE_TIMEZONE", process.env.COVE_TIMEZONE],
  ]);
  process.env.COVE_DB_PATH = path.join(dir, "cove.db");
  process.env.COVE_DATA_DIR = dir;
  process.env.NEXT_PUBLIC_COVE_RUNTIME = "local";
  process.env.COVE_TIMEZONE = "America/Los_Angeles";
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("a capture that fell back to a raw card is a visible failure, not a silent success", async (t) => {
  const dir = fixture(t);
  const { event } = await recordEvent({
    source: "manual",
    sourceId: "capture-1",
    rawText: "Call the accountant back about the quarterly filing",
  });
  // What runCoveIntake does when triage throws: keep the raw text as a card and
  // record the reason on the event.
  await resolveEvent(event.id, {
    state: "triaged",
    taskId: event.id,
    error: "triage_goals_unavailable",
  });
  const failures = listFailures({ dbPath: path.join(dir, "cove.db") })
    .filter((row) => row.sourceId === event.id);
  assert.equal(
    failures.length,
    1,
    "Cove told the person it would work out what this is. When it could not, that has to be visible somewhere.",
  );
  assert.doesNotMatch(
    failures[0].message,
    /triage_goals_unavailable/,
    "an error code is not a sentence a non-technical person can act on",
  );
});

test("a clean triage records no failure and still clears an earlier one", async (t) => {
  const dir = fixture(t);
  const { event } = await recordEvent({
    source: "manual",
    sourceId: "capture-2",
    rawText: "Send the revised scope to Harper",
  });
  await resolveEvent(event.id, { state: "triaged", taskId: event.id, error: "triage_goals_unavailable" });
  await resolveEvent(event.id, { state: "triaged", taskId: event.id });
  const open = listFailures({ dbPath: path.join(dir, "cove.db") })
    .filter((row) => row.sourceId === event.id && !row.dismissedAt);
  assert.equal(open.length, 0, "a later clean pass must clear the earlier degraded one");
});

test("missing goals degrade the triage prompt instead of failing the capture", () => {
  const dir = path.join(os.tmpdir(), `cove-nogoals-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    const goals = goalsText(dir);
    assert.equal(typeof goals, "string", "a missing goals file must not throw the whole triage away");
    const prompt = buildTriagePrompt({
      protocol: "PROTOCOL",
      rawText: "Call the accountant back",
      source: "manual",
      goals,
      projects: [],
      board: { columns: [], tasks: [] },
      now: new Date("2026-09-21T16:00:00Z"),
    });
    assert.match(prompt, /GOALS=/, "the prompt still declares the goals slot, empty and honest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
