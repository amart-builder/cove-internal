import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { POST as mint } from '../src/app/api/buddy/confirm-delete/route.ts';
import { POST as consume } from '../src/app/api/buddy/confirm-delete/consume/route.ts';
import { getBuddyStore } from '../src/lib/buddy/store.ts';
import { getQuietCurrentCsrfToken } from '../src/lib/quiet-current/store.ts';

function setup(t) {
  const root = path.join(os.tmpdir(), `cove-buddy-confirm-${process.pid}-${Date.now()}-${Math.random()}`);
  const previousMode = process.env.COVE_DAY_PLAN_ACCESS_MODE;
  const previousDb = process.env.COVE_DB_PATH;
  const previousQuietFile = process.env.COVE_QUIET_CURRENT_FILE;
  const quietFile = `buddy-confirm-${process.pid}-${Date.now()}-${Math.random()}.json`;
  process.env.COVE_DAY_PLAN_ACCESS_MODE = 'loopback';
  process.env.COVE_DB_PATH = path.join(root, 'cove.db');
  process.env.COVE_QUIET_CURRENT_FILE = quietFile;
  t.after(() => {
    globalThis.__coveBuddyStore?.close();
    delete globalThis.__coveBuddyStore;
    delete globalThis.__coveBuddyStoreVersion;
    if (previousMode === undefined) delete process.env.COVE_DAY_PLAN_ACCESS_MODE;
    else process.env.COVE_DAY_PLAN_ACCESS_MODE = previousMode;
    if (previousDb === undefined) delete process.env.COVE_DB_PATH;
    else process.env.COVE_DB_PATH = previousDb;
    if (previousQuietFile === undefined) delete process.env.COVE_QUIET_CURRENT_FILE;
    else process.env.COVE_QUIET_CURRENT_FILE = previousQuietFile;
    rmSync(path.join(process.cwd(), 'data', quietFile), { force: true });
    rmSync(path.join(process.cwd(), 'data', `${quietFile}.token`), { force: true });
    rmSync(root, { recursive: true, force: true });
  });
  return { root };
}

// Stand up a turn that declared a pending delete, i.e. one whose confirmation
// card the operator would actually have seen.
function turnWithPendingDelete(pendingDeletes) {
  const store = getBuddyStore();
  const turn = store.claimTurn({
    userText: 'delete Jane', pageContext: null, model: 'sonnet', effort: 'low',
    routerReason: 'Short action',
  });
  store.completeTurn(turn.id, { state: 'succeeded', assistant_text: 'ok', session_id: 's1', cost_usd: 0 });
  store.setTurnReceipts(turn.id, JSON.stringify({ changes: [], pendingDeletes }));
  return turn;
}

function mintRequest(body) {
  return new NextRequest('http://127.0.0.1:3200/api/buddy/confirm-delete', {
    method: 'POST',
    headers: {
      host: '127.0.0.1:3200',
      'content-type': 'application/json',
      'x-cove-csrf': getQuietCurrentCsrfToken(),
    },
    body: JSON.stringify(body),
  });
}

test('a delete token is only minted against an open confirmation card', async (t) => {
  setup(t);
  const turn = turnWithPendingDelete([{ table: 'contacts', id: 'c1', label: 'Jane Doe' }]);

  // No turn named: there is no card this could correspond to.
  const noTurn = await mint(mintRequest({ table: 'contacts', id: 'c1', label: 'Jane Doe' }));
  assert.equal(noTurn.status, 400);
  assert.match((await noTurn.json()).error, /turnId is required/);

  // A real turn, but a row it never asked to delete. This is the case that
  // matters: it is how a turn would delete something off-card.
  const wrongRow = await mint(mintRequest({
    turnId: turn.id, table: 'contacts', id: 'not-on-the-card', label: 'Someone else',
  }));
  assert.equal(wrongRow.status, 400);
  assert.match((await wrongRow.json()).error, /Pending delete was not found/);

  // A turn id that does not exist at all.
  const unknownTurn = await mint(mintRequest({
    turnId: 'no-such-turn', table: 'contacts', id: 'c1', label: 'Jane Doe',
  }));
  assert.equal(unknownTurn.status, 400);

  // The real path. Note there is deliberately no label in the body: the route
  // reads it from the stored receipt, so a caller cannot relabel what it is
  // about to delete.
  const mintedResponse = await mint(mintRequest({ turnId: turn.id, table: 'contacts', id: 'c1' }));
  const minted = await mintedResponse.json();
  assert.equal(mintedResponse.status, 200, JSON.stringify(minted));
  assert.equal(typeof minted.token, 'string');

  const consumeRequest = (id) => new NextRequest('http://127.0.0.1:3200/api/buddy/confirm-delete/consume', {
    method: 'POST',
    headers: { host: '127.0.0.1:3200', 'content-type': 'application/json' },
    body: JSON.stringify({ token: minted.token, table: 'contacts', id }),
  });
  assert.equal((await consume(consumeRequest('wrong'))).status, 409);
  assert.equal((await consume(consumeRequest('c1'))).status, 200);
  assert.equal((await consume(consumeRequest('c1'))).status, 410);
});

test('a card the operator already answered cannot mint again', async (t) => {
  setup(t);
  const turn = turnWithPendingDelete([
    { table: 'contacts', id: 'c1', label: 'Jane Doe', disposition: 'dismissed' },
  ]);
  const response = await mint(mintRequest({ turnId: turn.id, table: 'contacts', id: 'c1' }));
  assert.equal(response.status, 400, 'a cancelled card must not still be mintable');
  assert.match((await response.json()).error, /Pending delete was not found/);
});

test('a turn that declared no pending deletes cannot mint at all', async (t) => {
  setup(t);
  const turn = turnWithPendingDelete([]);
  // Sends a well-formed label on purpose, so the only thing that can reject
  // this is the missing card, not body validation.
  const response = await mint(mintRequest({
    turnId: turn.id, table: 'contacts', id: 'c1', label: 'Jane Doe',
  }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Pending delete was not found/);
});
