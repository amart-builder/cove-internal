import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openLocalDatabase } from "../src/lib/local/database.ts";
import { createWorkSuggestion, getQuietCurrentSnapshot, setQuietCurrentNowForTests } from "../src/lib/quiet-current/store.ts";
import { consumeProgressSuggestionRelays, writeProgressSuggestionRelay } from "../src/lib/progress/relay.ts";
import { runAttentionSweep } from "../scripts/cove-attention-sweep.mjs";

// Anchored to the run, not to a calendar date. A relay expires three days after
// its createdAt, and the suggestion store rejects an expiry that is already in
// the past against its own clock, so a frozen literal here silently rots: this
// file began failing once the wall clock passed 2026-09-18.
const now = new Date(Date.now() - 60 * 60 * 1000);

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "cove-review-paths-"));
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(COVE|FORGE)_/.test(key)));
  for (const key of Object.keys(saved)) delete process.env[key];
  const fallback = path.join(root, "fallback");
  const selected = path.join(root, "selected");
  mkdirSync(fallback);
  mkdirSync(selected);
  process.env.COVE_DATA_DIR = fallback;
  t.after(() => {
    setQuietCurrentNowForTests(undefined);
    for (const key of Object.keys(process.env)) if (/^(COVE|FORGE)_/.test(key)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, fallback, selected };
}

test("progress consumption reads and writes the explicitly selected suggestion store", (t) => {
  const { selected, fallback } = fixture(t);
  setQuietCurrentNowForTests(now);
  createWorkSuggestion({ title: "Fallback sentinel", reason: "Keep separate", source: "fixture", dataDir: fallback });
  const first = { digestId: "first", taskId: "task-one", taskTitle: "First task", note: "Ready for review", evidenceQuote: "First change", claim: "likely_done", createdAt: now.toISOString() };
  writeProgressSuggestionRelay({ dataDir: selected, suggestion: first });
  assert.equal(consumeProgressSuggestionRelays({ dataDir: selected, now }).created, 1);
  assert.equal(getQuietCurrentSnapshot(selected).suggestions[0].targetTaskId, "task-one");
  assert.deepEqual(getQuietCurrentSnapshot(fallback).suggestions.map(row => row.title), ["Fallback sentinel"]);

  // A different relay for the same observed claim must look in the selected
  // store before deciding whether to create it again.
  writeProgressSuggestionRelay({ dataDir: selected, suggestion: { ...first, digestId: "second" } });
  const second = consumeProgressSuggestionRelays({ dataDir: selected, now });
  assert.equal(second.deduped, 1);
  assert.equal(second.created, 0);
  assert.equal(getQuietCurrentSnapshot(selected).suggestions.length, 1);
  assert.equal(getQuietCurrentSnapshot(fallback).suggestions.length, 1);
});

for (const mode of ["environment", "saved legacy directory", "explicit database"]) {
  test(`attention sweep uses the selected ${mode} without touching the fallback database`, async (t) => {
    const { root, selected, fallback } = fixture(t);
    const selectedPath = path.join(selected, mode === "saved legacy directory" ? "forge.db" : "cove.db");
    const target = openLocalDatabase(selectedPath);
    const other = openLocalDatabase(path.join(fallback, "cove.db"));
    t.after(() => { target.close(); other.close(); });
    target.prepare("INSERT INTO tasks(id,title,status,priority,created_at,updated_at) VALUES('selected-task','Selected task','open','medium',?,?)").run(now.toISOString(), now.toISOString());
    other.prepare("INSERT INTO tasks(id,title,status,priority,created_at,updated_at) VALUES('fallback-task','Fallback task','open','medium',?,?)").run(now.toISOString(), now.toISOString());
    if (mode === "environment") process.env.COVE_DATA_DIR = selected;
    if (mode === "saved legacy directory") {
      delete process.env.COVE_DATA_DIR;
      writeFileSync(path.join(root, ".env.local"), 'COVE_DATA_DIR="selected"\n');
    }
    const seen = [];
    const result = await runAttentionSweep({
      repoDir: root,
      ...(mode === "explicit database" ? { dbPath: selectedPath } : {}),
      now,
      shadow: true,
      claudeCall: async snapshot => { seen.push(...snapshot.tasks.map(row => row.id)); return { nudges: [] }; },
      transport: { textConfigured: false, banner() { assert.fail("No real banner"); }, text() { assert.fail("No real text"); } },
      surface() { assert.fail("No suggestion expected"); },
      surfaceSuppression() { assert.fail("No suppression expected"); },
    });
    assert.equal(result.status, "shadow");
    assert.deepEqual(seen, ["selected-task"]);
    assert.equal(other.prepare("SELECT count(*) FROM cove_attention_ledger").pluck().get(), 0);
    assert.equal(other.prepare("SELECT title FROM tasks").pluck().get(), "Fallback task");
  });
}
