import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { getEvent } from '../src/lib/intake/inbox.ts';
import { openLocalDatabase } from '../src/lib/local/database.ts';
import {
  buildTriagePrompt,
  runCoveIntake,
  triageRecordedEvent,
} from '../src/lib/intake/run.ts';
import {
  createCapturedInboundTask,
  createFallbackInboundTask,
  createTriagedInboundTask,
} from '../src/lib/intake/task-writer.ts';
import {
  readTriageProtocol,
  TRIAGE_JSON_SCHEMA,
  validateTriageOutput,
} from '../src/lib/triage/protocol.ts';
import { parseCoveIntakeArgs } from '../scripts/cove-intake.mjs';

function fixture(t) {
  const dir = path.join(
    os.tmpdir(),
    `cove-triage-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(path.join(dir, 'brief'), { recursive: true });
  writeFileSync(path.join(dir, 'brief', 'goals.md'), '# Goals\nGrow Edge AI.');
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
    if (prior.db === undefined) delete process.env.COVE_DB_PATH;
    else process.env.COVE_DB_PATH = prior.db;
    if (prior.runtime === undefined) delete process.env.NEXT_PUBLIC_COVE_RUNTIME;
    else process.env.NEXT_PUBLIC_COVE_RUNTIME = prior.runtime;
    if (prior.timezone === undefined) delete process.env.COVE_TIMEZONE;
    else process.env.COVE_TIMEZONE = prior.timezone;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function claudeSpawn(payload, calls) {
  return (executable, args, options) => {
    calls.push({ executable, args, options });
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    child.stdin.once('finish', () => {
      queueMicrotask(() => {
        const output = typeof payload === 'string' ? payload : JSON.stringify(payload);
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

function validTriage(overrides = {}) {
  return {
    title: 'Send Maya the revised scope',
    description: 'Close the active client loop so delivery can move forward.',
    project: 'Atlas',
    priority: 'high',
    due_at: '2026-07-27T17:00:00-07:00',
    autonomy: 'groundwork',
    groundwork_notes: 'Draft the scope changes for Jordan Rivers to approve.',
    surface: 'now',
    surface_at: null,
    urgency_reason: 'The client is blocked today.',
    offer: 'Want me to draft the revised scope?',
    ...overrides,
  };
}

function coveFetch(posts, options = {}) {
  return async (url, init = {}) => {
    const value = String(url);
    if (value.includes('/api/cove-rest/task_columns')) {
      return new Response(JSON.stringify([
        { id: 'not-started', name: 'Not Started', position: 0 },
        { id: 'today', name: 'Must happen today', position: 10 },
      ]));
    }
    if (value.includes('/api/cove-rest/tasks?')) {
      return new Response('[]');
    }
    if (value.endsWith('/api/day-plan')) {
      return new Response('{"csrfToken":"csrf"}');
    }
    if (value.endsWith('/api/cove-rest/tasks') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      posts.push(body);
      if (options.missingProjectOnce && posts.length === 1) {
        return new Response(
          '{"message":"Could not find the project column in the schema cache"}',
          { status: 400 },
        );
      }
      return new Response(JSON.stringify([body]), { status: 201 });
    }
    throw new Error(`unexpected request: ${value}`);
  };
}

test('natural-language recurrence captures today once and only proposes the template', async (t) => {
  const dir = fixture(t);
  const posts = [];
  const result = await runCoveIntake({
    text: 'Post a customer clip every day.',
    source: 'chat',
    sourceId: 'recurrence-proposal',
  }, {
    dataDir: dir,
    fetchImpl: coveFetch(posts),
    webBaseUrl: 'http://recurrence-proposal.test',
    codexPath: 'codex',
    spawnImpl: claudeSpawn(validTriage({
      due_at: '2026-08-10T09:00:00-07:00',
      surface: 'board',
      surface_at: null,
    }), []),
    now: () => new Date('2026-07-28T16:00:00.000Z'),
    write: () => undefined,
  });

  assert.equal(result.proposedRecurrence, 'daily');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].column_id, 'today');
  assert.equal(posts[0].due_at, '2026-08-10T09:00:00-07:00');
  assert.equal(posts[0].proposed_recurrence_cadence, 'daily');
  assert.ok(posts[0].tags.includes('recurrence-proposed'));
  const db = openLocalDatabase(path.join(dir, 'cove.db'));
  try {
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM recurring_templates').get().n,
      0,
    );
  } finally {
    db.close();
  }
});

test('Supabase intake payloads stay pre-stage even when recurrence is proposed', async (t) => {
  const dir = fixture(t);
  process.env.NEXT_PUBLIC_COVE_RUNTIME = 'supabase';
  const event = {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    source: 'chat',
    source_id: 'supabase-mode',
    raw_text: 'Post a clip every day.',
    machine: 'test',
    state: 'pending',
    task_id: null,
    error: null,
    attempts: 0,
    created_at: '2026-07-28T16:00:00.000Z',
    updated_at: '2026-07-28T16:00:00.000Z',
  };
  const now = () => new Date('2026-07-28T16:00:00.000Z');

  const fallbackPosts = [];
  await createFallbackInboundTask(event, {
    dataDir: dir,
    fetchImpl: coveFetch(fallbackPosts),
    webBaseUrl: 'http://supabase-fallback.test',
    now,
    proposedRecurrenceCadence: 'daily',
  });
  assert.equal(fallbackPosts[0].column_id, 'not-started');
  assert.equal(fallbackPosts[0].due_at, '2026-07-29T09:00:00-07:00');
  assert.deepEqual(fallbackPosts[0].tags, ['needs-triage']);
  assert.equal('proposed_recurrence_cadence' in fallbackPosts[0], false);

  const capturedPosts = [];
  await createCapturedInboundTask({ ...event, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }, {
    title: 'Post a clip',
    description: 'Captured.',
    column: 'Not Started',
  }, {
    dataDir: dir,
    fetchImpl: coveFetch(capturedPosts),
    webBaseUrl: 'http://supabase-captured.test',
    now,
    proposedRecurrenceCadence: 'daily',
  });
  assert.equal(capturedPosts[0].column_id, 'not-started');
  assert.equal('due_at' in capturedPosts[0], false);
  assert.deepEqual(capturedPosts[0].tags, ['needs-triage']);
  assert.equal('proposed_recurrence_cadence' in capturedPosts[0], false);

  const triagedPosts = [];
  const triage = validTriage({
    due_at: '2026-08-10T09:00:00-07:00',
    surface: 'board',
    priority: 'medium',
  });
  await createTriagedInboundTask({ ...event, id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, triage, {
    dataDir: dir,
    fetchImpl: coveFetch(triagedPosts),
    webBaseUrl: 'http://supabase-triaged.test',
    now,
    proposedRecurrenceCadence: 'daily',
  });
  assert.equal(triagedPosts[0].column_id, 'not-started');
  assert.equal(triagedPosts[0].due_at, triage.due_at);
  assert.equal(triagedPosts[0].tags.includes('recurrence-proposed'), false);
  assert.equal('proposed_recurrence_cadence' in triagedPosts[0], false);

  const dryRun = await runCoveIntake({
    text: 'Post a clip every day.',
    source: 'chat',
    sourceId: 'supabase-detection',
    dryRun: true,
  }, {
    dataDir: dir,
    now,
    write: () => undefined,
  });
  assert.equal(dryRun.proposedRecurrence, undefined);
});

test('local proposed fallback and captured tasks use date-only due values', async (t) => {
  const dir = fixture(t);
  const event = {
    id: 'abababab-abab-4bab-8bab-abababababab',
    source: 'chat',
    source_id: 'local-date-only',
    raw_text: 'Stretch every day.',
    machine: 'test',
    state: 'pending',
    task_id: null,
    error: null,
    attempts: 0,
    created_at: '2026-07-28T16:00:00.000Z',
    updated_at: '2026-07-28T16:00:00.000Z',
  };
  const options = {
    dataDir: dir,
    now: () => new Date('2026-07-28T16:00:00.000Z'),
    proposedRecurrenceCadence: 'daily',
  };
  const fallbackPosts = [];
  await createFallbackInboundTask(event, {
    ...options,
    fetchImpl: coveFetch(fallbackPosts),
    webBaseUrl: 'http://local-date-fallback.test',
  });
  assert.equal(fallbackPosts[0].due_at, '2026-07-28');

  const capturedPosts = [];
  await createCapturedInboundTask(
    { ...event, id: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd' },
    { title: 'Stretch', description: 'Captured.' },
    {
      ...options,
      fetchImpl: coveFetch(capturedPosts),
      webBaseUrl: 'http://local-date-captured.test',
    },
  );
  assert.equal(capturedPosts[0].due_at, '2026-07-28');
});

test('triage protocol is canonical, strict, and CLI parsing accepts text or files', (t) => {
  const dir = fixture(t);
  const protocol = readTriageProtocol();
  assert.match(protocol, /What is the north-star goal of this task/);
  assert.match(protocol, /Never send any outbound communication without the operator's explicit approval/);
  assert.match(protocol, /Every task belongs to a project/);
  assert.equal(JSON.parse(TRIAGE_JSON_SCHEMA).additionalProperties, false);
  assert.equal(validateTriageOutput(validTriage(), []).project, 'Atlas');
  assert.throws(
    () => validateTriageOutput(validTriage({ project: 'Invented' }), ['cove']),
    /triage_project_invalid/,
  );
  assert.throws(
    () => validateTriageOutput(validTriage({ due_at: '2026-07-27' }), []),
    /triage_due_at_invalid/,
  );
  const file = path.join(dir, 'task.txt');
  writeFileSync(file, 'Review the proposal');
  assert.deepEqual(parseCoveIntakeArgs([
    '--file', file, '--source', 'meeting', '--source-id', 'meet-1', '--dry-run',
  ]), {
    text: 'Review the proposal',
    source: 'meeting',
    sourceId: 'meet-1',
    dryRun: true,
  });
  assert.equal(
    parseCoveIntakeArgs([
      '--text', '--starts-with-a-flag', '--source', 'chat',
    ]).text,
    '--starts-with-a-flag',
  );
  assert.throws(
    () => parseCoveIntakeArgs(['--text', 'x', '--file', file, '--source', 'chat']),
    /exactly one/,
  );
  assert.match(
    buildTriagePrompt({
      protocol,
      rawText: 'Call Maya',
      source: 'chat',
      goals: 'Grow Edge AI',
      projects: ['cove'],
      board: { tasks: [], columns: [] },
      now: new Date('2026-07-27T18:00:00.000Z'),
    }),
    /RAW_TASK_TEXT="Call Maya"/,
  );
});

test('canonical intake captures first, triages once, writes project, and is idempotent', async (t) => {
  const dir = fixture(t);
  const posts = [];
  const spawnCalls = [];
  const notifications = [];
  const lines = [];
  const options = {
    dataDir: dir,
    repoDir: process.cwd(),
    fetchImpl: coveFetch(posts),
    webBaseUrl: 'http://triage.test',
    codexPath: 'codex',
    spawnImpl: claudeSpawn(
      `\`\`\`json\n${JSON.stringify(validTriage())}\n\`\`\``,
      spawnCalls,
    ),
    notifyNow: async (title) => notifications.push(title),
    now: () => new Date('2026-07-27T18:00:00.000Z'),
    write: (line) => lines.push(line),
  };
  const result = await runCoveIntake({
    text: 'Maya needs the revised scope today.',
    source: 'chat',
    sourceId: 'chat-1',
  }, options);
  assert.equal(result.exitCode, 0);
  assert.equal(result.fallback, false);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].id, result.event.id);
  assert.equal(posts[0].column_id, 'today');
  assert.equal(posts[0].project, 'Atlas');
  assert.deepEqual(posts[0].tags, [
    'triaged',
    'autonomy-groundwork',
  ]);
  assert.match(posts[0].description, /Offer: Want me to draft/);
  assert.match(posts[0].description, /Groundwork: Draft the scope/);
  assert.deepEqual(notifications, ['Send Maya the revised scope']);
  const stored = await getEvent(result.event.id);
  assert.equal(stored.state, 'triaged');
  assert.equal(stored.task_id, result.event.id);
  assert.equal(spawnCalls[0].executable, 'codex');
  assert.deepEqual(spawnCalls[0].args.slice(0, 9), [
    'exec', '--sandbox', 'read-only', '--skip-git-repo-check',
    '-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort=high',
    '--output-last-message',
  ]);
  assert.equal(spawnCalls[0].args.includes('--output-schema'), false);
  assert.equal(spawnCalls[0].options.env.SUPABASE_SERVICE_ROLE_KEY, undefined);
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(dir, 'cove-autonomy.json'), 'utf8')),
    {
      level: 'off',
      first_groundwork_at: null,
      checkin_answered: false,
      checkin_presented_count: 0,
    },
  );
  assert.match(lines[0], /^TASK /);

  const retry = await runCoveIntake({
    text: 'Maya needs the revised scope today.',
    source: 'chat',
    sourceId: 'chat-1',
  }, options);
  assert.equal(retry.existed, true);
  assert.equal(retry.taskId, result.event.id);
  assert.equal(spawnCalls.length, 1);
  assert.equal(posts.length, 1);
});

test('dry-run capture is terminal and never becomes sweeper work', async (t) => {
  const dir = fixture(t);
  const result = await runCoveIntake({
    text: 'Preview this intake without creating it.',
    source: 'chat',
    sourceId: 'dry-run-1',
    dryRun: true,
  }, {
    dataDir: dir,
    fetchImpl: async () => {
      throw new Error('dry-run must not read or write the board');
    },
    spawnImpl: () => {
      throw new Error('dry-run must not invoke Claude');
    },
    now: () => new Date('2026-07-27T18:00:00.000Z'),
    write: () => undefined,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.event.state, 'dismissed');
  assert.equal(result.event.source_id, 'dry-run:dry-run-1');
  assert.equal((await getEvent(result.event.id)).state, 'dismissed');
});

test('triage autonomy none never queues groundwork', async (t) => {
  const dir = fixture(t);
  const posts = [];
  await runCoveIntake({
    text: 'Jordan Rivers must handle this personally.',
    source: 'chat',
    sourceId: 'autonomy-none',
  }, {
    dataDir: dir,
    repoDir: process.cwd(),
    fetchImpl: coveFetch(posts),
    webBaseUrl: 'http://autonomy-none.test',
    codexPath: 'codex',
    spawnImpl: claudeSpawn(validTriage({
      autonomy: 'none',
      groundwork_notes: null,
      surface: 'board',
      surface_at: null,
    }), []),
    now: () => new Date('2026-07-27T18:00:00.000Z'),
    write: () => undefined,
  });
  assert.deepEqual(posts[0].tags, ['triaged', 'autonomy-none']);
});

test('the off setting suppresses a model-selected groundwork queue', async (t) => {
  const dir = fixture(t);
  writeFileSync(path.join(dir, 'cove-autonomy.json'), JSON.stringify({
    level: 'off',
    first_groundwork_at: null,
    checkin_answered: false,
    checkin_presented_count: 0,
  }));
  const posts = [];
  await runCoveIntake({
    text: 'Research this only when autonomy is enabled.',
    source: 'chat',
    sourceId: 'autonomy-off',
  }, {
    dataDir: dir,
    repoDir: process.cwd(),
    fetchImpl: coveFetch(posts),
    webBaseUrl: 'http://autonomy-off.test',
    codexPath: 'codex',
    spawnImpl: claudeSpawn(validTriage({
      surface: 'board',
      surface_at: null,
    }), []),
    now: () => new Date('2026-07-27T18:00:00.000Z'),
    write: () => undefined,
  });
  assert.deepEqual(posts[0].tags, ['triaged', 'autonomy-groundwork']);
});

test('a due-now surface receipt survives task creation and resumes without another task', async (t) => {
  const dir = fixture(t);
  const posts = [];
  let taskExists = false;
  const fetchImpl = async (url, init = {}) => {
    const value = String(url);
    if (value.includes('/api/cove-rest/task_columns')) {
      return new Response(JSON.stringify([
        { id: 'not-started', name: 'Not Started', position: 0 },
        { id: 'today', name: 'Must happen today', position: 10 },
      ]));
    }
    if (value.includes('/api/cove-rest/tasks?')) {
      return new Response(taskExists
        ? JSON.stringify([{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }])
        : '[]');
    }
    if (value.endsWith('/api/day-plan')) {
      return new Response('{"csrfToken":"csrf"}');
    }
    if (value.endsWith('/api/cove-rest/tasks') && init.method === 'POST') {
      const body = JSON.parse(init.body);
      posts.push(body);
      taskExists = true;
      return new Response(JSON.stringify([body]), { status: 201 });
    }
    throw new Error(`unexpected request: ${value}`);
  };
  const event = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    source: 'chat',
    source_id: 'surface-retry',
    raw_text: 'Surface this now.',
    machine: 'test',
    state: 'pending',
    task_id: null,
    error: null,
    attempts: 0,
    created_at: '2026-07-27T17:00:00.000Z',
    updated_at: '2026-07-27T17:00:00.000Z',
  };
  await assert.rejects(
    triageRecordedEvent(event, { taskId: event.id }, {
      dataDir: dir,
      fetchImpl,
      webBaseUrl: 'http://surface-retry.test',
      codexPath: 'codex',
      spawnImpl: claudeSpawn(validTriage(), []),
      notifyNow: async () => {
        throw new Error('notification unavailable');
      },
      now: () => new Date('2026-07-27T18:00:00.000Z'),
    }),
    /notification unavailable/,
  );
  const receipt = path.join(dir, 'reminders', `scheduled-${event.id}.json`);
  assert.equal(existsSync(receipt), true);
  const notifications = [];
  await triageRecordedEvent(event, { taskId: event.id }, {
    dataDir: dir,
    fetchImpl,
    webBaseUrl: 'http://surface-retry.test',
    spawnImpl: () => {
      throw new Error('resume must not invoke Claude');
    },
    notifyNow: async (title) => notifications.push(title),
  });
  assert.equal(posts.length, 1);
  assert.deepEqual(notifications, ['Send Maya the revised scope']);
  assert.equal(existsSync(receipt), false);
});

test('triage failure creates the Phase 0 fallback on the same event and records the error', async (t) => {
  const dir = fixture(t);
  const posts = [];
  const lines = [];
  const modelCalls = [];
  const result = await runCoveIntake({
    text: 'Capture this even when Claude returns nonsense.',
    source: 'voice',
    sourceId: 'voice-1',
  }, {
    dataDir: dir,
    repoDir: process.cwd(),
    fetchImpl: coveFetch(posts),
    webBaseUrl: 'http://fallback.test',
    codexPath: 'codex',
    spawnImpl: claudeSpawn('not-json', modelCalls),
    now: () => new Date('2026-07-27T18:00:00.000Z'),
    write: (line) => lines.push(line),
    writeError: () => undefined,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.fallback, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].id, result.event.id);
  assert.deepEqual(posts[0].tags, ['needs-triage']);
  assert.equal('project' in posts[0], false);
  const stored = await getEvent(result.event.id);
  assert.equal(stored.state, 'triaged');
  assert.equal(stored.task_id, stored.id);
  assert.match(stored.error, /codex_invalid_output/);
  assert.equal(modelCalls.length, 2);
  assert.deepEqual([...new Set(modelCalls.map((call) => call.executable))], ['codex']);
  assert.match(lines[0], /^TASK /);
  assert.match(lines[0], /"fallback":true/);
});

test('scheduled triage writes a reminder entry and task writes retry without a live project column', async (t) => {
  const dir = fixture(t);
  const scheduledPosts = [];
  const scheduled = validTriage({
    priority: 'medium',
    due_at: '2026-07-29T09:00:00-07:00',
    surface: 'scheduled',
    surface_at: '2026-07-28T14:00:00-07:00',
  });
  const result = await runCoveIntake({
    text: 'Review this tomorrow afternoon.',
    source: 'email',
    sourceId: 'email-1',
  }, {
    dataDir: dir,
    repoDir: process.cwd(),
    fetchImpl: coveFetch(scheduledPosts),
    webBaseUrl: 'http://scheduled.test',
    codexPath: 'codex',
    spawnImpl: claudeSpawn(scheduled, []),
    now: () => new Date('2026-07-27T18:00:00.000Z'),
    write: () => undefined,
  });
  const reminderFiles = readdirSync(path.join(dir, 'reminders'));
  assert.deepEqual(reminderFiles, [`scheduled-${result.event.id}.json`]);
  const reminder = JSON.parse(
    readFileSync(path.join(dir, 'reminders', reminderFiles[0]), 'utf8'),
  );
  assert.equal(reminder.source, 'email');
  assert.equal(reminder.surface_at, scheduled.surface_at);

  const posts = [];
  const event = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    source: 'test',
    source_id: 'missing-project',
    raw_text: 'Test project compatibility.',
    machine: 'test',
    state: 'pending',
    task_id: null,
    error: null,
    attempts: 0,
    created_at: '2026-07-27T17:00:00.000Z',
    updated_at: '2026-07-27T17:00:00.000Z',
  };
  await createTriagedInboundTask(event, validTriage(), {
    fetchImpl: coveFetch(posts, { missingProjectOnce: true }),
    webBaseUrl: 'http://missing-project.test',
    now: () => new Date('2026-07-27T18:00:00.000Z'),
  });
  assert.equal(posts.length, 2);
  assert.equal(posts[0].project, 'Atlas');
  assert.equal('project' in posts[1], false);

  const reprobeEvent = {
    ...event,
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    source_id: 'project-reprobe',
  };
  await createTriagedInboundTask(reprobeEvent, validTriage(), {
    fetchImpl: coveFetch(posts, { missingProjectOnce: true }),
    webBaseUrl: 'http://missing-project.test',
    now: () => new Date('2026-07-27T18:11:00.000Z'),
  });
  assert.equal(posts.length, 3);
  assert.equal(posts[2].project, 'Atlas');

  const unmatchedPosts = [];
  await createTriagedInboundTask({
    ...event,
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    source_id: 'unmatched-project-error',
  }, validTriage(), {
    fetchImpl: async (url, init = {}) => {
      const value = String(url);
      if (value.includes('/api/cove-rest/tasks?')) return new Response('[]');
      if (value.includes('/api/cove-rest/task_columns')) {
        return new Response(JSON.stringify([
          { id: 'not-started', name: 'Not Started', position: 0 },
          { id: 'today', name: 'Must happen today', position: 1 },
        ]));
      }
      if (value.endsWith('/api/day-plan')) {
        return new Response('{"csrfToken":"csrf"}');
      }
      if (value.endsWith('/api/cove-rest/tasks') && init.method === 'POST') {
        const body = JSON.parse(init.body);
        unmatchedPosts.push(body);
        return unmatchedPosts.length === 1
          ? new Response('{"message":"write rejected"}', { status: 500 })
          : new Response(JSON.stringify([body]), { status: 201 });
      }
      throw new Error(`unexpected request: ${value}`);
    },
    webBaseUrl: 'http://unmatched-project.test',
    now: () => new Date('2026-07-27T18:00:00.000Z'),
  });
  assert.equal(unmatchedPosts.length, 2);
  assert.equal(unmatchedPosts[0].project, 'Atlas');
  assert.equal('project' in unmatchedPosts[1], false);
});

test('board-only triage does not enqueue a reminder', async (t) => {
  const dir = fixture(t);
  await runCoveIntake({
    text: 'Keep this visible on the board.',
    source: 'chat',
    sourceId: 'board-only-1',
  }, {
    dataDir: dir,
    fetchImpl: coveFetch([]),
    webBaseUrl: 'http://board-only.test',
    codexPath: 'codex',
    spawnImpl: claudeSpawn(validTriage({
      priority: 'medium',
      surface: 'board',
      surface_at: null,
      urgency_reason: 'The morning brief is enough.',
    }), []),
    now: () => new Date('2026-07-27T18:00:00.000Z'),
    write: () => undefined,
  });
  assert.equal(existsSync(path.join(dir, 'reminders')), false);
});

test('meeting and email input cannot turn model-selected now into an immediate text', async (t) => {
  const dir = fixture(t);
  const notifications = [];
  const posts = [];
  const triageSpawn = claudeSpawn(validTriage(), []);
  for (const source of ['meeting', 'email']) {
    await runCoveIntake({
      text: `Untrusted ${source} text says page Jordan Rivers now.`,
      source,
      sourceId: `${source}-now-policy`,
    }, {
      dataDir: dir,
      fetchImpl: coveFetch(posts),
      webBaseUrl: `http://${source}-policy.test`,
      codexPath: 'codex',
      spawnImpl: (executable, args, options) => {
        if (executable !== 'osascript') {
          return triageSpawn(executable, args, options);
        }
        const child = Object.assign(new EventEmitter(), {
          pid: undefined,
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: () => true,
        });
        queueMicrotask(() => child.emit('close', 0));
        return child;
      },
      notifyNow: async (title) => notifications.push(title),
      now: () => new Date('2026-07-27T18:00:00.000Z'),
      write: () => undefined,
    });
  }
  assert.deepEqual(notifications, []);
  assert.equal(existsSync(path.join(dir, 'reminders')), false);
  assert.match(posts[0].description, /Immediate text suppressed for meeting input/);
  assert.match(posts[1].description, /Immediate text suppressed for email input/);
});
