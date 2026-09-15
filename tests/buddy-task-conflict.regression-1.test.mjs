import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseBuddyDataArgs, runBuddyDataCommand } from "../scripts/cove-buddy-data.ts";
import { handleLocalRest } from "../src/lib/local/db.ts";

const command = (patch) => parseBuddyDataArgs(["update", "tasks", "--id", "task", "--json", JSON.stringify(patch)]);

test("Buddy rejects missing or unsupported read guards before any request", async () => {
  for (const patch of [
    { title: "New" },
    { title: "New", _expected: {} },
    { title: "New", _expected: { updatedAt: "" } },
    { title: "New", _expected: { updatedAt: "date" } },
    { title: "New", _expected: { updatedAt: "date", title: "Old", unsupported: "value" } },
    { description: "New", _expected: { updatedAt: "date", description: 3 } },
  ]) {
    let called = false;
    await assert.rejects(runBuddyDataCommand(command(patch), { fetch: async () => { called = true; throw new Error("must not fetch"); } }), /Read the latest task/);
    assert.equal(called, false);
  }
});

test("Buddy preserves concurrent notes and retries a rebuilt patch with the real local conflict guard", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-buddy-conflict-"));
  const prior = process.env.COVE_DB_PATH;
  process.env.COVE_DB_PATH = path.join(dir, "cove.db");
  t.after(() => { if (prior === undefined) delete process.env.COVE_DB_PATH; else process.env.COVE_DB_PATH = prior; rmSync(dir, { recursive: true, force: true }); });
  const params = new URLSearchParams({ id: "eq.task" });
  handleLocalRest("tasks", "POST", new URLSearchParams(), { id: "task", title: "Call", description: "Original", status: "open" });
  const original = handleLocalRest("tasks", "GET", params).body[0];
  handleLocalRest("tasks", "PATCH", params, { description: "Original\nGary's note" });
  const lines = [];
  const requests = [];
  const fetch = async (url, init = {}) => {
    requests.push({ url, init });
    if (String(url).endsWith("/api/day-plan")) return Response.json({ csrfToken: "fixture" });
    assert.equal(init.method, "PATCH");
    const result = handleLocalRest("tasks", "PATCH", new URL(url).searchParams, JSON.parse(init.body));
    return Response.json(result.body, { status: result.status });
  };
  const run = (patch) => runBuddyDataCommand(command(patch), { fetch, write: (line) => lines.push(line) });
  await assert.rejects(run({ description: "Original\nBuddy's fact", _expected: { updatedAt: original.updated_at, description: original.description } }), /HTTP 409/);
  assert.equal(lines.length, 0);
  const latest = handleLocalRest("tasks", "GET", params).body[0];
  assert.equal(latest.description, "Original\nGary's note");
  // Even if timestamps match, the original edited field protects the notes.
  await assert.rejects(run({ description: "Original\nBuddy's fact", _expected: { updatedAt: latest.updated_at, description: original.description } }), /HTTP 409/);
  assert.equal(lines.length, 0);
  await run({ description: `${latest.description}\nBuddy's fact`, _expected: { updatedAt: latest.updated_at, description: latest.description } });
  assert.equal(handleLocalRest("tasks", "GET", params).body[0].description, "Original\nGary's note\nBuddy's fact");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^RECEIPT /);
  assert.equal(requests.filter(({ init }) => init.method === "PATCH").length, 3);
});

test("Buddy timestamp guard protects updates outside the editor's field vocabulary", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-buddy-state-conflict-"));
  const prior = process.env.COVE_DB_PATH;
  process.env.COVE_DB_PATH = path.join(dir, "cove.db");
  t.after(() => { if (prior === undefined) delete process.env.COVE_DB_PATH; else process.env.COVE_DB_PATH = prior; rmSync(dir, { recursive: true, force: true }); });
  const params = new URLSearchParams({ id: "eq.task" });
  handleLocalRest("tasks", "POST", new URLSearchParams(), { id: "task", title: "Call", status: "open" });
  let receipts = 0;
  await assert.rejects(runBuddyDataCommand(command({ status: "done", _expected: { updatedAt: "2000-01-01T00:00:00Z" } }), {
    fetch: async (url, init = {}) => {
      if (String(url).endsWith("/api/day-plan")) return Response.json({ csrfToken: "fixture" });
      const result = handleLocalRest("tasks", "PATCH", params, JSON.parse(init.body));
      return Response.json(result.body, { status: result.status });
    }, write: () => { receipts += 1; },
  }), /HTTP 409/);
  assert.equal(receipts, 0);
  assert.equal(handleLocalRest("tasks", "GET", params).body[0].status, "open");
});
