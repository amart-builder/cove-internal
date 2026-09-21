import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// SETUP.md and OPERATIONS.md both tell a person to run this by hand. On a full
// disk it printed an eleven-line Node stack with SQLITE_FULL, internal file
// paths and a better-sqlite3 frame, and the one fact they could act on was
// inside it. Measured against a real 3 MB filesystem with no space left.

const repoRoot = path.resolve(import.meta.dirname, '..');

function runJobs(dataDir, extraEnv = {}) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', path.join(repoRoot, 'scripts/cove-jobs.ts'), 'enqueue-backup', '--run'],
    {
      cwd: repoRoot,
      env: { ...process.env, COVE_DATA_DIR: dataDir, COVE_DB_PATH: path.join(dataDir, 'cove.db'), ...extraEnv },
      encoding: 'utf8',
    },
  );
}

test('a database Cove cannot read is a sentence, not a stack', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-jobs-notadb-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'cove.db'), 'this is not a database\n');

  const result = runJobs(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /database file could not be read/);
  assert.match(result.stderr, /restored from a backup/);
  assert.doesNotMatch(result.stderr, /better-sqlite3|node:internal|at Module/,
    'a stack is what a person reads when Cove has nothing to say; here it has');
});

test('the stack is still one environment variable away', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-jobs-debug-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'cove.db'), 'this is not a database\n');

  const result = runJobs(dir, { COVE_DEBUG: '1' });
  assert.match(result.stderr, /database file could not be read/);
  assert.match(result.stderr, /SQLITE_NOTADB|at /, 'whoever is helping still needs the frames');
});
