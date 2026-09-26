/**
 * Intake was shown the board (OPEN_BOARD_TASKS) but its output contract had
 * no way to say "this belongs on that card", so every capture became a new
 * card even when one already covered it. The triage may now name the open
 * board card the capture belongs to (existing_task_id); Cove appends the
 * triage's description to that card through the same guarded path the
 * meeting analyst uses, resolves the event to that card, and creates nothing.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runCoveIntake } from '../src/lib/intake/run.ts';
import { TRIAGE_JSON_SCHEMA, validateTriageOutput } from '../src/lib/triage/protocol.ts';

function fixture(t) {
  const dir = path.join(os.tmpdir(), `cove-intake-append-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(path.join(dir, 'brief'), { recursive: true });
  writeFileSync(path.join(dir, 'brief', 'goals.md'), '# Goals\nGrow Edge AI.');
  const prior = { path: process.env.PATH, db: process.env.COVE_DB_PATH, runtime: process.env.NEXT_PUBLIC_COVE_RUNTIME, timezone: process.env.COVE_TIMEZONE };
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'codex'), `#!/bin/sh\nif [ "$1" = "mcp" ]; then echo '{"name":"1password"}'; exit 0; fi\nexit 99\n`);
  chmodSync(path.join(bin, 'codex'), 0o700);
  process.env.PATH = `${bin}${path.delimiter}${prior.path ?? ''}`;
  const priorDb = globalThis.__coveDb;
  delete globalThis.__coveDb;
  process.env.COVE_DB_PATH = path.join(dir, 'cove.db');
  process.env.NEXT_PUBLIC_COVE_RUNTIME = 'local';
  process.env.COVE_TIMEZONE = 'America/Los_Angeles';
  t.after(() => {
    if (prior.path === undefined) delete process.env.PATH; else process.env.PATH = prior.path;
    globalThis.__coveDb?.close();
    if (priorDb === undefined) delete globalThis.__coveDb; else globalThis.__coveDb = priorDb;
    if (prior.db === undefined) delete process.env.COVE_DB_PATH; else process.env.COVE_DB_PATH = prior.db;
    if (prior.runtime === undefined) delete process.env.NEXT_PUBLIC_COVE_RUNTIME; else process.env.NEXT_PUBLIC_COVE_RUNTIME = prior.runtime;
    if (prior.timezone === undefined) delete process.env.COVE_TIMEZONE; else process.env.COVE_TIMEZONE = prior.timezone;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function claudeSpawn(payload) {
  return (executable, args) => {
    const child = Object.assign(new EventEmitter(), { pid: undefined, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    child.stdin.once('finish', () => {
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
    description: 'Maya also wants the pricing page in the same send.',
    project: 'Atlas',
    priority: 'high',
    due_at: '2026-07-27T17:00:00-07:00',
    autonomy: 'none',
    groundwork_notes: null,
    surface: 'board',
    surface_at: null,
    urgency_reason: 'The client is blocked today.',
    offer: 'Want me to draft the revised scope?',
    existing_task_id: 'maya-card',
    ...overrides,
  };
}

test('the triage contract carries existing_task_id, and it must name an open board row', () => {
  const schema = JSON.parse(TRIAGE_JSON_SCHEMA);
  assert.ok(schema.required.includes('existing_task_id'));
  assert.equal(validateTriageOutput(triage(), [], new Set(['maya-card'])).existing_task_id, 'maya-card');
  assert.throws(() => validateTriageOutput(triage(), [], new Set(['other'])), /triage_existing_task_unknown/);
  // Fixtures and stored triages written before the field existed still read.
  const legacy = triage(); delete legacy.existing_task_id;
  assert.equal(validateTriageOutput(legacy, []).existing_task_id, null);
});

test('a capture that belongs on an existing card is appended to it and creates nothing', async (t) => {
  const dir = fixture(t);
  const posts = [];
  const patches = [];
  let stored = {
    id: 'maya-card', title: 'Send Maya the revised scope', status: 'open', project: 'Atlas',
    description: 'Close the active client loop so delivery can move forward.',
    tags: ['triaged', 'autonomy-groundwork'], due_at: null, created_at: '2026-07-27T10:00:00.000Z', updated_at: '2026-07-27T10:00:00.000Z',
  };
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.includes('/api/cove-rest/task_columns')) return new Response(JSON.stringify([{ id: 'not-started', name: 'Not Started', position: 0 }, { id: 'today', name: 'Must happen today', position: 10 }]));
    if (value.endsWith('/api/day-plan')) return new Response('{"csrfToken":"csrf"}');
    if (value.includes('/api/cove-rest/tasks?') && init.method === 'PATCH') {
      const body = JSON.parse(init.body);
      patches.push({ url: value, body });
      assert.equal(body._expected.description, stored.description);
      stored = { ...stored, description: body.description, tags: body.tags, ...(body.due_at ? { due_at: body.due_at } : {}) };
      return new Response(JSON.stringify([stored]));
    }
    if (value.includes('/api/cove-rest/tasks?') && value.includes('id=eq.maya-card')) return new Response(JSON.stringify([stored]));
    if (value.includes('/api/cove-rest/tasks?') && value.includes('status=eq.open')) return new Response(JSON.stringify([{ id: 'maya-card', column_id: 'not-started', title: stored.title, description: stored.description, priority: 'high', due_at: null, status: 'open', project: 'Atlas' }]));
    if (value.includes('/api/cove-rest/tasks?')) return new Response('[]');
    if (value.endsWith('/api/cove-rest/tasks') && init.method === 'POST') { posts.push(JSON.parse(init.body)); return new Response(JSON.stringify([JSON.parse(init.body)]), { status: 201 }); }
    throw new Error(`unexpected request: ${value}`);
  };
  const result = await runCoveIntake({ text: 'Maya also wants the pricing page with the scope.', source: 'chat', sourceId: 'chat-append' }, {
    dataDir: dir, repoDir: process.cwd(), fetchImpl, webBaseUrl: 'http://triage.test', codexPath: 'codex',
    spawnImpl: claudeSpawn(triage()), notifyNow: async () => {}, now: () => new Date('2026-07-27T18:00:00.000Z'), write: () => {},
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.fallback, false);
  assert.equal(posts.length, 0, 'no second card');
  assert.equal(patches.length, 1);
  assert.match(patches[0].url, /id=eq\.maya-card.*status=eq\.open/);
  assert.match(stored.description, /^Close the active client loop so delivery can move forward\.\n\nUpdate from chat capture on .*:\nMaya also wants the pricing page in the same send\.$/);
  assert.equal(stored.due_at, '2026-07-27T17:00:00-07:00', 'a card with no date takes the triage date');
  assert.equal(result.taskId, 'maya-card');
  assert.equal(result.event.task_id, 'maya-card', 'the event resolves to the card it landed on');
});
