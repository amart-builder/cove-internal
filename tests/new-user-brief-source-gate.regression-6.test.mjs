import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { checkLatestBriefWriter } from '../scripts/cove-check-brief-writer.mjs';

function source(id, note) {
  return { id, freshness: 'current', chars: 20, note };
}

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
