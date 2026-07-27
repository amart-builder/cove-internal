import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { POST as mint } from '../src/app/api/buddy/confirm-delete/route.ts';
import { POST as consume } from '../src/app/api/buddy/confirm-delete/consume/route.ts';
import { getQuietCurrentCsrfToken } from '../src/lib/quiet-current/store.ts';

test('confirm-delete routes mint an exact single-use token', async (t) => {
  const root = path.join(os.tmpdir(), `forge-buddy-confirm-${process.pid}-${Date.now()}`);
  const previousMode = process.env.FORGE_DAY_PLAN_ACCESS_MODE;
  const previousDb = process.env.FORGE_DB_PATH;
  const previousQuietFile = process.env.FORGE_QUIET_CURRENT_FILE;
  const quietFile = `buddy-confirm-${process.pid}-${Date.now()}.json`;
  process.env.FORGE_DAY_PLAN_ACCESS_MODE = 'loopback';
  process.env.FORGE_DB_PATH = path.join(root, 'forge.db');
  process.env.FORGE_QUIET_CURRENT_FILE = quietFile;
  t.after(() => {
    globalThis.__forgeBuddyStore?.close();
    delete globalThis.__forgeBuddyStore;
    delete globalThis.__forgeBuddyStoreVersion;
    if (previousMode === undefined) delete process.env.FORGE_DAY_PLAN_ACCESS_MODE;
    else process.env.FORGE_DAY_PLAN_ACCESS_MODE = previousMode;
    if (previousDb === undefined) delete process.env.FORGE_DB_PATH;
    else process.env.FORGE_DB_PATH = previousDb;
    if (previousQuietFile === undefined) delete process.env.FORGE_QUIET_CURRENT_FILE;
    else process.env.FORGE_QUIET_CURRENT_FILE = previousQuietFile;
    rmSync(path.join(process.cwd(), 'data', quietFile), { force: true });
    rmSync(path.join(process.cwd(), 'data', `${quietFile}.token`), { force: true });
    rmSync(root, { recursive: true, force: true });
  });

  const mintedResponse = await mint(new NextRequest('http://127.0.0.1:3200/api/buddy/confirm-delete', {
    method: 'POST',
    headers: {
      host: '127.0.0.1:3200',
      'content-type': 'application/json',
      'x-forge-csrf': getQuietCurrentCsrfToken(),
    },
    body: JSON.stringify({ table: 'contacts', id: 'c1', label: 'Jane Doe' }),
  }));
  const minted = await mintedResponse.json();
  assert.equal(mintedResponse.status, 200, JSON.stringify(minted));
  assert.equal(typeof minted.token, 'string');

  const request = (id) => new NextRequest('http://127.0.0.1:3200/api/buddy/confirm-delete/consume', {
    method: 'POST',
    headers: { host: '127.0.0.1:3200', 'content-type': 'application/json' },
    body: JSON.stringify({ token: minted.token, table: 'contacts', id }),
  });
  assert.equal((await consume(request('wrong'))).status, 409);
  assert.equal((await consume(request('c1'))).status, 200);
  assert.equal((await consume(request('c1'))).status, 410);
});
