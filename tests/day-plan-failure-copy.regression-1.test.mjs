import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';

import { diagnosticCause } from '../src/lib/reliability/job-failure-copy.ts';

// Today renders the day-plan route's `error` verbatim. Found by filling the
// disk under a real install: the first screen of the day read
// "database or disk is full Cove couldn't refresh its suggestions. This
// doesn't touch your committed tasks." -- a raw SQLite string glued to a
// sentence about the wrong thing. Everything a person can act on reaches this
// route as its own status and its own sentence, so a 500 is always an internal
// exception and its message was never written for a screen.

async function dayPlanGet(dir) {
  const previous = { ...process.env };
  process.env.COVE_DATA_DIR = dir;
  process.env.COVE_DB_PATH = path.join(dir, 'cove.db');
  process.env.NEXT_PUBLIC_COVE_RUNTIME = 'local';
  writeFileSync(path.join(dir, 'cove.db'), 'this is not a database\n');
  try {
    const route = await import(`../src/app/api/day-plan/implementation.ts?case=${path.basename(dir)}`);
    const response = await route.GET(new NextRequest('http://127.0.0.1:3200/api/day-plan', {
      headers: { host: '127.0.0.1:3200' },
    }));
    return { status: response.status, body: await response.json() };
  } finally {
    for (const key of ['COVE_DATA_DIR', 'COVE_DB_PATH', 'NEXT_PUBLIC_COVE_RUNTIME']) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('an unreadable database does not put SQLite on the first screen of the day', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-day-plan-corrupt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { status, body } = await dayPlanGet(dir);
  assert.equal(status, 500);
  assert.match(body.error, /^Cove couldn't load your day\./);
  assert.match(body.error, /database file could not be read/);
  assert.match(body.error, /restored from a backup/, 'the only thing that fixes it');
  assert.doesNotMatch(body.error, /not a database|SQLITE|sqlite/,
    'the screen shows this string to the person');
  // The diagnosis still has to survive for whoever is helping from a distance.
  assert.match(body.detail, /not a database/);
});

test('a cause a person can act on is said in words, and reaches the same screen', () => {
  // The route composes its sentence from this, so the two stay in step.
  const full = diagnosticCause('database or disk is full');
  assert.equal("Cove couldn't load your day." + full.cause + full.remedy,
    "Cove couldn't load your day. The disk is full."
    + " Free up space on this Mac; Cove cannot finish this until then.");
  const fine = diagnosticCause('some internal invariant broke');
  assert.equal(fine.cause, '');
  assert.equal(fine.remedy, '');
});
