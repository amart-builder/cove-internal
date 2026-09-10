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
  assert.equal(result.error.code, 'runner_input_too_large');
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
  assert.equal(result.error.code, 'runner_input_too_large');
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
      try { reserveBackgroundAttempt({env:${JSON.stringify(env)},settings:${JSON.stringify(settings)},lane:'chief-of-staff-race',inputBytes:1}); }
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

test('routine calls cannot consume the chief and brief reserve, and reset time respects every rolling window',t=>{
 const {env,settings}=fixture(t,'codex',{callsPerHour:4,callsPerDay:8,callsPerWeek:16});const now=Date.now();
 for(let i=0;i<3;i++)reserveBackgroundAttempt({env,settings,lane:'email-triage',inputBytes:1,now:now+i});
 assert.throws(()=>reserveBackgroundAttempt({env,settings,lane:'email-triage',inputBytes:1,now:now+5}),/cove_budget_retry_at=/);
 assert.doesNotThrow(()=>reserveBackgroundAttempt({env,settings,lane:'chief-of-staff',inputBytes:1,now:now+6}));
 let reset;try{reserveBackgroundAttempt({env,settings,lane:'brief',inputBytes:1,now:now+7});}catch(e){reset=e.retryAt;}
 assert.equal(reset,new Date(now+3600001).toISOString());
 assert.doesNotThrow(()=>reserveBackgroundAttempt({env,settings,lane:'brief',inputBytes:1,now:Date.parse(reset)}));
});

for (const provider of ['claude', 'codex']) {
  test(`${provider} daily planning reads a large context and writes a long result despite background exhaustion`, async t => {
    const { env, settings } = fixture(t, provider, { callsPerDay: 2, inputBytesPerCall: 20, outputBytesPerCall: 20 });
    const now = Date.now();
    for (let i = 0; i < 2; i++) reserveBackgroundAttempt({ env, settings, lane: 'chief-of-staff', inputBytes: 1, now: now - i });
    const calls = [];
    const answer = 'Relevant detail. '.repeat(6000);
    const result = await runJob({ lane: 'morning-brief', kind: 'structured', prompt: 'Context '.repeat(15000), schema, env,
      codexPath: process.execPath, claudePath: process.execPath, spawnImpl: fakeSpawn(calls, [{ answer }]) });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.equal(result.value.answer, answer);
    assert.equal(calls.length, 1);
    const usage = readBackgroundUsage(env, Date.now(), settings);
    assert.equal(usage.pools.background.windows.day.calls, 2);
    assert.equal(usage.pools.planning.windows.day.calls, 1);
    assert.ok(usage.availability.chiefRetryAt);
    assert.equal(usage.availability.planningRetryAt, null);
  });
}

test('planning exhaustion cannot stop monitoring, and similarly named jobs do not get planning privileges', t => {
  const { env, settings } = fixture(t, 'claude', { callsPerDay: 2, inputBytesPerCall: 10 });
  const now = Date.now();
  for (const lane of ['morning-brief', 'day-dump']) reserveBackgroundAttempt({ env, settings, lane, inputBytes: 100000, now });
  assert.throws(() => reserveBackgroundAttempt({ env, settings, lane: 'morning-brief', inputBytes: 1, now }), /background_usage_limit/);
  assert.doesNotThrow(() => reserveBackgroundAttempt({ env, settings, lane: 'email-classifier', inputBytes: 1, now }));
  assert.throws(() => reserveBackgroundAttempt({ env, settings, lane: 'morning-brief-review', inputBytes: 100000, now }), /background_input_limit/);
});

test('planning retries count and return their own durable retry time', async t => {
  const { env } = fixture(t, 'claude', { callsPerDay: 1 });
  const calls = [];
  const result = await runJob({ lane: 'morning-brief', kind: 'structured', prompt: 'Review', schema, env,
    spawnImpl: fakeSpawn(calls, [{ wrong: true }]) });
  assert.equal(result.error.code, 'runner_budget_exceeded');
  assert.ok(Date.parse(result.error.retryAt) > Date.now());
  assert.equal(calls.length, 1);
});

test('long Codex diagnostic chatter cannot kill a valid brief artifact', async t => {
  const { env } = fixture(t, 'codex');
  const calls = [];
  const normal = fakeSpawn(calls, []);
  const result = await runJob({ lane: 'morning-brief', kind: 'structured', prompt: 'Review', schema, env,
    codexPath: process.execPath, spawnImpl: (...args) => {
      const child = normal(...args);
      child.stdin.prependListener('finish', () => child.stdout.write('x'.repeat(5 * 1024 * 1024) + '\n'));
      return child;
    } });
  assert.equal(result.ok, true);
  assert.equal(readBackgroundUsage(env).windows.day.outputTokens, 20);
});

for (const provider of ['claude', 'codex']) {
  test(`${provider} planning retains a technical output safety boundary`, async t => {
    const { env } = fixture(t, provider);
    const calls = [];
    const normal = fakeSpawn(calls, [{ answer: 'x'.repeat(4 * 1024 * 1024) }]);
    const result = await runJob({ lane: 'morning-brief', kind: 'structured', prompt: 'Review', schema, env,
      codexPath: process.execPath, claudePath: process.execPath, spawnImpl: normal });
    assert.equal(result.error.code, 'runner_output_too_large');
    assert.equal(readBackgroundUsage(env).recent[0].status, 'failed');
  });
}

test('planning and chief reviews keep their own deadlines while monitoring uses its shorter timeout', async t => {
  const { env } = fixture(t, 'claude', { timeoutMs: 10 });
  const delayedSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    let timer;
    child.kill = () => { clearTimeout(timer); queueMicrotask(() => child.emit('close', null, 'SIGTERM')); };
    child.stdin.on('finish', () => { timer = setTimeout(() => {
      child.stdout.write(JSON.stringify({ structured_output: { answer: 'done' } }));
      child.emit('close', 0, null);
    }, 60); });
    return child;
  };
  const planning = await runJob({ lane: 'morning-brief', kind: 'structured', prompt: 'Review', schema, env, timeoutMs: 500, spawnImpl: delayedSpawn });
  assert.equal(planning.ok, true);
  const chief = await runJob({ lane: 'chief-of-staff', kind: 'structured', prompt: 'Review', schema, env, timeoutMs: 500, spawnImpl: delayedSpawn });
  assert.equal(chief.ok, true);
  const monitoring = await runJob({ lane: 'test', kind: 'structured', prompt: 'Review', schema, env, timeoutMs: 500, spawnImpl: delayedSpawn });
  assert.equal(monitoring.error.code, 'runner_timeout');
});

test('connecting both preserves primary and exact models; switching keeps limits and failed probes keep all settings', async t => {
  const { env, dir, settings } = fixture(t, 'claude', { callsPerDay: 35 });
  const { connectedAgents, setPrimaryAgent, agentProviderStatus } = await import('../src/lib/agent-settings.mjs');
  assert.deepEqual(agentProviderStatus(readAgentSettings(env)).connectedProviders, ['claude']);
  assert.throws(() => setPrimaryAgent('codex', env), /Connect and verify/);
  const connected = await configureAgent({ provider: 'codex', model: 'gpt-6-astra', effort: 'high', makePrimary: false, env, runner: async () => ({ ok: true }) });
  assert.equal(connected.provider, 'claude');
  assert.deepEqual(Object.keys(connectedAgents(connected)).sort(), ['claude', 'codex']);
  const switched = setPrimaryAgent('codex', env);
  assert.equal(switched.model, 'gpt-6-astra'); assert.equal(switched.effort, 'high');
  assert.deepEqual(switched.backgroundLimits, settings.backgroundLimits);
  assert.equal(setPrimaryAgent('claude', env).model, settings.model);
  const before = readFileSync(path.join(dir, 'agent-settings.json'), 'utf8');
  await assert.rejects(configureAgent({ provider: 'codex', model: 'gpt-unavailable', makePrimary: false, env, runner: async () => ({ ok: false, error: { message: 'denied' } }) }), /Settings were not changed/);
  assert.equal(readFileSync(path.join(dir, 'agent-settings.json'), 'utf8'), before);
  assert.throws(() => validateAgentSettings({ ...switched, providers: { claude: switched.providers.claude } }), /must match a connected/);
});
