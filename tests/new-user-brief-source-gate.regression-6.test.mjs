import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  checkLatestBriefWriter,
  latestSuccessfulBriefLocalSources,
  latestSuccessfulBriefWriter,
} from '../scripts/cove-check-brief-writer.mjs';

function source(id, note) {
  return { id, freshness: 'current', chars: 20, note };
}

test('a fresh install that has not written a brief yet is told that, not a SQL error', (t) => {
  // Step 5 of SETUP.md triggers the first Morning Brief and checks it. Run
  // before that brief exists -- by an agent working the steps in order, or on
  // any install that has not reached Step 5 -- the day-plan store has not
  // created day_plan_briefs yet, and what the check used to print was
  // "no such table: day_plan_briefs".
  const root = path.join(
    os.tmpdir(),
    `cove-fresh-brief-check-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  const dataDir = path.join(root, 'data');
  const dbPath = path.join(dataDir, 'cove.db');
  mkdirSync(dataDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  new Database(dbPath).close();

  assert.throws(
    () => latestSuccessfulBriefWriter(dbPath),
    /^Error: No successful Morning Brief exists yet\.$/,
  );
  assert.throws(
    () => latestSuccessfulBriefLocalSources(dbPath, dataDir),
    /^Error: No successful Morning Brief exists yet\.$/,
  );
  for (const check of [
    () => latestSuccessfulBriefWriter(dbPath),
    () => latestSuccessfulBriefLocalSources(dbPath, dataDir),
  ]) {
    assert.throws(check, (error) => !/no such table/i.test(error.message));
  }
});

test('the setup gate rejects a brief built from another installation', (t) => {
  const root = path.join(
    os.tmpdir(),
    `cove-client-source-gate-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  const dataDir = path.join(root, 'data');
  const dbPath = path.join(dataDir, 'cove.db');
  mkdirSync(path.join(dataDir, 'brief'), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const localManifest = {
    sources: [
      source('goals', path.join(dataDir, 'brief', 'goals.md')),
      source('operator_profile', path.join(dataDir, 'cove-profile.json')),
      source('leadup', path.join(dataDir, 'brief', 'leadup.md')),
      source('sprint_memo', path.join(dataDir, 'brief', 'sprint-memo.md')),
    ],
  };
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE day_plan_briefs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      brief_json TEXT,
      source_manifest_json TEXT,
      finished_at TEXT,
      updated_at TEXT NOT NULL
    )
  `);
  const insert = db.prepare(`
    INSERT INTO day_plan_briefs
      (id, status, brief_json, source_manifest_json, finished_at, updated_at)
    VALUES (?, 'succeeded', ?, ?, ?, ?)
  `);
  const at = '2026-08-07T08:00:00.000Z';
  insert.run(
    'local',
    JSON.stringify({ writer: 'claude' }),
    JSON.stringify(localManifest),
    at,
    at,
  );
  db.close();

  assert.deepEqual(
    checkLatestBriefWriter({
      dbPath,
      dataDir,
      expected: 'claude',
      expectLocalSources: true,
    }),
    {
      writer: 'claude',
      dbPath,
      localSources: ['goals', 'operator_profile', 'leadup', 'sprint_memo'],
    },
  );

  const updateDb = new Database(dbPath);
  const contaminatedManifest = structuredClone(localManifest);
  contaminatedManifest.sources.find((item) => item.id === 'operator_profile').note =
    path.join(root, 'other-user', 'operator-profile.md');
  updateDb.prepare(`
    UPDATE day_plan_briefs SET source_manifest_json = ? WHERE id = 'local'
  `).run(JSON.stringify(contaminatedManifest));
  updateDb.close();

  assert.throws(
    () => checkLatestBriefWriter({
      dbPath,
      dataDir,
      expected: 'claude',
      expectLocalSources: true,
    }),
    /source operator_profile did not come from this Cove installation/,
  );
});
