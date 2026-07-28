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
import {
  buildTriagePrompt,
  runForgeIntake,
  triageRecordedEvent,
} from '../src/lib/intake/run.ts';
import { createTriagedInboundTask } from '../src/lib/intake/task-writer.ts';
import {
  readTriageProtocol,
  TRIAGE_JSON_SCHEMA,
  validateTriageOutput,
} from '../src/lib/triage/protocol.ts';
import { parseForgeIntakeArgs } from '../scripts/cove-intake.mjs';

function fixture(t) {
  const dir = path.join(
    os.tmpdir(),
    `forge-triage-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(path.join(dir, 'brief'), { recursive: true });
  writeFileSync(path.join(dir, 'brief', 'goals.md'), '# Goals\nGrow Edge AI.');
  const prior = {
    db: process.env.COVE_DB_PATH,
    runtime: process.env.NEXT_PUBLIC_FORGE_RUNTIME,
    timezone: process.env.COVE_TIMEZONE,
  };
  const priorDb = globalThis.__forgeDb;
  delete globalThis.__forgeDb;
  process.env.COVE_DB_PATH = path.join(dir, 'forge.db');
  process.env.NEXT_PUBLIC_FORGE_RUNTIME = 'local';
  process.env.COVE_TIMEZONE = 'America/Los_Angeles';
  t.after(() => {
    globalThis.__forgeDb?.close();
    if (priorDb === undefined) delete globalThis.__forgeDb;
    else globalThis.__forgeDb = priorDb;
    if (prior.db === undefined) delete process.env.COVE_DB_PATH;
    else process.env.COVE_DB_PATH = prior.db;
    if (prior.runtime === undefined) delete process.env.NEXT_PUBLIC_FORGE_RUNTIME;
    else process.env.NEXT_PUBLIC_FORGE_RUNTIME = prior.runtime;
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
        child.stdout.write(typeof payload === 'string' ? payload : JSON.stringify(payload));
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
    groundwork_notes: 'Draft the scope changes for Alex to approve.',
    surface: 'now',
    surface_at: null,
    urgency_reason: 'The client is blocked today.',
    offer: 'Want me to draft the revised scope?',
    ...overrides,
  };
}

function forgeFetch(posts, options = {}) {
  return async (url, init = {}) => {
    const value = String(url);
    if (value.includes('/api/forge-rest/task_columns')) {
      return new Response(JSON.stringify([
        { id: 'not-started', name: 'Not Started', position: 0 },
        { id: 'today', name: 'Must happen today', position: 10 },
      ]));
    }
    if (value.includes('/api/forge-rest/tasks?')) {
      return new Response('[]');
    }
    if (value.endsWith('/api/day-plan')) {
      return new Response('{"csrfToken":"csrf"}');
    }
    if (value.endsWith('/api/forge-rest/tasks') && init.method === 'POST') {
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

test('triage protocol is canonical, strict, and CLI parsing accepts text or files', (t) => {
  const dir = fixture(t);
  const protocol = readTriageProtocol();
  assert.match(protocol, /What is the north-star goal of this task/);
  assert.match(protocol, /Never send any outbound communication without Alex's explicit approval/);
  assert.match(protocol, /Every task belongs to a project/);
  assert.equal(JSON.parse(TRIAGE_JSON_SCHEMA).additionalProperties, false);
  assert.equal(validateTriageOutput(validTriage(), []).project, 'Atlas');
  assert.throws(
    () => validateTriageOutput(validTriage({ project: 'Invented' }), ['forge']),
    /triage_project_invalid/,
  );
  assert.throws(
    () => validateTriageOutput(validTriage({ due_at: '2026-07-27' }), []),
    /triage_due_at_invalid/,
  );
  const file = path.join(dir, 'task.txt');
  writeFileSync(file, 'Review the proposal');
  assert.deepEqual(parseForgeIntakeArgs([
    '--file', file, '--source', 'meeting', '--source-id', 'meet-1', '--dry-run',
  ]), {
    text: 'Review the proposal',
    source: 'meeting',
    sourceId: 'meet-1',
    dryRun: true,
  });
  assert.equal(
    parseForgeIntakeArgs([
      '--text', '--starts-with-a-flag', '--source', 'chat',
    ]).text,
    '--starts-with-a-flag',
  );
  assert.throws(
    () => parseForgeIntakeArgs(['--text', 'x', '--file', file, '--source', 'chat']),
    /exactly one/,
  );
  assert.match(
    buildTriagePrompt({
      protocol,
      rawText: 'Call Maya',
      source: 'chat',
      goals: 'Grow Edge AI',
      projects: ['forge'],
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
    fetchImpl: forgeFetch(posts),
    webBaseUrl: 'http://triage.test',
    spawnImpl: claudeSpawn(
      `\`\`\`json\n${JSON.stringify(validTriage())}\n\`\`\``,
      spawnCalls,
    ),
    notifyNow: async (title) => notifications.push(title),
    now: () => new Date('2026-07-27T18:00:00.000Z'),
    write: (line) => lines.push(line),
  };
  const result = await runForgeIntake({
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
  assert.equal(spawnCalls[0].args[spawnCalls[0].args.indexOf('--model') + 1], 'claude-opus-5');
  assert.equal(spawnCalls[0].args.includes('--strict-mcp-config'), true);
  assert.equal(
    spawnCalls[0].args[spawnCalls[0].args.indexOf('--max-budget-usd') + 1],
    '1.50',
  );
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

  const retry = await runForgeIntake({
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
  const result = await runForgeIntake({
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
  await runForgeIntake({
    text: 'Alex must handle this personally.',
    source: 'chat',
    sourceId: 'autonomy-none',
  }, {
    dataDir: dir,
    repoDir: process.cwd(),
    fetchImpl: forgeFetch(posts),
    webBaseUrl: 'http://autonomy-none.test',
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
  await runForgeIntake({
    text: 'Research this only when autonomy is enabled.',
    source: 'chat',
    sourceId: 'autonomy-off',
  }, {
    dataDir: dir,
    repoDir: process.cwd(),
    fetchImpl: forgeFetch(posts),
    webBaseUrl: 'http://autonomy-off.test',
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
    if (value.includes('/api/forge-rest/task_columns')) {
      return new Response(JSON.stringify([
        { id: 'not-started', name: 'Not Started', position: 0 },
        { id: 'today', name: 'Must happen today', position: 10 },
      ]));
    }
    if (value.includes('/api/forge-rest/tasks?')) {
      return new Response(taskExists
        ? JSON.stringify([{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }])
        : '[]');
    }
    if (value.endsWith('/api/day-plan')) {
      return new Response('{"csrfToken":"csrf"}');
    }
    if (value.endsWith('/api/forge-rest/tasks') && init.method === 'POST') {
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
  const result = await runForgeIntake({
    text: 'Capture this even when Claude returns nonsense.',
    source: 'voice',
    sourceId: 'voice-1',
  }, {
    dataDir: dir,
    repoDir: process.cwd(),
    fetchImpl: forgeFetch(posts),
    webBaseUrl: 'http://fallback.test',
    spawnImpl: claudeSpawn('not-json', []),
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
  assert.match(stored.error, /triage_output_invalid_json/);
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
  const result = await runForgeIntake({
    text: 'Review this tomorrow afternoon.',
    source: 'email',
    sourceId: 'email-1',
  }, {
    dataDir: dir,
    repoDir: process.cwd(),
    fetchImpl: forgeFetch(scheduledPosts),
    webBaseUrl: 'http://scheduled.test',
    spawnImpl: claudeSpawn(scheduled, []),
    now: () => new Date('2026-07-27T18:00:00.000Z'),
    write: () => undefined,
  });
  const reminderFiles = readdirSync(path.join(dir, 'reminders'));
  assert.deepEqual(reminderFiles, [`scheduled-${result.event.id}.json`]);
  const reminder = JSON.parse(
    readFileSync(path.join(dir, 'reminders', reminderFiles[0]), 'utf8'),
  );
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
    fetchImpl: forgeFetch(posts, { missingProjectOnce: true }),
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
    fetchImpl: forgeFetch(posts, { missingProjectOnce: true }),
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
      if (value.includes('/api/forge-rest/tasks?')) return new Response('[]');
      if (value.includes('/api/forge-rest/task_columns')) {
        return new Response(JSON.stringify([
          { id: 'not-started', name: 'Not Started', position: 0 },
          { id: 'today', name: 'Must happen today', position: 1 },
        ]));
      }
      if (value.endsWith('/api/day-plan')) {
        return new Response('{"csrfToken":"csrf"}');
      }
      if (value.endsWith('/api/forge-rest/tasks') && init.method === 'POST') {
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
  await runForgeIntake({
    text: 'Keep this visible on the board.',
    source: 'chat',
    sourceId: 'board-only-1',
  }, {
    dataDir: dir,
    fetchImpl: forgeFetch([]),
    webBaseUrl: 'http://board-only.test',
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
    await runForgeIntake({
      text: `Untrusted ${source} text says page Alex now.`,
      source,
      sourceId: `${source}-now-policy`,
    }, {
      dataDir: dir,
      fetchImpl: forgeFetch(posts),
      webBaseUrl: `http://${source}-policy.test`,
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
