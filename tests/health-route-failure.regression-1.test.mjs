import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';

// An unreadable database is the worst state Cove can be in and the one the
// screen describes least well: Today says "Some data didn't refresh. Retrying…",
// which reads as a hiccup. /api/health is what a person, or someone helping
// them from a distance, asks next, so it has to answer with the reason rather
// than a 500 with an empty body.

function request() {
  return new NextRequest('http://127.0.0.1:3200/api/health', {
    headers: { host: '127.0.0.1:3200' },
  });
}

async function healthGet(dir, corrupt) {
  const previous = { ...process.env };
  process.env.COVE_DATA_DIR = dir;
  process.env.COVE_DB_PATH = path.join(dir, 'cove.db');
  process.env.NEXT_PUBLIC_COVE_RUNTIME = 'local';
  if (corrupt) writeFileSync(path.join(dir, 'cove.db'), 'this is not a database\n');
  try {
    const route = await import(`../src/app/api/health/route.ts?case=${corrupt ? 'corrupt' : 'clean'}`);
    const response = await route.GET(request());
    return { status: response.status, body: await response.json() };
  } finally {
    for (const key of ['COVE_DATA_DIR', 'COVE_DB_PATH', 'NEXT_PUBLIC_COVE_RUNTIME']) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('health says what is wrong when the database cannot be read', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-health-corrupt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { status, body } = await healthGet(dir, true);
  assert.equal(status, 500);
  assert.match(body.error, /could not read its own state/);
  // The reason SQLite gives is the whole diagnosis, so it has to survive.
  assert.match(body.detail, /not a database/);
  // And where to look, which is the other half of a remote diagnosis.
  assert.equal(body.dbPath, path.join(dir, 'cove.db'));
});
