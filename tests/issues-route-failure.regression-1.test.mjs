import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';

import { jobFailureDetail } from '../src/lib/reliability/job-failure-copy.ts';

// Issues is the page somebody opens because something is already wrong. On a
// full disk it answered 500 with a zero-byte body; the client parses before it
// checks the status, so the whole page read "Unexpected end of JSON input".
// Measured against a real 3 MB filesystem with no space left, and against a
// database file that is not a database.

async function issuesGet(dir) {
  const previous = { ...process.env };
  process.env.COVE_DATA_DIR = dir;
  process.env.COVE_DB_PATH = path.join(dir, 'cove.db');
  process.env.NEXT_PUBLIC_COVE_RUNTIME = 'local';
  writeFileSync(path.join(dir, 'cove.db'), 'this is not a database\n');
  try {
    const route = await import(`../src/app/api/failures/implementation.ts?case=${path.basename(dir)}`);
    const response = await route.GET(new NextRequest('http://127.0.0.1:3200/api/failures', {
      headers: { host: '127.0.0.1:3200' },
    }));
    const text = await response.text();
    return { status: response.status, text };
  } finally {
    for (const key of ['COVE_DATA_DIR', 'COVE_DB_PATH', 'NEXT_PUBLIC_COVE_RUNTIME']) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('Issues answers with a sentence rather than an empty body', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-issues-corrupt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { status, text } = await issuesGet(dir);
  assert.equal(status, 500);
  assert.notEqual(text.length, 0, 'an empty body is what the screen could not read');
  const body = JSON.parse(text);
  assert.match(body.error, /^Cove couldn't load your issues\./);
  assert.match(body.error, /database file could not be read/);
  assert.doesNotMatch(body.error, /not a database|SQLITE/, 'this string reaches the screen');
  assert.match(body.detail, /not a database/);
  // Which database, which is the other half of a diagnosis from another city.
  assert.equal(body.dbPath, path.join(dir, 'cove.db'));
});

test('a data folder Cove cannot open is named, and still retries', () => {
  // Measured on a read-only bind mount: SQLite says CANTOPEN, not EROFS. It
  // also says it when an external volume is asleep, which does clear on its
  // own, so this one keeps the retry sentence.
  const text = jobFailureDetail('backup', 'SQLITE_CANTOPEN: unable to open database file', true);
  assert.match(text, /could not open its database file/);
  assert.match(text, /try again automatically/, 'a sleeping volume comes back');
});
