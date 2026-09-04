import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';
import {
  buildClaudeLoginCommand,
  openClaudeLoginInTerminal,
  parseClaudeAuthStatus,
  probeClaudeAuthStatus,
  CLAUDE_AUTH_STATUS_TIMEOUT_MS,
} from '../src/lib/buddy/claude-login.ts';
import { handleClaudeLoginPost } from '../src/app/api/buddy/claude-login/implementation.ts';
import { handleClaudeAuthStatusGet } from '../src/app/api/buddy/claude-auth-status/implementation.ts';
import { getQuietCurrentCsrfToken } from '../src/lib/quiet-current/store.ts';

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.unref = () => undefined;
  return child;
}

test('the login command opens Terminal through osascript with an argv array', () => {
  const command = buildClaudeLoginCommand('/Users/cove/.local/bin/claude');
  assert.equal(command.executable, '/usr/bin/osascript');
  assert.deepEqual(command.args, [
    '-e', 'tell application "Terminal" to activate',
    '-e', 'tell application "Terminal" to do script "\'/Users/cove/.local/bin/claude\' auth login"',
  ]);
});

test('the login command keeps odd characters in the binary path inert', () => {
  const command = buildClaudeLoginCommand('/Users/co"ve/it\'s/claude');
  const script = command.args[3];
  // The shell sees '/Users/co"ve/it'\''s/claude'; AppleScript needs its own
  // backslash and double-quote escapes on top of that.
  assert.equal(
    script,
    String.raw`tell application "Terminal" to do script "'/Users/co\"ve/it'\\''s/claude' auth login"`,
  );
});

test('openClaudeLoginInTerminal spawns detached without a shell and reports ok', () => {
  const calls = [];
  const result = openClaudeLoginInTerminal({
    claudePath: '/fake/claude',
    platform: 'darwin',
    spawnImpl: (executable, args, options) => {
      calls.push({ executable, args, options });
      return fakeChild();
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, '/usr/bin/osascript');
  assert.equal(calls[0].args[3], 'tell application "Terminal" to do script "\'/fake/claude\' auth login"');
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.equal(calls[0].options.shell, undefined);
});

test('openClaudeLoginInTerminal reports spawn failures and non-Mac hosts', () => {
  const threw = openClaudeLoginInTerminal({
    claudePath: '/fake/claude',
    platform: 'darwin',
    spawnImpl: () => { throw new Error('osascript missing'); },
  });
  assert.deepEqual(threw, { ok: false, error: 'osascript missing' });
  const linux = openClaudeLoginInTerminal({
    claudePath: '/fake/claude',
    platform: 'linux',
    spawnImpl: () => assert.fail('must not spawn off a Mac'),
  });
  assert.equal(linux.ok, false);
});

test('parseClaudeAuthStatus accepts the known signed-in shapes and rejects the rest', () => {
  assert.equal(parseClaudeAuthStatus('{"loggedIn":true,"authMethod":"claude.ai"}').signedIn, true);
  assert.equal(parseClaudeAuthStatus('{"signedIn":true}').signedIn, true);
  assert.equal(parseClaudeAuthStatus('{"authenticated":true}').signedIn, true);
  assert.equal(parseClaudeAuthStatus('{"status":"authenticated"}').signedIn, true);
  assert.equal(parseClaudeAuthStatus('Checking...\n{"loggedIn":true}\n').signedIn, true);
  assert.equal(parseClaudeAuthStatus('{"loggedIn":false,"authMethod":"none"}').signedIn, false);
  assert.equal(parseClaudeAuthStatus('{"status":"expired"}').signedIn, false);
  assert.equal(parseClaudeAuthStatus('{"loggedIn":"false"}').signedIn, true);
  assert.equal(parseClaudeAuthStatus('[]').signedIn, false);
  assert.equal(parseClaudeAuthStatus('not json at all').signedIn, false);
  assert.equal(parseClaudeAuthStatus('').signedIn, false);
  assert.deepEqual(parseClaudeAuthStatus('{"loggedIn":false}').raw, { loggedIn: false });
});

test('probeClaudeAuthStatus runs claude auth status --json with a ten second timeout', async () => {
  const calls = [];
  const status = await probeClaudeAuthStatus({
    claudePath: '/fake/claude',
    execImpl: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: '{"loggedIn":true}', stderr: '' };
    },
  });
  assert.deepEqual(status, { signedIn: true, raw: { loggedIn: true } });
  assert.deepEqual(calls[0].args, ['auth', 'status', '--json']);
  assert.equal(calls[0].file, '/fake/claude');
  assert.equal(calls[0].options.timeout, CLAUDE_AUTH_STATUS_TIMEOUT_MS);
  assert.equal(CLAUDE_AUTH_STATUS_TIMEOUT_MS, 10_000);
  const failed = await probeClaudeAuthStatus({
    claudePath: '/fake/claude',
    execImpl: async () => { throw new Error('boom'); },
  });
  assert.deepEqual(failed, { signedIn: false });
});

test('claude-login and claude-auth-status routes are loopback-only and the login needs CSRF', async (t) => {
  const previousMode = process.env.COVE_DAY_PLAN_ACCESS_MODE;
  const previousQuietFile = process.env.COVE_QUIET_CURRENT_FILE;
  const quietFile = `buddy-login-${process.pid}-${Date.now()}.json`;
  process.env.COVE_DAY_PLAN_ACCESS_MODE = 'loopback';
  process.env.COVE_QUIET_CURRENT_FILE = quietFile;
  t.after(() => {
    if (previousMode === undefined) delete process.env.COVE_DAY_PLAN_ACCESS_MODE;
    else process.env.COVE_DAY_PLAN_ACCESS_MODE = previousMode;
    if (previousQuietFile === undefined) delete process.env.COVE_QUIET_CURRENT_FILE;
    else process.env.COVE_QUIET_CURRENT_FILE = previousQuietFile;
    rmSync(path.join(process.cwd(), 'data', quietFile), { force: true });
    rmSync(path.join(process.cwd(), 'data', `${quietFile}.token`), { force: true });
  });
  const token = getQuietCurrentCsrfToken();
  const loginRequest = (headers = {}) => new NextRequest('http://127.0.0.1:3200/api/buddy/claude-login', {
    method: 'POST',
    headers: { host: '127.0.0.1:3200', 'x-cove-csrf': token, ...headers },
  });
  const spawned = [];
  const deps = {
    claudePath: '/fake/claude',
    platform: 'darwin',
    spawnImpl: (executable, args) => {
      spawned.push({ executable, args });
      return fakeChild();
    },
  };

  assert.equal((await handleClaudeLoginPost(loginRequest({ host: 'evil.example' }), deps)).status, 403);
  const noCsrf = loginRequest();
  noCsrf.headers.delete('x-cove-csrf');
  assert.equal((await handleClaudeLoginPost(noCsrf, deps)).status, 403);
  assert.equal(spawned.length, 0);

  const ok = await handleClaudeLoginPost(loginRequest(), deps);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].executable, '/usr/bin/osascript');

  const failed = await handleClaudeLoginPost(loginRequest(), {
    ...deps,
    spawnImpl: () => { throw new Error('no Terminal'); },
  });
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { ok: false, error: 'no Terminal' });

  const statusRequest = (headers = {}) => new NextRequest('http://127.0.0.1:3200/api/buddy/claude-auth-status', {
    headers: { host: '127.0.0.1:3200', ...headers },
  });
  const statusDeps = {
    claudePath: '/fake/claude',
    execImpl: async () => ({ stdout: '{"loggedIn":false,"authMethod":"none"}', stderr: '' }),
  };
  assert.equal((await handleClaudeAuthStatusGet(statusRequest({ host: 'evil.example' }), statusDeps)).status, 403);
  const signedOut = await handleClaudeAuthStatusGet(statusRequest(), statusDeps);
  assert.equal(signedOut.status, 200);
  assert.deepEqual(await signedOut.json(), { signedIn: false, raw: { loggedIn: false, authMethod: 'none' } });
  const signedIn = await handleClaudeAuthStatusGet(statusRequest(), {
    ...statusDeps,
    execImpl: async () => ({ stdout: '{"loggedIn":true}', stderr: '' }),
  });
  assert.equal((await signedIn.json()).signedIn, true);
});
