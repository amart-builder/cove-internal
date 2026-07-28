import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  COVE_BUDDY_REPO_DIR,
  main,
  parseBuddyDataArgs,
  runBuddyDataCommand,
} from '../scripts/cove-buddy-data.ts';

test('buddy data CLI parses repeated PostgREST filters and mutation arguments', () => {
  assert.deepEqual(parseBuddyDataArgs([
    'query', 'tasks', '--filter', 'status.eq.open', '--filter', 'title.ilike.*gym*',
    '--limit', '20', '--order', 'position.asc',
  ]), {
    action: 'query', table: 'tasks', filters: ['status.eq.open', 'title.ilike.*gym*'],
    limit: 20, order: 'position.asc',
  });
  assert.equal(parseBuddyDataArgs(['update', 'tasks', '--id', 't1', '--json', '{"title":"Gym"}']).id, 't1');
  assert.throws(() => parseBuddyDataArgs(['query', 'secrets']), /not allowed/);
});

test('buddy data CLI parses day-plan get and apply commands', () => {
  assert.deepEqual(parseBuddyDataArgs(['day-plan', 'get']), { action: 'day-plan-get' });
  assert.deepEqual(parseBuddyDataArgs([
    'day-plan', 'apply', '--json', '{"expectedVersion":3,"operations":[{"operation":"complete_item","itemId":"i1"}]}',
  ]), {
    action: 'day-plan-apply',
    json: { expectedVersion: 3, operations: [{ operation: 'complete_item', itemId: 'i1' }] },
  });
});

test('buddy data CLI routes new tasks through intake and refuses raw task inserts', async () => {
  assert.deepEqual(parseBuddyDataArgs([
    'intake', '--text', 'Call Maya back', '--source-id', 'turn-7',
  ]), {
    action: 'intake',
    input: {
      text: 'Call Maya back',
      source: 'buddy',
      sourceId: 'turn-7',
      dryRun: false,
    },
  });
  assert.throws(
    () => parseBuddyDataArgs(['insert', 'tasks', '--json', '{"title":"Bypass"}']),
    /must use the intake subcommand/,
  );
  const lines = [];
  const code = await runBuddyDataCommand(
    parseBuddyDataArgs(['intake', '--text', 'Call Maya back']),
    {
      runIntake: async (input, options) => {
        assert.equal(input.source, 'buddy');
        assert.equal(options.webBaseUrl, 'http://127.0.0.1:3200');
        assert.equal(options.repoDir, COVE_BUDDY_REPO_DIR);
        return {
          exitCode: 0,
          event: { source: 'buddy', source_id: 'derived' },
          taskId: 'task-7',
          existed: false,
          spooled: false,
          fallback: false,
        };
      },
      write: (line) => lines.push(line),
    },
  );
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(lines[0].slice('RECEIPT '.length)), {
    table: 'tasks',
    action: 'insert',
    id: 'task-7',
    summary: 'Captured task (task-7)',
  });
});

test('buddy dry-run resolves the repo from its script and prints a receipt from a foreign cwd', {
  concurrency: false,
}, async (t) => {
  const foreign = path.join(
    os.tmpdir(),
    `forge-buddy-foreign-${process.pid}-${Date.now()}`,
  );
  mkdirSync(foreign, { recursive: true });
  const previousCwd = process.cwd();
  process.chdir(foreign);
  t.after(() => {
    process.chdir(previousCwd);
    rmSync(foreign, { recursive: true, force: true });
  });
  const lines = [];
  const code = await runBuddyDataCommand(
    parseBuddyDataArgs([
      'intake',
      '--text',
      '--review this flag-shaped task',
      '--dry-run',
    ]),
    {
      runIntake: async (input, options) => {
        assert.equal(input.text, '--review this flag-shaped task');
        assert.equal(options.repoDir, COVE_BUDDY_REPO_DIR);
        assert.notEqual(options.repoDir, process.cwd());
        return {
          exitCode: 0,
          event: {
            id: 'dry-event-1',
            source: 'buddy',
            source_id: 'dry-run:auto',
          },
          existed: false,
          spooled: false,
          fallback: false,
        };
      },
      write: (line) => lines.push(line),
    },
  );
  assert.equal(code, 0);
  assert.deepEqual(lines, ['DRY_RUN {"event_id":"dry-event-1"}']);
});

test('buddy data CLI parses and submits a spawned-session request', async () => {
  const command = parseBuddyDataArgs([
    'spawn-session', '--dir', '/Users/operator/Atlas/demo', '--prompt', 'Plan this', '--title', 'Demo',
  ]);
  assert.deepEqual(command, {
    action: 'spawn-session', dir: '/Users/operator/Atlas/demo', prompt: 'Plan this', title: 'Demo',
  });
  const calls = [];
  const lines = [];
  await runBuddyDataCommand(command, {
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return calls.length === 1
        ? new Response('{"csrfToken":"token"}')
        : new Response('{"sessionId":"session-1","state":"seeding"}');
    },
    write: (line) => lines.push(line),
  });
  assert.match(calls[1].url, /\/api\/buddy\/spawn-session$/);
  assert.equal(calls[1].init.headers['X-Forge-CSRF'], 'token');
  assert.deepEqual(JSON.parse(lines[0].slice('SESSION '.length)), {
    sessionId: 'session-1', dir: '/Users/operator/Atlas/demo', title: 'Demo',
  });

  assert.deepEqual(parseBuddyDataArgs([
    'spawn-session', '--project', 'Beacon Engine', '--prompt', 'Plan this', '--title', 'Demo',
  ]), {
    action: 'spawn-session', project: 'Beacon Engine', prompt: 'Plan this', title: 'Demo',
  });
  assert.throws(
    () => parseBuddyDataArgs(['spawn-session', '--prompt', 'Plan this']),
    /exactly one of --dir or --project/,
  );
  assert.throws(
    () => parseBuddyDataArgs([
      'spawn-session', '--dir', '/tmp/example', '--project', 'Example', '--prompt', 'Plan this',
    ]),
    /exactly one of --dir or --project/,
  );
});

test('buddy data CLI submits --project and reports the resolved directory', async () => {
  const command = parseBuddyDataArgs([
    'spawn-session', '--project', 'Beacon', '--prompt', 'Plan this', '--title', 'Launch plan',
  ]);
  const calls = [];
  const lines = [];
  await runBuddyDataCommand(command, {
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return calls.length === 1
        ? new Response('{"csrfToken":"token"}')
        : new Response('{"sessionId":"session-project","state":"seeding","dir":"/Users/operator/Atlas/Projects/demo-engine"}');
    },
    write: (line) => lines.push(line),
  });
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    project: 'Beacon', prompt: 'Plan this', title: 'Launch plan',
  });
  assert.deepEqual(JSON.parse(lines[0].slice('SESSION '.length)), {
    sessionId: 'session-project',
    dir: '/Users/operator/Atlas/Projects/demo-engine',
    title: 'Launch plan',
  });
});

test('buddy data CLI surfaces a rejected spawned-session request as ERROR', async () => {
  const errors = [];
  let calls = 0;
  const code = await main([
    'spawn-session', '--dir', '/tmp', '--prompt', 'Plan this',
  ], {
    fetch: async () => ++calls === 1
      ? new Response('{"csrfToken":"token"}')
      : new Response('{"error":"Project directory must be inside ~/Atlas."}', { status: 400 }),
    writeError: (line) => errors.push(line),
  });
  assert.equal(code, 1);
  assert.match(errors[0], /^ERROR /);
  assert.match(errors[0], /inside ~\/Atlas/);
});

test('day-plan get prints the compact current plan', async () => {
  const lines = [];
  await runBuddyDataCommand(parseBuddyDataArgs(['day-plan', 'get']), {
    fetch: async () => new Response(JSON.stringify({ currentPlan: {
      id: 'p1', version: 4, items: [{ id: 'i1', title: 'Gym', owner: 'me', position: 0, decision: 'accepted' }],
    } }), { status: 200 }),
    write: (line) => lines.push(line),
  });
  const output = JSON.parse(lines[0]);
  assert.equal(output.id, 'p1');
  assert.equal(output.version, 4);
  assert.deepEqual(output.steps, ['brief', 'priorities', 'extras']);
  assert.equal(output.items[0].id, 'i1');
});

test('day-plan apply sends CSRF and prints one receipt per operation', async () => {
  const calls = [];
  const lines = [];
  const fetchMock = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return new Response('{"csrfToken":"token","currentPlan":{"id":"p1"}}');
    return new Response(JSON.stringify({ changes: [
      { table: 'day_plan', action: 'update', id: 'i1', summary: "Assigned 'Gym' to Claude" },
    ] }), { status: 200 });
  };
  await runBuddyDataCommand(parseBuddyDataArgs([
    'day-plan', 'apply', '--json', '{"expectedVersion":4,"operations":[{"operation":"set_owner","itemId":"i1","owner":"claude"}]}',
  ]), { fetch: fetchMock, write: (line) => lines.push(line) });
  assert.match(calls[1].url, /\/api\/day-plan\/assistant-apply$/);
  assert.equal(calls[1].init.headers['X-Forge-CSRF'], 'token');
  assert.match(lines[0], /^RECEIPT {"table":"day_plan","action":"update"/);
});

test('day-plan apply exposes a 409 snapshot in its machine-readable error', async () => {
  const errors = [];
  let calls = 0;
  const code = await main([
    'day-plan', 'apply', '--json', '{"expectedVersion":3,"operations":[{"operation":"complete_item","itemId":"i1"}]}',
  ], {
    fetch: async () => ++calls === 1
      ? new Response('{"csrfToken":"token","currentPlan":{"id":"p1"}}')
      : new Response('{"error":"version_conflict","currentPlan":{"id":"p1","version":4}}', { status: 409 }),
    writeError: (line) => errors.push(line),
  });
  assert.equal(code, 1);
  assert.match(errors[0], /HTTP 409/);
  assert.match(errors[0], /currentPlan/);
  assert.match(errors[0], /version\\?"?:4/);
});

test('buddy data CLI refuses delete without a confirmation token before fetch', async () => {
  let fetched = false;
  await assert.rejects(
    runBuddyDataCommand(parseBuddyDataArgs(['delete', 'contacts', '--id', 'c1']), {
      fetch: async () => { fetched = true; return new Response(); },
    }),
    /pendingDeletes/,
  );
  assert.equal(fetched, false);
  const errors = [];
  const code = await main(['delete', 'contacts', '--id', 'c1'], {
    fetch: async () => { fetched = true; return new Response(); },
    writeError: (line) => errors.push(line),
  });
  assert.equal(code, 1);
  assert.match(errors[0], /^ERROR {"message":"Permanent delete requires/);
});

test('buddy data CLI emits one machine-readable receipt after a mocked mutation', async () => {
  const lines = [];
  const calls = [];
  const fetchMock = async (url, init) => {
    calls.push({ url: String(url), init });
    return calls.length === 1
      ? new Response('{"csrfToken":"token"}', { status: 200 })
      : new Response(JSON.stringify([{ id: 't1', title: 'Gym' }]), { status: 200 });
  };
  const code = await runBuddyDataCommand(
    parseBuddyDataArgs(['update', 'tasks', '--id', 't1', '--json', '{"position":5}']),
    { fetch: fetchMock, appUrl: 'http://127.0.0.1:3200', write: (line) => lines.push(line) },
  );
  assert.equal(code, 0);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/api\/day-plan$/);
  assert.match(calls[1].url, /\/api\/forge-rest\/tasks\?id=eq\.t1$/);
  assert.equal(calls[1].init.headers['X-Forge-CSRF'], 'token');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0].slice('RECEIPT '.length)), {
    table: 'tasks', action: 'update', id: 't1', summary: "Updated 'Gym'",
  });
});

test('confirmed delete consumes the exact token before deleting', async () => {
  const calls = [];
  const fetchMock = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return new Response('{"csrfToken":"token"}', { status: 200 });
    if (calls.length === 2) return new Response('[{"id":"c1","name":"Jane"}]', { status: 200 });
    if (calls.length === 3) return new Response('{"consumed":true}', { status: 200 });
    if (calls.length === 4) return new Response(null, { status: 204 });
    return new Response('[]', { status: 200 });
  };
  const lines = [];
  await runBuddyDataCommand(
    parseBuddyDataArgs(['delete', 'contacts', '--id', 'c1', '--confirm-token', 'token-1']),
    { fetch: fetchMock, appUrl: 'http://127.0.0.1:3200', write: (line) => lines.push(line) },
  );
  assert.match(calls[0].url, /\/api\/day-plan$/);
  assert.match(calls[1].url, /forge-rest\/contacts\?id=eq\.c1&limit=1$/);
  assert.match(calls[2].url, /confirm-delete\/consume$/);
  assert.match(calls[3].url, /forge-rest\/contacts\?id=eq\.c1$/);
  assert.equal(calls[3].init.headers['X-Forge-CSRF'], 'token');
  assert.match(calls[4].url, /forge-rest\/contacts\?id=eq\.c1&limit=1$/);
  assert.match(lines[0], /^RECEIPT /);
});

test('confirmed delete keeps its receipt when post-delete verification throws', async () => {
  const lines = [];
  let call = 0;
  const code = await runBuddyDataCommand(
    parseBuddyDataArgs(['delete', 'contacts', '--id', 'c1', '--confirm-token', 'token-1']),
    {
      fetch: async () => {
        call += 1;
        if (call === 1) return new Response('{"csrfToken":"token"}', { status: 200 });
        if (call === 2) return new Response('[{"id":"c1","name":"Jane"}]', { status: 200 });
        if (call === 3) return new Response('{"consumed":true}', { status: 200 });
        if (call === 4) return new Response(null, { status: 204 });
        assert.match(lines[0], /^RECEIPT /, 'receipt must be emitted before verification starts');
        throw new Error('verification unavailable');
      },
      write: (line) => lines.push(line),
    },
  );
  assert.equal(code, 0);
  assert.match(lines[0], /^RECEIPT /);
  assert.equal(lines[1], 'WARN: post-delete verification read failed');
});

test('buddy data CLI does not claim a zero-row update succeeded', async () => {
  let call = 0;
  await assert.rejects(runBuddyDataCommand(
    parseBuddyDataArgs(['update', 'tasks', '--id', 'missing', '--json', '{"title":"Nope"}']),
    { fetch: async () => ++call === 1
      ? new Response('{"csrfToken":"token"}', { status: 200 })
      : new Response('[]', { status: 200 }) },
  ), /did not change a row/);
});
