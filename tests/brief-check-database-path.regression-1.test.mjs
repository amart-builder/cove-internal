import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkLatestBriefWriter } from '../scripts/cove-check-brief-writer.mjs';

function dataDirWithBrief(t, writer) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-brief-check-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (!writer) return dir;
  const db = new Database(path.join(dir, 'cove.db'));
  db.exec(`CREATE TABLE day_plan_briefs (
    id INTEGER PRIMARY KEY, status TEXT, brief_json TEXT,
    source_manifest_json TEXT, finished_at TEXT, updated_at TEXT
  )`);
  db.prepare(
    'INSERT INTO day_plan_briefs (status, brief_json, finished_at, updated_at) VALUES (?, ?, ?, ?)',
  ).run('succeeded', JSON.stringify({ writer }), '2026-09-21T15:00:00.000Z', '2026-09-21T15:00:00.000Z');
  db.close();
  return dir;
}

function withDataDir(dir, run) {
  const previous = process.env.COVE_DATA_DIR;
  process.env.COVE_DATA_DIR = dir;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.COVE_DATA_DIR;
    else process.env.COVE_DATA_DIR = previous;
  }
}

// SETUP.md Step 5 runs this check, and CONFIGURATION.md documents the database
// as living under COVE_DATA_DIR. The check read only COVE_DB_PATH out of the
// process environment, so on an install whose data directory was moved -- or
// configured in .env.local, which is where SETUP.md puts it -- it opened
// <repo>/data/cove.db and reported on a database nothing had written.
test('the brief check opens the database the app opens', (t) => {
  const dir = dataDirWithBrief(t, 'claude');
  const result = withDataDir(dir, () => checkLatestBriefWriter({}));
  assert.equal(result.writer, 'claude');
  assert.equal(result.dbPath, path.join(dir, 'cove.db'));
});

test('a database that is not there yet is named, not reported as unopenable', (t) => {
  const dir = dataDirWithBrief(t, undefined);
  assert.throws(
    () => withDataDir(dir, () => checkLatestBriefWriter({})),
    (error) => {
      assert.match(error.message, /Cove has no database at /);
      assert.match(error.message, new RegExp(path.join(dir, 'cove.db').replaceAll('\\', '\\\\')));
      assert.doesNotMatch(error.message, /unable to open database file/);
      return true;
    },
  );
});

test('an explicit database path still wins over the resolver', (t) => {
  const configured = dataDirWithBrief(t, 'codex');
  const other = dataDirWithBrief(t, 'claude');
  const result = withDataDir(other, () =>
    checkLatestBriefWriter({ dbPath: path.join(configured, 'cove.db') }));
  assert.equal(result.writer, 'codex');
});

test('the check shares the resolver the recovery commands use', () => {
  const source = readFileSync(new URL('../scripts/cove-check-brief-writer.mjs', import.meta.url), 'utf8');
  assert.match(source, /loadCoveRuntimePaths/);
  assert.doesNotMatch(source, /coveEnv\("DB_PATH"\)/);
});
