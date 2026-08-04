import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { GET, POST } from '../src/app/api/crm/route.ts';
import { GET as GET_ATTIO } from '../src/app/api/crm/attio/route.ts';

function withEnv(t, values) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('CRM reads and writes require the configured remote session credential', {
  concurrency: false,
}, async (t) => {
  const dir = path.join(
    os.tmpdir(),
    `cove-crm-route-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  withEnv(t, {
    COVE_DATA_DIR: dir,
    COVE_DB_PATH: path.join(dir, 'cove.db'),
    NEXT_PUBLIC_COVE_RUNTIME: 'local',
    COVE_DAY_PLAN_ACCESS_MODE: 'session',
    COVE_DAY_PLAN_REMOTE_TOKEN: 'session-secret',
  });

  const deniedRead = await GET(new NextRequest(
    'http://127.0.0.1:3200/api/crm?operation=list',
  ));
  assert.equal(deniedRead.status, 403);

  const allowedRead = await GET(new NextRequest(
    'http://127.0.0.1:3200/api/crm?operation=list',
    { headers: { 'X-Cove-Day-Plan-Session': 'session-secret' } },
  ));
  assert.equal(allowedRead.status, 200);
  const payload = await allowedRead.json();
  assert.deepEqual(payload.contacts, []);
  assert.equal(typeof payload.csrfToken, 'string');

  const deniedWrite = await POST(new NextRequest(
    'http://127.0.0.1:3200/api/crm',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cove-CSRF': payload.csrfToken,
      },
      body: JSON.stringify({
        action: 'resolve',
        input: { name: 'Denied Person', source: 'manual' },
      }),
    },
  ));
  assert.equal(deniedWrite.status, 403);
});

test('explicit_create writes a second same-name contact with all manual facts', {
  concurrency: false,
}, async (t) => {
  const dir = path.join(
    os.tmpdir(),
    `cove-crm-explicit-route-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  withEnv(t, {
    COVE_DATA_DIR: dir,
    COVE_DB_PATH: path.join(dir, 'cove.db'),
    NEXT_PUBLIC_COVE_RUNTIME: 'local',
    COVE_DAY_PLAN_ACCESS_MODE: undefined,
  });

  const read = await GET(new NextRequest(
    'http://127.0.0.1:3200/api/crm?operation=list',
  ));
  const { csrfToken } = await read.json();
  const post = (action, input) => POST(new NextRequest(
    'http://127.0.0.1:3200/api/crm',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cove-CSRF': csrfToken,
      },
      body: JSON.stringify({ action, input }),
    },
  ));

  const first = await post('resolve', {
    name: 'John Smith',
    email: 'john@example.com',
    source: 'manual',
  });
  assert.equal(first.status, 200);
  const firstPayload = await first.json();

  const second = await post('explicit_create', {
    name: 'John Smith',
    email: 'other@example.com',
    phone: '310-555-0199',
    role: 'Buyer',
    source: 'manual',
  });
  assert.equal(second.status, 200);
  const { creation } = await second.json();
  assert.notEqual(creation.contact.id, firstPayload.resolution.contact.id);
  assert.equal(creation.contact.email, 'other@example.com');
  assert.equal(creation.contact.phone, '310-555-0199');
  assert.equal(creation.contact.role, 'Buyer');
  assert.deepEqual(
    creation.candidates.map((candidate) => candidate.id),
    [firstPayload.resolution.contact.id],
  );
});

test('the merge action folds a duplicate contact through the API', {
  concurrency: false,
}, async (t) => {
  const dir = path.join(
    os.tmpdir(),
    `cove-crm-merge-route-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  withEnv(t, {
    COVE_DATA_DIR: dir,
    COVE_DB_PATH: path.join(dir, 'cove.db'),
    NEXT_PUBLIC_COVE_RUNTIME: 'local',
    COVE_DAY_PLAN_ACCESS_MODE: undefined,
  });

  const read = await GET(new NextRequest(
    'http://127.0.0.1:3200/api/crm?operation=list',
  ));
  const { csrfToken } = await read.json();
  const post = (action, input) => POST(new NextRequest(
    'http://127.0.0.1:3200/api/crm',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Cove-CSRF': csrfToken,
      },
      body: JSON.stringify({ action, input }),
    },
  ));

  const winner = await (await post('resolve', {
    name: 'Sarah Chen',
    email: 'sarah@work.com',
    source: 'manual',
  })).json();
  const loser = await (await post('explicit_create', {
    name: 'Sarah Chen',
    email: 'sarah@personal.com',
    source: 'manual',
  })).json();

  const missingIds = await post('merge', {});
  assert.equal(missingIds.status, 400);
  assert.match((await missingIds.json()).error, /winnerId and loserId/);

  const merged = await post('merge', {
    winnerId: winner.resolution.contact.id,
    loserId: loser.creation.contact.id,
  });
  assert.equal(merged.status, 200);
  const payload = await merged.json();
  assert.equal(payload.contact.id, winner.resolution.contact.id);
  assert.equal(payload.contact.email, 'sarah@work.com');

  const list = await (await GET(new NextRequest(
    'http://127.0.0.1:3200/api/crm?operation=list',
  ))).json();
  assert.deepEqual(
    list.contacts.map((contact) => contact.id),
    [winner.resolution.contact.id],
  );
});

test('the local CRM route refuses to split a supabase runtime into SQLite', {
  concurrency: false,
}, async (t) => {
  withEnv(t, {
    NEXT_PUBLIC_COVE_RUNTIME: 'supabase',
    COVE_DAY_PLAN_ACCESS_MODE: undefined,
  });
  const response = await GET(new NextRequest(
    'http://127.0.0.1:3200/api/crm?operation=list',
  ));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /only in local runtime mode/);
});

test('the legacy Attio route remains active outside local runtime mode', {
  concurrency: false,
}, async (t) => {
  const previousFetch = globalThis.fetch;
  withEnv(t, {
    NEXT_PUBLIC_COVE_RUNTIME: 'supabase',
    ATTIO_API_KEY: 'attio-key',
  });
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response('{"data":[]}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const response = await GET_ATTIO(new NextRequest(
    'http://127.0.0.1:3200/api/crm/attio',
  ));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.source, 'attio');
  assert.deepEqual(payload.records, []);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /api\.attio\.com\/v2\/objects\/people/);
  assert.match(calls[1], /api\.attio\.com\/v2\/objects\/companies/);
});
