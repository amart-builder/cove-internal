import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { configureAgent } from '../scripts/cove-agent-settings.mjs';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { readAgentSettings, RECOMMENDED_AGENTS, validateAgentSettings } from '../src/lib/agent-settings.mjs';
import { finishBackgroundAttempt, readBackgroundUsage, reserveBackgroundAttempt } from '../src/lib/background-usage.mjs';
import { runJob } from '../src/lib/model-runner-runtime.mjs';

function fixture(t, provider = 'claude', limits = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cove-agent-settings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { HOME: dir, PATH: process.env.PATH, COVE_DATA_DIR: dir, COVE_DB_PATH: path.join(dir, 'cove.db') };
  const settings = validateAgentSettings({ version: 1, ...RECOMMENDED_AGENTS[provider], backgroundLimits: limits });
  writeFileSync(path.join(dir, 'agent-settings.json'), JSON.stringify(settings));
  return { dir, env, settings };
}

function fakeSpawn(calls, outputs) {
  return (executable, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    let prompt = '';
    child.stdin.on('data', data => { prompt += data; });
    child.stdin.on('finish', () => {
      calls.push({ executable, args, options, prompt });
      const output = outputs.shift() ?? { answer: 'done' };
      const outIndex = args.indexOf('--output-last-message');
      if (outIndex >= 0) {
        writeFileSync(args[outIndex + 1], JSON.stringify(output));
        child.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 40, output_tokens: 20 } }) + '\n');
      } else {
        child.stdout.write(JSON.stringify({ structured_output: output, usage: { input_tokens: 120, cache_read_input_tokens: 40, output_tokens: 20 } }));
      }
      child.stdout.end();
      queueMicrotask(() => child.emit('close', 0, null));
    });
    return child;
  };
}

const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };

for (const provider of ['claude', 'codex']) {
  test(`${provider} selection reaches actual argv and records observed usage`, async (t) => {
    const { env, settings } = fixture(t, provider);
    const calls = [];
    const result = await runJob({ lane: 'test', kind: 'structured', prompt: 'Review this desk', schema, env,
      backend: provider === 'claude' ? 'codex-sol-high' : 'claude',
      codexPath: process.execPath, claudePath: process.execPath, spawnImpl: fakeSpawn(calls, []) });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes(settings.model));
    assert.ok(calls[0].args.includes(provider === 'claude' ? 'low' : 'model_reasoning_effort=low'));
    const usage = readBackgroundUsage(env);
    assert.equal(usage.windows.day.calls, 1);
    assert.equal(usage.windows.day.inputTokens, 120);
    assert.equal(usage.windows.day.outputTokens, 20);
    assert.equal(usage.subscriptionRemaining, null);
  });
}

test('retry consumes a second reservation and a cap prevents another spawn', async (t) => {
  const { env } = fixture(t, 'claude', { callsPerDay: 1 });
  const calls = [];
  const result = await runJob({ lane: 'test', kind: 'structured', prompt: 'Review', schema, env,
    spawnImpl: fakeSpawn(calls, [{ wrong: true }]) });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'runner_budget_exceeded');
  assert.equal(calls.length, 1);
  assert.equal(readBackgroundUsage(env).recent[0].status, 'failed');
});

test('crash reservations count across rolling windows and missing usage stays unknown', (t) => {
  const { env, settings } = fixture(t, 'claude', { callsPerDay: 1 });
  const now = Date.now();
  const id = reserveBackgroundAttempt({ env, settings, lane: 'test', inputBytes: 5, now });
  assert.throws(() => reserveBackgroundAttempt({ env, settings, lane: 'retry', inputBytes: 5, now: now + 1000 }), /background_usage_limit/);
  finishBackgroundAttempt({ env, id, status: 'failed' });
  const usage = readBackgroundUsage(env);
  assert.equal(usage.windows.day.inputTokens, null);
  assert.equal(usage.windows.day.callsWithoutTokenUsage, 1);
  assert.doesNotThrow(() => reserveBackgroundAttempt({ env, settings, lane: 'later', inputBytes: 5, now: now + 86_400_001 }));
});

test('oversized context and invalid settings stop before any model call', async (t) => {
  const { dir, env } = fixture(t, 'claude', { inputBytesPerCall: 5 });
  let spawns = 0;
  const result = await runJob({ lane: 'test', kind: 'text', prompt: 'This input is too long', env, spawnImpl: () => { spawns++; } });
  assert.equal(result.error.code, 'runner_budget_exceeded');
  assert.equal(spawns, 0);
  const file = path.join(dir, 'agent-settings.json');
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...settings, model: 'gpt-6-astra' }));
  assert.throws(() => readAgentSettings(env), /does not match/);
  rmSync(file);
  assert.equal(readAgentSettings(env), undefined);
});


test('schema bytes count toward the Claude input ceiling', async (t) => {
  const { env } = fixture(t, 'claude', { inputBytesPerCall: 10 });
  let spawns = 0;
  const result = await runJob({ lane: 'test', kind: 'structured', prompt: 'hi', schema, env,
    spawnImpl: () => { spawns++; } });
  assert.equal(result.error.code, 'runner_budget_exceeded');
  assert.equal(spawns, 0);
});

test('observed usage survives a failed Claude process', async (t) => {
  const { env } = fixture(t);
  const result = await runJob({ lane: 'test', kind: 'text', prompt: 'hi', env, spawnImpl: () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.stdin.on('finish', () => {
      child.stdout.write(JSON.stringify({ is_error: true, result: 'rate limited', usage: { input_tokens: 8, output_tokens: 2 } }));
      queueMicrotask(() => child.emit('close', 1, null));
    });
    return child;
  } });
  assert.equal(result.ok, false);
  const usage = readBackgroundUsage(env).windows.day;
  assert.equal(usage.inputTokens, 8);
  assert.equal(usage.outputTokens, 2);
  assert.ok(usage.outputBytes > 0);
});

test('competing processes cannot reserve past a shared cap', async (t) => {
  const { env, settings } = fixture(t, 'claude', { callsPerDay: 3 });
  const moduleUrl = pathToFileURL(path.resolve('src/lib/background-usage.mjs')).href;
  const outcomes = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const source = `import {reserveBackgroundAttempt} from ${JSON.stringify(moduleUrl)};
      try { reserveBackgroundAttempt({env:${JSON.stringify(env)},settings:${JSON.stringify(settings)},lane:'race',inputBytes:1}); }
      catch(error) { if(error.message.startsWith('background_usage_limit')) process.exitCode=2; else throw error; }`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => [0, 2].includes(code) ? resolve(code) : reject(new Error(stderr)));
  })));
  assert.equal(outcomes.filter(code => code === 0).length, 3);
  assert.equal(readBackgroundUsage(env).windows.day.calls, 3);
});

test('setup saves a verified model and preserves settings after a failed check or conflict', async (t) => {
  const { dir, env } = fixture(t);
  const original = readAgentSettings(env);
  await assert.rejects(configureAgent({ provider: 'codex', env,
    runner: async () => ({ ok: false, error: { message: 'not signed in' } }) }), /not signed in/);
  assert.deepEqual(readAgentSettings(env), original);
  const result = await configureAgent({ provider: 'codex', env, runner: async input => {
    assert.equal(input.agentSettings.model, 'gpt-6-astra');
    assert.notEqual(input.env.COVE_DB_PATH, env.COVE_DB_PATH);
    return { ok: true };
  } });
  assert.equal(readAgentSettings(env).model, result.model);
  await assert.rejects(configureAgent({ provider: 'claude', env, runner: async () => {
    writeFileSync(path.join(dir, 'agent-settings.json'), JSON.stringify(original));
    return { ok: true };
  } }), /settings changed/);
  assert.deepEqual(readAgentSettings(env), original);
});


test('an explicitly absent selection does not adopt a provider during an in-flight legacy call', async (t) => {
  const { env } = fixture(t, 'codex');
  const calls = [];
  const result = await runJob({ lane: 'legacy-review', kind: 'structured', prompt: 'Review', schema, env,
    agentSettings: undefined, backend: 'claude', spawnImpl: fakeSpawn(calls, []) });
  assert.equal(result.ok, true);
  assert.ok(calls[0].args.includes('claude-opus-5'));
  assert.equal(readBackgroundUsage(env).windows.day.calls, 0);
});


test('a misspelled usage limit fails instead of silently retaining a higher default', () => {
  assert.throws(() => validateAgentSettings({ version: 1, ...RECOMMENDED_AGENTS.claude,
    backgroundLimits: { callsPerday: 1 } }), /documented limit names/);
});
