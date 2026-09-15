import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertWebBaseMatchesDatabase, inboundTaskExists } from "../src/lib/intake/task-writer.ts";

function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cove-intake-db-guard-"));
  const keys = ["COVE_DB_PATH", "FORGE_DB_PATH", "COVE_DATA_DIR", "FORGE_DATA_DIR", "COVE_BRIEF_WEB_BASE", "FORGE_BRIEF_WEB_BASE"];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

for (const key of ["COVE_DATA_DIR", "FORGE_DATA_DIR", "COVE_DB_PATH", "FORGE_DB_PATH"]) {
  test(`intake refuses ${key}-only scratch selection before fetch`, async t => {
    const dir = fixture(t);
    process.env[key] = key.endsWith("DB_PATH") ? path.join(dir, "cove.db") : dir;
    let calls = 0;
    await assert.rejects(inboundTaskExists("fixture", { fetchImpl: async () => { calls += 1; return Response.json([]); } }), /inbound_web_base_required/);
    assert.equal(calls, 0);
  });
}

test("the config-independent default retains canonical and legacy normal install paths", t => {
  const dir = fixture(t);
  mkdirSync(path.join(dir, "data"));
  const canonical = path.join(dir, "data", "cove.db"), legacy = path.join(dir, "data", "forge.db");
  assert.doesNotThrow(() => assertWebBaseMatchesDatabase({ repoDir: dir, dbPath: canonical }));
  writeFileSync(legacy, "fixture");
  assert.doesNotThrow(() => assertWebBaseMatchesDatabase({ repoDir: dir, dbPath: legacy }));
  writeFileSync(canonical, "fixture");
  assert.doesNotThrow(() => assertWebBaseMatchesDatabase({ repoDir: dir, dbPath: canonical }));
  assert.throws(() => assertWebBaseMatchesDatabase({ repoDir: dir, dbPath: legacy }), /inbound_web_base_required/);
});

test("an explicitly matching web base permits custom data without calling the live endpoint", async t => {
  process.env.COVE_DATA_DIR = fixture(t);
  const calls = [];
  assert.equal(await inboundTaskExists("fixture", { webBaseUrl: "http://scratch.invalid:4321", fetchImpl: async url => { calls.push(String(url)); return Response.json([]); } }), false);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].startsWith("http://scratch.invalid:4321/"));
});
