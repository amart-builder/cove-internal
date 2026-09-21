import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openLocalDatabase } from '../src/lib/local/database.ts';
import { LOCAL_MIGRATIONS } from '../src/lib/local/migrations.ts';
import { callJev, JevError, JEV_ENDPOINT, JEV_MODEL, serializeJevRequest, validateJevResponse } from '../src/lib/jev/client.ts';
import {
  expireJevLeases, findReusableJevAnswer, pruneJevLedger, readJevLedgerSummary, reserveJevAttempt, settleJevAttempt,
  JEV_ANSWER_RETENTION_MS, JEV_ATTEMPT_RETENTION_MS,
} from '../src/lib/jev/ledger.ts';
import { assessWithJev } from '../src/lib/jev/runtime.ts';
import { DEFAULT_JEV_LIMITS, jevAvailability, jevCredentialRevision, readJevSettings, validateJevSettings, writeJevSettings } from '../src/lib/jev/settings.ts';

const FIXTURES = path.resolve('fixtures/jev/wire');
const LIVE = JSON.parse(readFileSync(path.join(FIXTURES, 'choice-noul-live-20260920.json'), 'utf8'));
const E422 = JSON.parse(readFileSync(path.join(FIXTURES, 'error-422-live-20260920.json'), 'utf8'));
const E401 = JSON.parse(readFileSync(path.join(FIXTURES, 'error-401-live-20260920.json'), 'utf8'));
const KEY = 'apikey_test_0000000000000000000000000000000000000000000000000000000000000000';
const NOUL_QUESTION = { type: 'noul', instructions: 'Is the sky blue in this state?', criteria: { true: 'Blue.', false: 'Not blue.' } };

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cove-jev-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = openLocalDatabase(path.join(dir, 'cove.db'));
  t.after(() => db.close());
  return { dir, db, env: { COVE_DATA_DIR: dir, COVE_TYPESAFE_API_KEY: KEY } };
}

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const out = await handler(calls.length, init);
    if (out instanceof Response) return out;
    const { status = 200, body, headers = {} } = out;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  impl.calls = calls;
  return impl;
}

const enabled = (features) => ({ version: 1, enabled: true, features, limits: { ...DEFAULT_JEV_LIMITS } });
const limits = { ...DEFAULT_JEV_LIMITS };

test('migration 37 creates the Jev ledger and state tables in the general range', async (t) => {
  const { db } = await fixture(t);
  assert.equal(db.prepare('SELECT name FROM cove_schema_migrations WHERE version = 37').pluck().get(), 'jev-attempt-ledger');
  for (const table of ['cove_jev_attempts', 'cove_jev_state']) {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table), table);
  }
  assert.equal(LOCAL_MIGRATIONS.at(-1).version, 37);
});

test('no settings file means off, and a malformed file never enables Jev', async (t) => {
  const { dir, env } = await fixture(t);
  const settings = readJevSettings(dir, env);
  assert.equal(settings.enabled, false);
  assert.deepEqual(settings.features, {});
  assert.deepEqual(jevAvailability('task_identity', settings, env), { available: false, reason: 'disabled' });
  assert.deepEqual(jevAvailability('task_identity', enabled({}), env), { available: false, reason: 'feature_off' });
  assert.deepEqual(jevAvailability('task_identity', enabled({ task_identity: 'shadow' }), {}), { available: false, reason: 'no_key' });
  assert.deepEqual(jevAvailability('task_identity', enabled({ task_identity: 'shadow' }), env), { available: true, mode: 'shadow' });
  writeFileSync(path.join(dir, 'cove-jev.json'), '{"version":1,"enabled":true,"features":{"task_identity":"always"}}');
  assert.throws(() => readJevSettings(dir, env), /cove_jev_settings_invalid/);
  assert.throws(() => validateJevSettings({ version: 1, enabled: true, limits: { callsPerDay: 8001 } }), /cove_jev_settings_invalid/);
  assert.throws(() => validateJevSettings({ version: 1, enabled: true, limits: { attemptTimeoutMs: 7000 } }), /cove_jev_settings_invalid/);
  const written = writeJevSettings({ version: 1, enabled: true, features: { task_identity: 'shadow' }, limits: { callsPerDay: 10 } }, dir, env);
  assert.equal(written.limits.callsPerDay, 10);
  assert.equal(readJevSettings(dir, env).limits.callsPerHour, 120);
});

test('the frozen live capture passes request and response validation exactly', () => {
  const body = serializeJevRequest(LIVE.request, limits);
  assert.equal(JSON.parse(body).model, JEV_MODEL);
  const checked = validateJevResponse(LIVE.response, LIVE.request.questions);
  assert.equal(checked.answers.owner.choice, 'counterparty');
  assert.equal(checked.usage.input_tokens, LIVE.response.usage.input_tokens);
  assert.equal(E422.status, 422);
  assert.equal(E401.status, 401);
});

test('response validation rejects a different model, missing answers, bad distributions and stray labels', () => {
  const q = LIVE.request.questions;
  const good = LIVE.response;
  const fails = (mutate, pattern) => {
    const copy = structuredClone(good);
    mutate(copy);
    assert.throws(() => validateJevResponse(copy, q), pattern);
  };
  fails((r) => { r.model = 'jev-latest'; }, /pinned model/);
  fails((r) => { delete r.answers.owner; }, /answer count/);
  fails((r) => { r.answers.owner.probabilities.counterparty = 0.5; }, /sum to one/);
  fails((r) => { r.answers.owner.probabilities.extra = 0; }, /labels differ/);
  fails((r) => { r.answers.owner.choice = 'someone_else'; }, /permitted label/);
  fails((r) => { r.answers.owner.confidence = Number.NaN; }, /confidence/);
  fails((r) => { r.answers.owner.type = 'noul'; }, /type mismatch/);
  fails((r) => { delete r.usage; }, /usage/);
  assert.throws(() => validateJevResponse({ ...good, answers: { ...good.answers, owner: { type: 'choice', choice: 'operator', probabilities: { operator: 1.5, counterparty: -0.5, third_party: 0, neither: 0, unclear: 0 }, confidence: 1 } } }, q), /out of range/);
});

test('request validation bounds size, question count, ids and criteria before any network', () => {
  const state = 'x';
  assert.throws(() => serializeJevRequest({ model: 'jev-latest', state, questions: { a: NOUL_QUESTION } }, limits), /unpinned/);
  assert.throws(() => serializeJevRequest({ model: JEV_MODEL, state, questions: {} }, limits), /no questions/);
  assert.throws(() => serializeJevRequest({ model: JEV_MODEL, state, questions: { 'Bad Id': NOUL_QUESTION } }, limits), /snake_case/);
  assert.throws(() => serializeJevRequest({ model: JEV_MODEL, state, questions: { a: { type: 'choice', instructions: 'pick', criteria: { only: 'one' } } } }, limits), /between 2 and 255/);
  assert.throws(() => serializeJevRequest({ model: JEV_MODEL, state: 'y'.repeat(limits.maxRequestBytes), questions: { a: NOUL_QUESTION } }, limits), /bytes/);
  const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`q${i}`, NOUL_QUESTION]));
  assert.throws(() => serializeJevRequest({ model: JEV_MODEL, state, questions: many }, limits), /32 questions/);
});

test('the transport posts once to the fixed endpoint with the bearer key and no redirects', async () => {
  const fetchImpl = fakeFetch(() => ({ body: { model: JEV_MODEL, answers: { a: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 1 } }, headers: { 'x-typesafe-request-id': 'req_test' } }));
  const result = await callJev({ request: { model: JEV_MODEL, state: 'sky', questions: { a: NOUL_QUESTION } }, apiKey: KEY, limits, fetchImpl });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, JEV_ENDPOINT);
  assert.equal(fetchImpl.calls[0].init.redirect, 'error');
  assert.equal(fetchImpl.calls[0].init.headers.authorization, `Bearer ${KEY}`);
  assert.equal(result.response.answers.a.noul, 0.9);
  assert.equal(result.requestId, 'req_test');
});

test('HTTP outcomes map to safe codes and never echo the key or the body', async () => {
  const request = { model: JEV_MODEL, state: 'sky', questions: { a: NOUL_QUESTION } };
  const expectCode = async (out, code, extra = {}) => {
    const fetchImpl = fakeFetch(() => out);
    const error = await callJev({ request, apiKey: KEY, limits, fetchImpl }).then(() => null, (e) => e);
    assert.ok(error instanceof JevError, `expected JevError for ${code}`);
    assert.equal(error.code, code);
    assert.equal(JSON.stringify(error).includes(KEY), false);
    assert.equal(error.message.includes(KEY), false);
    assert.equal(error.message.includes('secret-body-marker'), false);
    for (const [k, v] of Object.entries(extra)) assert.equal(error[k], v, k);
  };
  await expectCode({ status: 401, body: E401.body }, 'auth', { retryable: false, httpStatus: 401 });
  await expectCode({ status: 403, body: { detail: 'secret-body-marker' } }, 'auth');
  await expectCode({ status: 422, body: E422.body }, 'contract', { retryable: false });
  await expectCode({ status: 429, body: { detail: 'slow down' }, headers: { 'retry-after': '7' } }, 'rate_limited', { retryable: true, retryAfterMs: 7000 });
  await expectCode({ status: 529, body: { detail: 'overloaded' } }, 'rate_limited');
  await expectCode({ status: 500, body: 'secret-body-marker' }, 'transient', { retryable: true });
  await expectCode({ status: 200, body: 'not json secret-body-marker' }, 'contract');
  await expectCode({ status: 200, body: { model: 'jev-9.0.0', answers: {}, usage: {} } }, 'contract');
  await expectCode(new Response('x'.repeat(limits.maxResponseBytes + 1), { status: 200, headers: { 'content-type': 'application/json' } }), 'transient');
  await expectCode(new Response('{"model":"jev-1.13.0"}', { status: 200, headers: { 'content-length': String(limits.maxResponseBytes + 1) } }), 'transient');
});

test('a slow or unreachable service is a transient failure; a parent abort is reported as aborted', async () => {
  const request = { model: JEV_MODEL, state: 'sky', questions: { a: NOUL_QUESTION } };
  const hang = fakeFetch((_n, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: init.signal.reason?.name ?? 'AbortError' })))));
  const slow = await callJev({ request, apiKey: KEY, limits: { ...limits, attemptTimeoutMs: 20 }, fetchImpl: hang }).then(() => null, (e) => e);
  assert.equal(slow.code, 'transient');
  assert.match(slow.message, /attempt timeout/);
  const controller = new AbortController();
  const pending = callJev({ request, apiKey: KEY, limits, fetchImpl: hang, signal: controller.signal }).then(() => null, (e) => e);
  controller.abort();
  assert.equal((await pending).code, 'aborted');
  const down = fakeFetch(() => { throw new TypeError('fetch failed'); });
  const unreachable = await callJev({ request, apiKey: KEY, limits, fetchImpl: down }).then(() => null, (e) => e);
  assert.equal(unreachable.code, 'transient');
  assert.equal(unreachable.retryable, true);
});

const reservation = (over = {}) => ({
  feature: 'task_identity', mode: 'shadow', lane: 'test', evidenceHash: 'e', questionHash: 'q', requestBytes: 100,
  requestedModel: JEV_MODEL, limits, credentialRevision: 'rev1', now: 1_000_000, ...over,
});

test('the ledger reserves atomically, enforces two concurrent slots and settles exactly once', async (t) => {
  const { db } = await fixture(t);
  const a = reserveJevAttempt(db, reservation());
  const b = reserveJevAttempt(db, reservation());
  const c = reserveJevAttempt(db, reservation());
  assert.equal(a.ok && b.ok, true);
  assert.deepEqual(c, { ok: false, status: 'unavailable', reason: 'busy', retryAt: 1_000_000 + limits.totalTimeoutMs });
  assert.equal(settleJevAttempt(db, a.id, { status: 'answered', answers: { a: { type: 'noul', noul: 0.2 } }, resolvedModel: JEV_MODEL, latencyMs: 12, responseBytes: 90, inputTokens: 5, outputTokens: 1 }, 1_000_100), true);
  assert.equal(settleJevAttempt(db, a.id, { status: 'unavailable', reason: 'transient' }, 1_000_200), false, 'second settlement ignored');
  const row = db.prepare('SELECT status, answers_json, input_tokens FROM cove_jev_attempts WHERE id = ?').get(a.id);
  assert.equal(row.status, 'answered');
  assert.equal(JSON.parse(row.answers_json).a.noul, 0.2);
  assert.equal(row.input_tokens, 5);
  assert.equal(reserveJevAttempt(db, reservation({ now: 1_000_300 })).ok, true, 'slot freed after settlement');
});

test('a crashed attempt is reclaimed when its lease lapses and counts as unavailable', async (t) => {
  const { db } = await fixture(t);
  const a = reserveJevAttempt(db, reservation());
  assert.equal(a.ok, true);
  const later = 1_000_000 + limits.totalTimeoutMs + 6_000;
  assert.equal(expireJevLeases(db, later), 1);
  assert.equal(db.prepare('SELECT reason FROM cove_jev_attempts WHERE id = ?').pluck().get(a.id), 'lease_expired');
  assert.equal(settleJevAttempt(db, a.id, { status: 'answered', answers: {}, resolvedModel: JEV_MODEL, latencyMs: 1, responseBytes: 1, inputTokens: 1, outputTokens: 1 }, later), false, 'a late settlement cannot resurrect it');
  const summary = readJevLedgerSummary(db, later);
  assert.equal(summary.hour.attempts, 1);
  assert.equal(summary.hour.answered, 0);
});

test('hourly and daily budgets defer with a retry time and record the deferral', async (t) => {
  const { db } = await fixture(t);
  const tight = { ...limits, callsPerHour: 2, callsPerDay: 3, concurrency: 10 };
  let now = 1_000_000;
  for (let i = 0; i < 2; i += 1) {
    const r = reserveJevAttempt(db, reservation({ limits: tight, now }));
    assert.equal(r.ok, true);
    settleJevAttempt(db, r.id, { status: 'unavailable', reason: 'transient' }, now + 1);
    now += 10;
  }
  const third = reserveJevAttempt(db, reservation({ limits: tight, now }));
  assert.equal(third.ok, false);
  assert.equal(third.status, 'budget_deferred');
  assert.equal(third.retryAt, 1_000_000 + 3_600_000 + 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM cove_jev_attempts WHERE status = 'budget_deferred'").pluck().get(), 1);
  const nextHour = 1_000_000 + 3_600_001 + 5;
  const fourth = reserveJevAttempt(db, reservation({ limits: tight, now: nextHour }));
  assert.equal(fourth.ok, true);
  settleJevAttempt(db, fourth.id, { status: 'unavailable', reason: 'transient' }, nextHour + 1);
  const dayBlocked = reserveJevAttempt(db, reservation({ limits: tight, now: nextHour + 3_600_100 }));
  assert.equal(dayBlocked.ok, false);
  assert.equal(dayBlocked.status, 'budget_deferred');
});

test('401 disables Jev until the credential revision changes; five transient failures open the breaker', async (t) => {
  const { db } = await fixture(t);
  const a = reserveJevAttempt(db, reservation());
  settleJevAttempt(db, a.id, { status: 'unavailable', reason: 'auth', httpStatus: 401, credentialRevision: 'rev1' }, 1_000_001);
  assert.deepEqual(reserveJevAttempt(db, reservation({ now: 1_000_002 })), { ok: false, status: 'unavailable', reason: 'auth_blocked' });
  assert.equal(readJevLedgerSummary(db, 1_000_002).authBlocked, true);
  const rotated = reserveJevAttempt(db, reservation({ now: 1_000_003, credentialRevision: 'rev2' }));
  assert.equal(rotated.ok, true, 'a new key clears the block');
  settleJevAttempt(db, rotated.id, { status: 'unavailable', reason: 'transient' }, 1_000_004);
  let now = 1_000_010;
  for (let i = 0; i < 4; i += 1) {
    const r = reserveJevAttempt(db, reservation({ now, credentialRevision: 'rev2' }));
    assert.equal(r.ok, true, `attempt ${i}`);
    settleJevAttempt(db, r.id, { status: 'unavailable', reason: 'transient' }, now + 1);
    now += 10;
  }
  const cooled = reserveJevAttempt(db, reservation({ now, credentialRevision: 'rev2' }));
  assert.equal(cooled.ok, false);
  assert.equal(cooled.reason, 'cooldown');
  assert.equal(cooled.retryAt, 1_000_041 + 5 * 60_000);
  assert.equal(reserveJevAttempt(db, reservation({ now: cooled.retryAt + 1, credentialRevision: 'rev2' })).ok, true);
  const long = reserveJevAttempt(db, reservation({ now: cooled.retryAt + 2, credentialRevision: 'rev2' }));
  settleJevAttempt(db, long.id, { status: 'unavailable', reason: 'rate_limited', httpStatus: 429, retryAfterMs: 20 * 60_000 }, cooled.retryAt + 3);
  const waiting = reserveJevAttempt(db, reservation({ now: cooled.retryAt + 4, credentialRevision: 'rev2' }));
  assert.equal(waiting.reason, 'cooldown');
  assert.equal(waiting.retryAt, cooled.retryAt + 3 + 20 * 60_000, 'a longer Retry-After is respected');
});

test('exact-key reuse returns a stored answer and honours a freshness bound; retention prunes detail then rows', async (t) => {
  const { db } = await fixture(t);
  const r = reserveJevAttempt(db, reservation({ reuseKey: 'k1' }));
  settleJevAttempt(db, r.id, { status: 'answered', answers: { a: { type: 'noul', noul: 0.7 } }, resolvedModel: JEV_MODEL, latencyMs: 1, responseBytes: 1, inputTokens: 1, outputTokens: 1 }, 1_000_050);
  assert.equal(findReusableJevAnswer(db, 'k1', 1_000_060).answers.a.noul, 0.7);
  assert.equal(findReusableJevAnswer(db, 'k2', 1_000_060), undefined);
  assert.equal(findReusableJevAnswer(db, 'k1', 1_000_050 + 1000, 500), undefined, 'stale under a freshness bound');
  const pruned = pruneJevLedger(db, 1_000_000 + JEV_ANSWER_RETENTION_MS + 1);
  assert.deepEqual(pruned, { answersCleared: 1, rowsDeleted: 0 });
  assert.equal(findReusableJevAnswer(db, 'k1', 1_000_000 + JEV_ANSWER_RETENTION_MS + 2), undefined);
  assert.deepEqual(pruneJevLedger(db, 1_000_000 + JEV_ATTEMPT_RETENTION_MS + 1), { answersCleared: 0, rowsDeleted: 1 });
});

test('assessWithJev is skipped without settings or a key and never calls the transport', async (t) => {
  const { db, dir } = await fixture(t);
  const fetchImpl = fakeFetch(() => { throw new Error('must not be called'); });
  const base = { db, feature: 'task_identity', lane: 'test', state: 'sky', questions: { a: NOUL_QUESTION }, fetchImpl, dataDir: dir };
  assert.deepEqual(await assessWithJev({ ...base, env: { COVE_TYPESAFE_API_KEY: KEY } }), { status: 'skipped', reason: 'disabled' });
  assert.deepEqual(await assessWithJev({ ...base, env: {}, settings: enabled({ task_identity: 'shadow' }) }), { status: 'skipped', reason: 'no_key' });
  assert.deepEqual(await assessWithJev({ ...base, env: { COVE_TYPESAFE_API_KEY: KEY }, settings: enabled({ email_meaning: 'shadow' }) }), { status: 'skipped', reason: 'feature_off' });
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM cove_jev_attempts').pluck().get(), 0);
});

test('assessWithJev answers through the ledger, reuses exactly, and records failures without the key', async (t) => {
  const { db, env } = await fixture(t);
  let clock = 5_000_000;
  const now = () => clock;
  const fetchImpl = fakeFetch((n) => {
    if (n === 1) return { body: { model: JEV_MODEL, answers: { a: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 40, output_tokens: 2 } } };
    if (n === 2) return { status: 401, body: E401.body };
    return { status: 500, body: 'boom' };
  });
  const base = { db, env, feature: 'task_identity', lane: 'test', subject: { kind: 'task', id: 't1', version: '3' }, state: { title: 'sky' }, questions: { a: NOUL_QUESTION }, fetchImpl, now, settings: enabled({ task_identity: 'shadow' }), reuse: { scopeVersion: 1 } };
  const first = await assessWithJev(base);
  assert.equal(first.status, 'answered');
  assert.equal(first.reused, false);
  assert.equal(first.answers.a.noul, 0.8);
  clock += 100;
  const again = await assessWithJev(base);
  assert.equal(again.status, 'answered');
  assert.equal(again.reused, true);
  assert.equal(again.attemptId, first.attemptId);
  assert.equal(fetchImpl.calls.length, 1, 'exact reuse makes no call');
  clock += 100;
  const changed = await assessWithJev({ ...base, state: { title: 'sea' } });
  assert.equal(changed.status, 'unavailable');
  assert.equal(changed.reason, 'auth');
  clock += 100;
  const blocked = await assessWithJev({ ...base, state: { title: 'lake' } });
  assert.deepEqual(blocked, { status: 'unavailable', reason: 'auth_blocked', retryAt: undefined });
  assert.equal(fetchImpl.calls.length, 2);
  const state = JSON.stringify(db.prepare('SELECT * FROM cove_jev_state').all());
  assert.equal(state.includes(KEY), false);
  assert.equal(state.includes(jevCredentialRevision(env)), true, 'only a fingerprint of the key is kept');
  assert.equal(jevCredentialRevision(env).length, 16);
  const rotated = { ...env, COVE_TYPESAFE_API_KEY: `${KEY}2` };
  clock += 100;
  const after = await assessWithJev({ ...base, env: rotated, state: { title: 'lake' } });
  assert.equal(after.status, 'unavailable');
  assert.equal(after.reason, 'transient');
  assert.equal(fetchImpl.calls.length, 3);
  const dump = JSON.stringify(db.prepare('SELECT * FROM cove_jev_attempts').all()) + JSON.stringify(db.prepare('SELECT * FROM cove_jev_state').all());
  assert.equal(dump.includes(KEY), false, 'the ledger never stores the key');
  assert.equal(dump.includes('sky'), false, 'the ledger never stores evidence text');
  const invalid = await assessWithJev({ ...base, env: rotated, questions: { 'Bad Id': NOUL_QUESTION } });
  assert.deepEqual(invalid, { status: 'invalid', reason: 'request_invalid' });
});

test('model child processes never inherit the TypeSafe key', async () => {
  const { minimalJobEnvironment } = await import('../src/lib/model-runner-runtime.mjs');
  const child = minimalJobEnvironment({ PATH: '/bin', HOME: '/tmp', COVE_TYPESAFE_API_KEY: KEY, FORGE_TYPESAFE_API_KEY: KEY });
  assert.equal(Object.values(child).some((v) => typeof v === 'string' && v.includes(KEY)), false);
  assert.equal(Object.keys(child).some((k) => k.includes('TYPESAFE')), false);
});
