import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { runCoveIntake } from '../src/lib/intake/run.ts';

function fixture(t) {
  const dir = path.join(
    os.tmpdir(),
    `cove-triage-retry-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(path.join(dir, 'brief'), { recursive: true });
  writeFileSync(path.join(dir, 'brief', 'goals.md'), '# Goals\nGrow the business.');
  const prior = {
    db: process.env.COVE_DB_PATH,
    runtime: process.env.NEXT_PUBLIC_COVE_RUNTIME,
    timezone: process.env.COVE_TIMEZONE,
  };
  const priorDb = globalThis.__coveDb;
  delete globalThis.__coveDb;
  process.env.COVE_DB_PATH = path.join(dir, 'cove.db');
  process.env.NEXT_PUBLIC_COVE_RUNTIME = 'local';
  process.env.COVE_TIMEZONE = 'America/Los_Angeles';
  t.after(() => {
    globalThis.__coveDb?.close();
    if (priorDb === undefined) delete globalThis.__coveDb;
    else globalThis.__coveDb = priorDb;
    for (const [key, value] of [
      ['COVE_DB_PATH', prior.db],
      ['NEXT_PUBLIC_COVE_RUNTIME', prior.runtime],
      ['COVE_TIMEZONE', prior.timezone],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

/** Answers with a different payload per call so a retry can be observed. */
function sequencedSpawn(payloads, prompts) {
  let call = 0;
  return (executable, args) => {
    const payload = payloads[Math.min(call, payloads.length - 1)];
    call += 1;
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    const written = [];
    child.stdin.on('data', (chunk) => written.push(chunk));
    child.stdin.once('finish', () => {
      prompts.push(Buffer.concat(written).toString('utf8') || args.join(' '));
      queueMicrotask(() => {
        const output = JSON.stringify(payload);
        const outputIndex = args.indexOf('--output-last-message');
        if (outputIndex >= 0) writeFileSync(args[outputIndex + 1], output);
        else child.stdout.write(output);
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0);
      });
    });
    return child;
  };
}

function triage(overrides = {}) {
  return {
    title: 'Send Maya the revised scope',
    description: 'Close the active client loop so delivery can move forward.',
    project: 'Atlas',
    priority: 'high',
    due_at: '2026-07-27T17:00:00-07:00',
    autonomy: 'groundwork',
    groundwork_notes: 'Draft the scope changes.',
    surface: 'board',
    surface_at: null,
    urgency_reason: 'The client is blocked today.',
    offer: 'Want me to draft the revised scope?',
    ...overrides,
  };
}

function coveFetch(posts) {
  return async (url, init = {}) => {
    const value = String(url);
    if (value.includes('/api/cove-rest/task_columns')) {
      return new Response(JSON.stringify([
        { id: 'not-started', name: 'Not Started', position: 0 },
        { id: 'today', name: 'Must happen today', position: 10 },
      ]));
    }
    if (value.includes('/api/cove-rest/tasks?')) return new Response('[]');
    if (value.endsWith('/api/day-plan')) return new Response('{"csrfToken":"csrf"}');
    if (value.endsWith('/api/cove-rest/tasks') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      posts.push(body);
      return new Response(JSON.stringify([body]), { status: 201 });
    }
    throw new Error(`unexpected request: ${value}`);
  };
}

async function capture(dir, payloads, prompts, posts, sourceId) {
  return runCoveIntake({
    text: 'Send Maya the revised scope by Friday.',
    source: 'chat',
    sourceId,
  }, {
    dataDir: dir,
    fetchImpl: coveFetch(posts),
    webBaseUrl: `http://${sourceId}.test`,
    codexPath: 'codex',
    spawnImpl: sequencedSpawn(payloads, prompts),
    now: () => new Date('2026-07-26T16:00:00.000Z'),
    write: () => undefined,
  });
}

// A fresh install has no Projects directory, so "Atlas" is the entire allowed
// vocabulary and a model naming anything else fails the contract. That used to
// throw past the runner and send the whole capture to the raw-text card, losing
// the title, deadline and priority the model had got right.
test('a triage that breaks the contract gets the same second chance the other lanes get', async (t) => {
  const dir = fixture(t);
  const prompts = [];
  const posts = [];
  const result = await capture(
    dir,
    [triage({ project: 'Client Work' }), triage()],
    prompts,
    posts,
    'retry-project',
  );

  assert.equal(result.fallback, false, 'the capture should not fall back to raw text');
  assert.equal(result.error, undefined);
  assert.equal(prompts.length, 2, 'the model should be asked again');
  assert.match(prompts[1], /CORRECTION:/);
  assert.match(prompts[1], /triage_project_invalid/);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].title, 'Send Maya the revised scope');
  assert.equal(posts[0].due_at, '2026-07-27T17:00:00-07:00');
  assert.equal(posts[0].priority, 'high');
  assert.ok(posts[0].tags.includes('triaged'));
});

test('a first answer that already obeys the contract is not asked twice', async (t) => {
  const dir = fixture(t);
  const prompts = [];
  const posts = [];
  const result = await capture(dir, [triage()], prompts, posts, 'no-retry');

  assert.equal(result.fallback, false);
  assert.equal(prompts.length, 1, 'a valid answer must not cost a second model call');
});

test('two bad answers still reach the person as a raw-text card', async (t) => {
  const dir = fixture(t);
  const prompts = [];
  const posts = [];
  const result = await capture(
    dir,
    [triage({ due_at: '2026-02-30T09:00:00-07:00' })],
    prompts,
    posts,
    'still-fallback',
  );

  assert.equal(result.fallback, true);
  assert.equal(prompts.length, 2);
  assert.ok(posts[0].tags.includes('needs-triage'));
});
