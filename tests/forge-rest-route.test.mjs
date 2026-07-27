import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { NextRequest } from 'next/server';
import {
  forgeRestMutationAccessFailure,
  GET,
  POST,
} from '../src/app/api/forge-rest/[table]/route.ts';
import { handleLocalRest } from '../src/lib/local/db.ts';

const context = { params: Promise.resolve({ table: 'not_a_forge_table' }) };

test('forge-rest keeps GET host-only while mutations require route access and CSRF', async (t) => {
  const previousAccessMode = process.env.FORGE_DAY_PLAN_ACCESS_MODE;
  delete process.env.FORGE_DAY_PLAN_ACCESS_MODE;
  t.after(() => {
    if (previousAccessMode === undefined) delete process.env.FORGE_DAY_PLAN_ACCESS_MODE;
    else process.env.FORGE_DAY_PLAN_ACCESS_MODE = previousAccessMode;
  });

  const untrustedGet = await GET(new NextRequest('http://evil.example/api/forge-rest/tasks', {
    headers: { host: 'evil.example', origin: 'http://evil.example' },
  }), context);
  assert.equal(untrustedGet.status, 403);

  const trustedGet = await GET(new NextRequest('http://localhost:3200/api/forge-rest/not_a_forge_table', {
    headers: { host: 'localhost:3200', origin: 'http://localhost:3200' },
  }), context);
  assert.equal(trustedGet.status, 404);

  const missingToken = await POST(new NextRequest('http://localhost:3200/api/forge-rest/not_a_forge_table', {
    method: 'POST',
    headers: { host: 'localhost:3200', origin: 'http://localhost:3200', 'content-type': 'application/json' },
    body: '{}',
  }), context);
  assert.equal(missingToken.status, 403);

  const allowedMutation = new NextRequest('http://localhost:3200/api/forge-rest/not_a_forge_table', {
    method: 'POST',
    headers: {
      host: 'localhost:3200',
      origin: 'http://localhost:3200',
      'content-type': 'application/json',
      'x-forge-csrf': 'test-token',
    },
    body: '{}',
  });
  assert.equal(forgeRestMutationAccessFailure(allowedMutation, 'test-token'), undefined);
});

test('local PATCH returns the rows it updated even when the filter tests an overwritten column', async (t) => {
  const dir = path.join(os.tmpdir(), `forge-rest-cas-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const previousDbPath = process.env.FORGE_DB_PATH;
  process.env.FORGE_DB_PATH = path.join(dir, 'forge.db');
  t.after(() => {
    if (previousDbPath === undefined) delete process.env.FORGE_DB_PATH;
    else process.env.FORGE_DB_PATH = previousDbPath;
    rmSync(dir, { recursive: true, force: true });
  });

  const inserted = handleLocalRest(
    'commitments',
    'POST',
    new URLSearchParams(),
    JSON.stringify({
      id: 'cas-1',
      kind: 'promise',
      title: 'Send the checklist',
      status: 'open',
      confidence: 'high',
      confirmed: false,
      source_kind: 'brain_dump',
      evidence: null,
    }),
  );
  assert.equal(inserted.status, 201);

  // Compare-and-swap: guard on the current evidence (null) while overwriting it.
  const casParams = new URLSearchParams();
  casParams.set('id', 'eq.cas-1');
  casParams.set('status', 'eq.open');
  casParams.set('evidence', 'is.null');
  const patched = handleLocalRest(
    'commitments',
    'PATCH',
    casParams,
    JSON.stringify({ evidence: JSON.stringify({ resolved_by: 'day_dump' }), status: 'done' }),
  );
  assert.equal(patched.status, 200);
  assert.equal(Array.isArray(patched.body), true);
  assert.equal(patched.body.length, 1, 'the updated row must come back so a CAS caller sees its win');
  assert.equal(patched.body[0].id, 'cas-1');
  assert.equal(patched.body[0].status, 'done');

  // A stale guard (evidence already set) matches nothing and returns an empty body.
  const stale = handleLocalRest(
    'commitments',
    'PATCH',
    casParams,
    JSON.stringify({ evidence: JSON.stringify({ resolved_by: 'day_dump', again: true }) }),
  );
  assert.equal(stale.status, 200);
  assert.equal(Array.isArray(stale.body), true);
  assert.equal(stale.body.length, 0, 'a lost CAS returns no rows so the caller can detect it');
});
