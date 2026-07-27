import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  countSpooledEvents,
  drainSpoolFiles,
  getEvent,
  listUnresolved,
  recordEvent,
  resolveEvent,
} from '../src/lib/intake/inbox.ts';
import {
  fallbackInboundDueAt,
  processOneInboundEvent,
} from '../src/lib/claude-execution/worker.ts';

function fixture(t) {
  const dir = path.join(
    os.tmpdir(),
    `forge-inbound-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(dir, { recursive: true });
  const previous = new Map([
    ['FORGE_DB_PATH', process.env.FORGE_DB_PATH],
    ['NEXT_PUBLIC_FORGE_RUNTIME', process.env.NEXT_PUBLIC_FORGE_RUNTIME],
    ['NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL],
    ['SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY],
    ['FORGE_TIMEZONE', process.env.FORGE_TIMEZONE],
  ]);
  process.env.FORGE_DB_PATH = path.join(dir, 'forge.db');
  process.env.NEXT_PUBLIC_FORGE_RUNTIME = 'local';
  process.env.FORGE_TIMEZONE = 'America/Los_Angeles';
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function crashWhileHoldingSpoolLock(t, spoolFile) {
  const lockKey = createHash('sha256')
    .update(path.dirname(spoolFile))
    .digest('hex')
    .slice(0, 24);
  const lockDb = path.join(
    os.tmpdir(),
    `forge-intake-spool-lock-${lockKey}.sqlite`,
  );
  const child = spawn(
    process.execPath,
    [
      '-e',
      "const Database=require('better-sqlite3');const db=new Database(process.env.FORGE_TEST_LOCK_DB);db.exec('BEGIN IMMEDIATE');process.stdout.write('locked\\n');setInterval(()=>{},1000);",
    ],
    {
      cwd: path.resolve(new URL('..', import.meta.url).pathname),
      env: { ...process.env, FORGE_TEST_LOCK_DB: lockDb },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  const [chunk] = await once(child.stdout, 'data');
  assert.equal(String(chunk), 'locked\n');
  child.kill('SIGKILL');
  await once(child, 'exit');
}

test('inbound capture is idempotent locally and preserves outage spool capture time', async (t) => {
  const dir = fixture(t);
  const createdAt = new Date(Date.now() - 31 * 60_000).toISOString();
  const first = await recordEvent({
    source: 'test',
    sourceId: 'same-event',
    rawText: 'Call Maya back.',
    machine: 'test-machine',
    createdAt,
  });
  const retry = await recordEvent({
    source: 'test',
    sourceId: 'same-event',
    rawText: 'This retry must not replace the original.',
    machine: 'test-machine',
    createdAt,
  });
  assert.equal(first.existed, false);
  assert.equal(retry.existed, true);
  assert.equal(retry.event.id, first.event.id);
  assert.equal(retry.event.raw_text, 'Call Maya back.');
  assert.deepEqual((await listUnresolved({ olderThanMinutes: 30 })).map((event) => event.id), [
    first.event.id,
  ]);

  const resolved = await resolveEvent(first.event.id, {
    state: 'triaged',
    taskId: first.event.id,
  });
  assert.equal(resolved.state, 'triaged');
  assert.equal(resolved.task_id, first.event.id);
  assert.equal(resolved.attempts, 1);
  assert.deepEqual(await listUnresolved({ olderThanMinutes: 0 }), []);

  process.env.NEXT_PUBLIC_FORGE_RUNTIME = 'supabase';
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const outage = await recordEvent({
    source: 'email',
    sourceId: 'spooled-1',
    rawText: 'Client needs the revised scope.',
    machine: 'offline-machine',
    createdAt,
  }, { dataDir: dir });
  assert.equal(outage.event.spooled, true);
  assert.equal(outage.event.created_at, createdAt);
  assert.equal(countSpooledEvents(dir), 1);

  await recordEvent({
    source: 'email',
    sourceId: 'spooled-1',
    rawText: 'Client needs the revised scope.',
    machine: 'offline-machine',
    createdAt,
  }, { dataDir: dir });
  assert.equal(countSpooledEvents(dir), 1, 'retries do not multiply a spool entry');

  const spoolFile = path.join(dir, 'intake', `spool-${os.hostname()}.jsonl`);
  await crashWhileHoldingSpoolLock(t, spoolFile);
  const afterCrash = await recordEvent({
    source: 'chat',
    sourceId: 'stale-lock',
    rawText: 'A crashed sweeper must not strand this.',
    createdAt,
  }, { dataDir: dir });
  assert.equal(afterCrash.event.spooled, true);
  assert.equal(countSpooledEvents(dir), 2);
  assert.equal(
    readdirSync(path.join(dir, 'intake')).some((name) => name.includes('-overflow-')),
    false,
    'the OS releases a crashed spool lock before the next capture',
  );
  const deterministicId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const deterministic = await recordEvent({
    id: deterministicId,
    source: 'day-plan',
    sourceId: 'assistant:item-1',
    rawText: 'Preserve the plan item identity through the spool.',
    createdAt,
  }, { dataDir: dir });
  assert.equal(deterministic.event.id, deterministicId);
  assert.equal(countSpooledEvents(dir), 3);

  process.env.NEXT_PUBLIC_FORGE_RUNTIME = 'local';
  assert.deepEqual(await drainSpoolFiles(dir), { processed: 3, remaining: 0 });
  assert.equal(countSpooledEvents(dir), 0);
  assert.equal((await getEvent(deterministicId)).id, deterministicId);

  const drained = await recordEvent({
    source: 'email',
    sourceId: 'spooled-1',
    rawText: 'ignored retry',
  });
  assert.equal(drained.existed, true);
  assert.equal(drained.event.created_at, createdAt);
  assert.notEqual(drained.event.id, outage.event.id);
});

test('a failed caller can dismiss its pending spool receipt without leaving a ghost task', async (t) => {
  const dir = fixture(t);
  process.env.NEXT_PUBLIC_FORGE_RUNTIME = 'supabase';
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const input = {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    source: 'day-plan',
    sourceId: 'assistant:failed-apply',
    rawText: 'This item was never applied.',
    createdAt: '2026-07-27T18:00:00.000Z',
  };
  const pending = await recordEvent(input, { dataDir: dir });
  assert.equal(pending.event.spooled, true);
  await recordEvent({
    ...input,
    state: 'dismissed',
  }, { dataDir: dir });
  assert.equal(countSpooledEvents(dir), 1);

  process.env.NEXT_PUBLIC_FORGE_RUNTIME = 'local';
  await drainSpoolFiles(dir);
  const event = await getEvent(input.id);
  assert.equal(event.state, 'dismissed');
  assert.equal(
    (await listUnresolved({ olderThanMinutes: 0 }))
      .some((candidate) => candidate.id === input.id),
    false,
  );
});

test('fallback processing uses deterministic tasks and backs retries off before five failures', async (t) => {
  fixture(t);
  let clock = new Date('2026-07-27T18:00:00.000Z');
  const old = new Date(clock.getTime() - 31 * 60_000).toISOString();
  const captured = await recordEvent({
    source: 'meeting',
    sourceId: 'fallback-1',
    rawText: `Review the client proposal ${'x'.repeat(100)}`,
    createdAt: old,
  });
  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.includes('/api/forge-rest/tasks?')) {
      return new Response('[]', { status: 200 });
    }
    if (value.includes('/api/forge-rest/task_columns')) {
      return new Response(JSON.stringify([
        { id: 'not-started', name: 'Not Started', position: 0 },
      ]), { status: 200 });
    }
    if (value.endsWith('/api/day-plan')) {
      return new Response(JSON.stringify({ csrfToken: 'csrf' }), { status: 200 });
    }
    if (value.endsWith('/api/forge-rest/tasks') && init.method === 'POST') {
      posts.push(JSON.parse(init.body));
      return new Response(JSON.stringify([posts.at(-1)]), { status: 201 });
    }
    throw new Error(`unexpected request: ${value}`);
  };
  assert.equal(await processOneInboundEvent(captured.event, {
    fetchImpl,
    webBaseUrl: 'http://forge.test',
    now: () => clock,
  }), true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].id, captured.event.id);
  assert.equal(posts[0].title.length, 80);
  assert.equal(posts[0].column_id, 'not-started');
  assert.equal(posts[0].priority, 'medium');
  assert.deepEqual(posts[0].tags, ['needs-triage']);
  assert.equal(posts[0].due_at, '2026-07-28T09:00:00-07:00');
  assert.match(posts[0].description, /Arrived via meeting and needs triage\.$/);
  const triaged = await getEvent(captured.event.id);
  assert.equal(triaged.state, 'triaged');
  assert.equal(triaged.task_id, captured.event.id);

  const doomed = await recordEvent({
    source: 'chat',
    sourceId: 'failure-1',
    rawText: 'This remains visible if task creation stays broken.',
    createdAt: old,
  });
  const failingFetch = async () => {
    throw new Error('board unavailable');
  };
  const failureOptions = {
    fetchImpl: failingFetch,
    webBaseUrl: 'http://forge.test',
    now: () => clock,
  };
  assert.equal(
    (await listUnresolved({ olderThanMinutes: 30, now: clock }))
      .some((event) => event.id === doomed.event.id),
    true,
  );
  assert.equal(
    await processOneInboundEvent(doomed.event, failureOptions),
    false,
    'a failed attempt is not counted as processed',
  );
  let failed = await getEvent(doomed.event.id);
  assert.equal(failed.attempts, 1);
  assert.equal(failed.updated_at, clock.toISOString());

  assert.equal(
    (await listUnresolved({
      olderThanMinutes: 30,
      now: new Date(clock.getTime() + 9 * 60_000),
    })).some((event) => event.id === doomed.event.id),
    false,
  );
  clock = new Date(clock.getTime() + 10 * 60_000);
  for (let expectedAttempts = 2; expectedAttempts <= 4; expectedAttempts += 1) {
    assert.equal(
      (await listUnresolved({ olderThanMinutes: 30, now: clock }))
        .some((event) => event.id === doomed.event.id),
      true,
    );
    assert.equal(await processOneInboundEvent(doomed.event, {
      fetchImpl: failingFetch,
      webBaseUrl: 'http://forge.test',
      now: () => clock,
    }), false);
    failed = await getEvent(doomed.event.id);
    assert.equal(failed.attempts, expectedAttempts);
    if (expectedAttempts < 4) clock = new Date(clock.getTime() + 10 * 60_000);
  }
  assert.equal(
    (await listUnresolved({
      olderThanMinutes: 30,
      now: new Date(clock.getTime() + 15 * 60_000),
    })).some((event) => event.id === doomed.event.id),
    false,
    'attempt four uses the 16-minute exponential delay',
  );
  clock = new Date(clock.getTime() + 16 * 60_000);
  assert.equal(
    (await listUnresolved({ olderThanMinutes: 30, now: clock }))
      .some((event) => event.id === doomed.event.id),
    true,
  );
  assert.equal(await processOneInboundEvent(doomed.event, {
    ...failureOptions,
    now: () => clock,
  }), false);
  failed = await getEvent(doomed.event.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.attempts, 5);
  assert.match(failed.error, /board unavailable/);
  assert.equal(
    (await listUnresolved({ olderThanMinutes: 0 })).some((event) => event.id === doomed.event.id),
    false,
    'five-attempt failures stay in the brief but leave the retry queue',
  );
});

test('attempt bumps are atomic and smart triage reuses the event id', async (t) => {
  fixture(t);
  const now = new Date('2026-07-27T18:00:00.000Z');
  const atomic = await recordEvent({
    source: 'test',
    sourceId: 'atomic-attempts',
    rawText: 'Increment this atomically.',
    createdAt: new Date(now.getTime() - 31 * 60_000).toISOString(),
  });
  await Promise.all([
    resolveEvent(
      atomic.event.id,
      { state: 'pending', error: 'first' },
      { now: () => now },
    ),
    resolveEvent(
      atomic.event.id,
      { state: 'pending', error: 'second' },
      { now: () => now },
    ),
  ]);
  assert.equal((await getEvent(atomic.event.id)).attempts, 2);
  assert.match(
    readFileSync(
      new URL('../scripts/sql/2026-07-28-forge-inbound-events.sql', import.meta.url),
      'utf8',
    ),
    /attempts = attempts \+ 1/,
  );

  const smart = await recordEvent({
    source: 'test',
    sourceId: 'smart-idempotency',
    rawText: 'Use smart triage once.',
    createdAt: new Date(now.getTime() - 31 * 60_000).toISOString(),
  });
  const taskIds = new Set();
  const previousRuntime = process.env.NEXT_PUBLIC_FORGE_RUNTIME;
  t.after(() => {
    if (previousRuntime === undefined) delete process.env.NEXT_PUBLIC_FORGE_RUNTIME;
    else process.env.NEXT_PUBLIC_FORGE_RUNTIME = previousRuntime;
  });
  t.mock.method(console, 'error', () => {});
  let triageCalls = 0;
  const triageEvent = async (event, input) => {
    triageCalls += 1;
    assert.equal(input.taskId, event.id);
    taskIds.add(input.taskId);
    if (triageCalls === 1) {
      process.env.NEXT_PUBLIC_FORGE_RUNTIME = 'supabase';
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    }
    return true;
  };
  assert.equal(await processOneInboundEvent(smart.event, {
    triageEvent,
    now: () => now,
  }), false);
  process.env.NEXT_PUBLIC_FORGE_RUNTIME = 'local';
  assert.equal(await processOneInboundEvent(smart.event, {
    triageEvent,
    now: () => now,
  }), true);
  assert.deepEqual([...taskIds], [smart.event.id]);
  const triaged = await getEvent(smart.event.id);
  assert.equal(triaged.state, 'triaged');
  assert.equal(triaged.task_id, smart.event.id);
});

test('spool drain respects host settlement, unlinks overflow, and ignores vanished files', async (t) => {
  const dir = fixture(t);
  const intakeDir = path.join(dir, 'intake');
  mkdirSync(intakeDir, { recursive: true });
  const now = new Date('2026-07-27T18:00:00.000Z');
  const record = (sourceId) => `${JSON.stringify({
    source: 'spool-test',
    sourceId,
    rawText: sourceId,
    machine: 'test',
    createdAt: new Date(now.getTime() - 31 * 60_000).toISOString(),
  })}\n`;
  const current = path.join(intakeDir, `spool-${os.hostname()}.jsonl`);
  const currentOverflow = path.join(
    intakeDir,
    `spool-${os.hostname()}-overflow-test.jsonl`,
  );
  const freshForeign = path.join(intakeDir, 'spool-other-fresh.jsonl');
  const staleForeign = path.join(intakeDir, 'spool-other-stale.jsonl');
  writeFileSync(current, record('current'));
  writeFileSync(currentOverflow, record('overflow'));
  writeFileSync(freshForeign, record('foreign-fresh'));
  writeFileSync(staleForeign, record('foreign-stale'));
  const stale = new Date(now.getTime() - 16 * 60_000);
  utimesSync(staleForeign, stale, stale);
  symlinkSync(
    path.join(intakeDir, 'missing-target'),
    path.join(intakeDir, `spool-${os.hostname()}-vanished.jsonl`),
  );

  assert.deepEqual(
    await drainSpoolFiles(dir, { now }),
    { processed: 3, remaining: 0 },
  );
  assert.equal(existsSync(currentOverflow), false);
  assert.match(readFileSync(freshForeign, 'utf8'), /foreign-fresh/);
  assert.equal(
    (await recordEvent({
      source: 'spool-test',
      sourceId: 'foreign-stale',
      rawText: 'retry',
    })).existed,
    true,
  );
});

test('fallback due dates are tomorrow at 09:00 in the operator timezone', () => {
  assert.equal(
    fallbackInboundDueAt(
      new Date('2026-11-01T19:00:00.000Z'),
      'America/Los_Angeles',
    ),
    '2026-11-02T09:00:00-08:00',
  );
  assert.equal(
    fallbackInboundDueAt(new Date('2026-07-27T19:00:00.000Z'), 'UTC'),
    '2026-07-28T09:00:00+00:00',
  );
});
