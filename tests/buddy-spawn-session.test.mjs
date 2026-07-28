import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { NextRequest } from 'next/server';
import {
  handleSpawnSessionGet,
  handleSpawnSessionPost,
} from '../src/app/api/buddy/spawn-session/route.ts';
import { seedBuddySession } from '../src/lib/buddy/spawn-session.ts';
import { isBuddySpawnedSessionOpenable } from '../src/lib/buddy/spawned-session-state.ts';
import { createBuddyStore } from '../src/lib/buddy/store.ts';
import { getQuietCurrentCsrfToken } from '../src/lib/quiet-current/store.ts';

test('spawn-session route gates requests and confines real directories to ~/Atlas', async (t) => {
  const root = path.join(os.tmpdir(), `forge-buddy-spawn-${process.pid}-${Date.now()}`);
  const store = createBuddyStore({ dbPath: path.join(root, 'forge.db') });
  const home = '/Users/forge-test';
  const previousMode = process.env.COVE_DAY_PLAN_ACCESS_MODE;
  const previousQuietFile = process.env.COVE_QUIET_CURRENT_FILE;
  const previousDeepLinks = process.env.COVE_BUDDY_DEEPLINKS;
  const quietFile = `buddy-spawn-${process.pid}-${Date.now()}.json`;
  process.env.COVE_DAY_PLAN_ACCESS_MODE = 'loopback';
  process.env.COVE_QUIET_CURRENT_FILE = quietFile;
  process.env.COVE_BUDDY_DEEPLINKS = '0';
  t.after(() => {
    store.close();
    if (previousMode === undefined) delete process.env.COVE_DAY_PLAN_ACCESS_MODE;
    else process.env.COVE_DAY_PLAN_ACCESS_MODE = previousMode;
    if (previousQuietFile === undefined) delete process.env.COVE_QUIET_CURRENT_FILE;
    else process.env.COVE_QUIET_CURRENT_FILE = previousQuietFile;
    if (previousDeepLinks === undefined) delete process.env.COVE_BUDDY_DEEPLINKS;
    else process.env.COVE_BUDDY_DEEPLINKS = previousDeepLinks;
    rmSync(path.join(process.cwd(), 'data', quietFile), { force: true });
    rmSync(path.join(process.cwd(), 'data', `${quietFile}.token`), { force: true });
    rmSync(root, { recursive: true, force: true });
  });

  const token = getQuietCurrentCsrfToken();
  const requestBody = (body, headers = {}) => new NextRequest('http://127.0.0.1:3200/api/buddy/spawn-session', {
    method: 'POST',
    headers: {
      host: '127.0.0.1:3200',
      'content-type': 'application/json',
      'x-forge-csrf': token,
      ...headers,
    },
    body: JSON.stringify({ prompt: 'Plan the work', title: 'Plan it', ...body }),
  });
  const request = (dir, headers = {}) => requestBody({ dir }, headers);
  const baseDeps = {
    store,
    homeDir: home,
    workspaceRoot: `${home}/Atlas`,
    markSession: () => undefined,
    stat: () => ({ isDirectory: () => true }),
  };

  const untrusted = await handleSpawnSessionPost(request(`${home}/Atlas/app`, { host: 'evil.example' }), baseDeps);
  assert.equal(untrusted.status, 403);
  const noCsrfRequest = request(`${home}/Atlas/app`);
  noCsrfRequest.headers.delete('x-forge-csrf');
  assert.equal((await handleSpawnSessionPost(noCsrfRequest, baseDeps)).status, 403);
  const noWorkspace = await handleSpawnSessionPost(request(`${home}/Atlas/app`), {
    ...baseDeps,
    workspaceRoot: null,
    realpath: () => assert.fail('filesystem resolution must not run without a workspace'),
    readdir: () => assert.fail('project listing must not run without a workspace'),
    seed: () => assert.fail('seed must not run without a workspace'),
  });
  assert.equal(noWorkspace.status, 400);
  assert.deepEqual(await noWorkspace.json(), {
    error: 'No coding workspace is configured on this machine.',
  });

  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 12345,
    kill: () => true,
    unref: () => child,
  });
  let spawnCall;
  const marked = [];
  const validDir = `${home}/Atlas/Projects/demo`;
  const valid = await handleSpawnSessionPost(request(validDir), {
    ...baseDeps,
    realpath: (value) => value,
    randomId: () => 'session-1',
    markSession: (sessionId) => marked.push(sessionId),
    seed: (input) => seedBuddySession({
      ...input,
      spawnImpl: (executable, args, options) => {
        assert.deepEqual(marked, []);
        spawnCall = { executable, args, options };
        return child;
      },
    }),
  });
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { sessionId: 'session-1', state: 'seeding', dir: validDir });
  assert.equal(store.getSpawnedSession('session-1').state, 'started');
  assert.deepEqual(marked, ['session-1']);
  assert.equal(isBuddySpawnedSessionOpenable(store.getSpawnedSession('session-1').state), true);
  assert.equal(spawnCall.options.cwd, validDir);
  assert.equal(spawnCall.options.detached, true);
  assert.deepEqual(spawnCall.args.slice(0, 5), ['-p', '--session-id', 'session-1', '--permission-mode', 'plan']);
  assert.ok(spawnCall.args.includes('--disable-slash-commands'));
  assert.equal(spawnCall.args[spawnCall.args.indexOf('--model') + 1], 'claude-fable-5');
  assert.equal(spawnCall.args[spawnCall.args.indexOf('--effort') + 1], 'high');
  assert.equal(spawnCall.args[spawnCall.args.indexOf('--max-budget-usd') + 1], '1.00');
  // The seed prompt is model-written from untrusted rows, so "don't use tools"
  // has to be enforced by flags and not only by the system prompt.
  assert.equal(spawnCall.args[spawnCall.args.indexOf('--tools') + 1], '');
  assert.ok(spawnCall.args.includes('--strict-mcp-config'));
  assert.ok(spawnCall.args.includes('--no-chrome'));
  assert.match(
    spawnCall.args[spawnCall.args.indexOf('--mcp-config') + 1],
    /cove-empty-mcp\.json$/,
  );
  const systemPrompt = spawnCall.args[spawnCall.args.indexOf('--append-system-prompt') + 1];
  assert.match(systemPrompt, /Do not read files, use tools, edit anything, or begin the work/);
  assert.match(systemPrompt, /at most 2-3 short bullets/);
  assert.match(systemPrompt, /then STOP/);
  assert.match(systemPrompt, /Skill tool with skill: orchestrator/);
  const seedPrompt = child.stdin.read()?.toString() ?? '';
  assert.equal(seedPrompt, '# Plan it\n\nPlan the work');
  child.stderr.write('budget reached');
  child.emit('close', 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.getSpawnedSession('session-1').state, 'incomplete');
  assert.equal(isBuddySpawnedSessionOpenable(store.getSpawnedSession('session-1').state), true);

  const fetched = await handleSpawnSessionGet(new NextRequest(
    'http://127.0.0.1:3200/api/buddy/spawn-session?id=session-1',
    { headers: { host: '127.0.0.1:3200' } },
  ), { store });
  const fetchedBody = await fetched.json();
  assert.equal(fetched.status, 200);
  assert.equal(fetchedBody.deepLinksEnabled, false);
  assert.equal(fetchedBody.hostname, os.hostname());
  delete process.env.COVE_BUDDY_DEEPLINKS;
  const defaultConfig = await handleSpawnSessionGet(new NextRequest(
    'http://127.0.0.1:3200/api/buddy/spawn-session?id=session-1',
    { headers: { host: '127.0.0.1:3200' } },
  ), { store });
  assert.equal((await defaultConfig.json()).deepLinksEnabled, true);

  const failedMarks = [];
  const neverStarted = await handleSpawnSessionPost(request(validDir), {
    ...baseDeps,
    realpath: (value) => value,
    randomId: () => 'session-never-started',
    markSession: (sessionId) => failedMarks.push(sessionId),
    seed: (input) => seedBuddySession({
      ...input,
      spawnImpl: () => { throw new Error('spawn ENOENT'); },
    }),
  });
  assert.equal(neverStarted.status, 200);
  const neverStartedRow = store.getSpawnedSession('session-never-started');
  assert.equal(neverStartedRow.state, 'launch_failed');
  assert.deepEqual(failedMarks, []);
  assert.equal(isBuddySpawnedSessionOpenable(neverStartedRow.state), false);
  assert.equal(isBuddySpawnedSessionOpenable('failed'), true);

  const rejected = async (dir, realpath) => {
    const response = await handleSpawnSessionPost(request(dir), {
      ...baseDeps,
      realpath,
      randomId: () => `never-${Math.random()}`,
      seed: () => assert.fail('seed must not run for a rejected directory'),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /inside .*Atlas|does not exist/);
  };
  await rejected('/tmp/outside', (value) => value);
  await rejected(`${home}/Atlas/../Secrets`, (value) => value);
  await rejected(`${home}/Atlas/link-out`, () => '/tmp/outside');
  await rejected(`${home}/Atlas/missing`, () => { throw new Error('ENOENT'); });
  const fileResponse = await handleSpawnSessionPost(request(`${home}/Atlas/file.txt`), {
    ...baseDeps,
    realpath: (value) => value,
    stat: () => ({ isDirectory: () => false }),
    seed: () => assert.fail('seed must not run for a file'),
  });
  assert.equal(fileResponse.status, 400);
  assert.match((await fileResponse.json()).error, /must be a directory/);

  let resolvedHint;
  let seededProjectDir;
  const projectResponse = await handleSpawnSessionPost(requestBody({ project: 'Supernova' }), {
    ...baseDeps,
    realpath: (value) => value,
    resolveProject: (hint) => {
      resolvedHint = hint;
      return `${home}/Atlas/Projects/supernova-engine`;
    },
    randomId: () => 'session-project',
    seed: ({ dir }) => { seededProjectDir = dir; },
  });
  assert.equal(projectResponse.status, 200);
  assert.equal(resolvedHint, 'Supernova');
  assert.equal(seededProjectDir, `${home}/Atlas/Projects/supernova-engine`);
  assert.equal((await projectResponse.json()).dir, seededProjectDir);

  const missingProject = await handleSpawnSessionPost(requestBody({ project: 'Jarvis' }), {
    ...baseDeps,
    resolveProject: () => null,
    listProjects: () => ['Jarvis Memory', 'Jarvis Pro', 'Supernova Engine'],
    seed: () => assert.fail('seed must not run for an unresolved project'),
  });
  assert.equal(missingProject.status, 400);
  assert.match((await missingProject.json()).error, /Available projects: Jarvis Memory, Jarvis Pro, Supernova Engine/);
});
