import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadLocalEnv } from '../scripts/lib/load-local-env.mjs';

function withEnvFile(contents, run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-env-'));
  try {
    writeFileSync(path.join(dir, '.env.local'), contents);
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Next.js parses this same file with dotenv, which accepts `export KEY=value`.
// When the loader used by every script, worker and the installer dropped that
// line instead, one .env.local configured the two halves of a local-first
// install differently, with nothing on screen saying so.
test('a shell-style export line configures the workers, as it already did the web app', () => {
  withEnvFile(
    [
      'export COVE_FOLLOW_THROUGH=0',
      '   export   COVE_CHIEF_OF_STAFF=0',
      'export COVE_QUOTED="/tmp/cove data"',
      'COVE_PLAIN=1',
    ].join('\n'),
    dir => {
      const env = {};
      loadLocalEnv(dir, env);
      assert.deepEqual(env, {
        COVE_FOLLOW_THROUGH: '0',
        COVE_CHIEF_OF_STAFF: '0',
        COVE_QUOTED: '/tmp/cove data',
        COVE_PLAIN: '1',
      });
    },
  );
});

test('the export prefix needs whitespace, and malformed lines are still skipped', () => {
  withEnvFile(
    [
      'export=1',
      'exported_value=2',
      '# export COVE_COMMENTED=3',
      'NO_EQUALS_HERE',
      '=novalue',
      'COVE_SPACED = 4',
    ].join('\n'),
    dir => {
      const env = {};
      loadLocalEnv(dir, env);
      assert.deepEqual(env, {
        export: '1',
        exported_value: '2',
        COVE_SPACED: '4',
      });
    },
  );
});

test('a value already in the environment still wins over the file', () => {
  withEnvFile('export COVE_FOLLOW_THROUGH=0\n', dir => {
    const env = { COVE_FOLLOW_THROUGH: '1' };
    loadLocalEnv(dir, env);
    assert.equal(env.COVE_FOLLOW_THROUGH, '1');
  });
});
