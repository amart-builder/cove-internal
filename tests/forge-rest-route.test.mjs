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
  targetsSpecificRows,
  DELETE,
} from '../src/app/api/forge-rest/[table]/route.ts';
import { getQuietCurrentCsrfToken } from '../src/lib/quiet-current/store.ts';
import { handleLocalRest } from '../src/lib/local/db.ts';

const context = { params: Promise.resolve({ table: 'not_a_forge_table' }) };

test('forge-rest keeps GET host-only while mutations require route access and CSRF', async (t) => {
  const previousAccessMode = process.env.COVE_DAY_PLAN_ACCESS_MODE;
  delete process.env.COVE_DAY_PLAN_ACCESS_MODE;
  t.after(() => {
    if (previousAccessMode === undefined) delete process.env.COVE_DAY_PLAN_ACCESS_MODE;
    else process.env.COVE_DAY_PLAN_ACCESS_MODE = previousAccessMode;
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
  const previousDbPath = process.env.COVE_DB_PATH;
  process.env.COVE_DB_PATH = path.join(dir, 'forge.db');
  t.after(() => {
    if (previousDbPath === undefined) delete process.env.COVE_DB_PATH;
    else process.env.COVE_DB_PATH = previousDbPath;
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

test('a filterless PATCH or DELETE is not treated as targeting rows', () => {
  // PostgREST reads these as whole-table operations, so they must never reach it.
  assert.equal(targetsSpecificRows(new URLSearchParams('')), false);
  assert.equal(targetsSpecificRows(new URLSearchParams('select=*')), false);
  assert.equal(targetsSpecificRows(new URLSearchParams('select=id&order=created_at&limit=50')), false);

  // Anything that is not a response-shaping parameter selects rows.
  assert.equal(targetsSpecificRows(new URLSearchParams('id=eq.abc')), true);
  assert.equal(targetsSpecificRows(new URLSearchParams('select=*&id=eq.abc')), true);
  assert.equal(targetsSpecificRows(new URLSearchParams('status=eq.open')), true);
});

test('a legacy tasks table upgrades in place instead of failing per query', async () => {
  const dir = path.join(os.tmpdir(), `forge-legacy-db-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'forge.db');
  const previousPath = process.env.COVE_DB_PATH;
  const globalKey = globalThis;
  const previousDb = globalKey.__forgeDb;

  const { default: Database } = await import('better-sqlite3');
  const seed = new Database(file);
  // The pre-Convex shape: no status, no due_at, no source_type.
  seed.exec(
    'CREATE TABLE tasks (id TEXT PRIMARY KEY, column_id TEXT, title TEXT NOT NULL, due_date TEXT)',
  );
  seed.prepare(
    'INSERT INTO tasks (id, title, due_date) VALUES (?, ?, ?)',
  ).run('legacy-task', 'Preserve this task', '2026-07-31');
  seed.close();

  process.env.COVE_DB_PATH = file;
  delete globalKey.__forgeDb;
  try {
    const result = handleLocalRest(
      'tasks',
      'GET',
      new URLSearchParams('id=eq.legacy-task'),
      undefined,
    );
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, [{
      id: 'legacy-task',
      column_id: null,
      title: 'Preserve this task',
      description: '',
      priority: 'medium',
      due_at: '2026-07-31',
      due_date: '2026-07-31',
      tags: [],
      project: 'Atlas',
      position: 0,
      status: 'open',
      source_type: 'manual',
      remind_native: true,
      remind_text: false,
      notified_at: null,
      created_at: null,
      updated_at: null,
    }]);
  } finally {
    delete globalKey.__forgeDb;
    if (previousDb !== undefined) globalKey.__forgeDb = previousDb;
    if (previousPath === undefined) delete process.env.COVE_DB_PATH;
    else process.env.COVE_DB_PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local task migration adds project with the Atlas default and index', async () => {
  const dir = path.join(os.tmpdir(), `forge-task-project-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'forge.db');
  const previousPath = process.env.COVE_DB_PATH;
  const previousDb = globalThis.__forgeDb;
  const { default: Database } = await import('better-sqlite3');
  const seed = new Database(file);
  seed.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      column_id TEXT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      priority TEXT DEFAULT 'medium',
      due_at TEXT,
      tags TEXT DEFAULT '[]',
      position INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open',
      source_type TEXT DEFAULT 'manual'
    )
  `);
  seed.close();
  process.env.COVE_DB_PATH = file;
  delete globalThis.__forgeDb;
  try {
    const inserted = handleLocalRest(
      'tasks',
      'POST',
      new URLSearchParams(),
      JSON.stringify({ id: 'project-default', title: 'General task' }),
    );
    assert.equal(inserted.status, 201);
    assert.equal(inserted.body[0].project, 'Atlas');
    globalThis.__forgeDb.close();
    delete globalThis.__forgeDb;
    const inspect = new Database(file, { readonly: true });
    const columns = inspect.prepare('PRAGMA table_info(tasks)').all();
    assert.equal(columns.find((column) => column.name === 'project').dflt_value, "'Atlas'");
    const indexes = inspect.prepare('PRAGMA index_list(tasks)').all();
    assert.equal(
      indexes.some((index) => index.name === 'tasks_project_status_idx'),
      true,
    );
    inspect.close();
  } finally {
    globalThis.__forgeDb?.close();
    delete globalThis.__forgeDb;
    if (previousDb !== undefined) globalThis.__forgeDb = previousDb;
    if (previousPath === undefined) delete process.env.COVE_DB_PATH;
    else process.env.COVE_DB_PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the route rejects a filterless DELETE after CSRF passes, and still allows a targeted one', async (t) => {
  // The CSRF gate runs first, so an unauthenticated probe never reaches this
  // guard. Authenticate properly to prove the guard itself is load-bearing.
  const dir = path.join(os.tmpdir(), `forge-rest-nofilter-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const previousDbPath = process.env.COVE_DB_PATH;
  const previousAccessMode = process.env.COVE_DAY_PLAN_ACCESS_MODE;
  process.env.COVE_DB_PATH = path.join(dir, 'forge.db');
  delete process.env.COVE_DAY_PLAN_ACCESS_MODE;
  t.after(() => {
    if (previousDbPath === undefined) delete process.env.COVE_DB_PATH;
    else process.env.COVE_DB_PATH = previousDbPath;
    if (previousAccessMode === undefined) delete process.env.COVE_DAY_PLAN_ACCESS_MODE;
    else process.env.COVE_DAY_PLAN_ACCESS_MODE = previousAccessMode;
    rmSync(dir, { recursive: true, force: true });
  });

  const headers = {
    host: 'localhost:3200',
    origin: 'http://localhost:3200',
    'x-forge-csrf': getQuietCurrentCsrfToken(),
  };
  const tasksContext = { params: Promise.resolve({ table: 'tasks' }) };

  const filterless = await DELETE(
    new NextRequest('http://localhost:3200/api/forge-rest/tasks', { method: 'DELETE', headers }),
    tasksContext,
  );
  assert.equal(filterless.status, 400, 'a filterless DELETE would empty the table');
  assert.match(await filterless.text(), /no filter/);

  // Response-shaping parameters alone are still not a filter.
  const shapedOnly = await DELETE(
    new NextRequest('http://localhost:3200/api/forge-rest/tasks?select=id&limit=10', {
      method: 'DELETE',
      headers,
    }),
    { params: Promise.resolve({ table: 'tasks' }) },
  );
  assert.equal(shapedOnly.status, 400);

  // A targeted delete must still go through.
  const targeted = await DELETE(
    new NextRequest('http://localhost:3200/api/forge-rest/tasks?id=eq.does-not-exist', {
      method: 'DELETE',
      headers,
    }),
    { params: Promise.resolve({ table: 'tasks' }) },
  );
  assert.notEqual(targeted.status, 400, 'a filtered delete must not be blocked');
});
