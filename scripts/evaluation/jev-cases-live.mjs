#!/usr/bin/env node
/** Live scoring for the Jev judgment fixtures.
 * Sends the fictional prepared requests through the production client and
 * scores the answers against the expected file. Opens no database, reads no
 * Cove data; the only thing sent is fixtures/jev/cases.json content.
 *
 *   node --import tsx scripts/evaluation/jev-cases-live.mjs \
 *     --prepared <dir from jev-cases.mjs> --output <new dir> [--lane <id>] [--concurrency 2]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalEnv } from '../lib/load-local-env.mjs';
import { callJev, JevError } from '../../src/lib/jev/client.ts';
import { DEFAULT_JEV_LIMITS, jevApiKey } from '../../src/lib/jev/settings.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
const fail = (message, code = 1) => { console.error(message); process.exit(code); };

const prepared = option('--prepared');
const outputArg = option('--output');
if (!prepared || !outputArg) fail('Required: --prepared <dir> --output <new dir> [--lane <id>] [--concurrency 2]');
const output = path.resolve(outputArg);
if (existsSync(output)) fail('Results directory must be new; previous results must remain visible.');
const laneFilter = option('--lane');
const concurrency = Math.max(1, Math.min(4, Number(option('--concurrency', 2)) || 2));

loadLocalEnv(root);
const apiKey = jevApiKey();
if (!apiKey) fail('COVE_TYPESAFE_API_KEY is not set. Put it in the ignored mode-0600 .env.local before live scoring.', 2);
const limits = { ...DEFAULT_JEV_LIMITS, attemptTimeoutMs: 15_000 };

const lanes = readdirSync(prepared).filter(f => f.endsWith('.prepared.json')).map(f => f.replace('.prepared.json', ''))
  .filter(lane => !laneFilter || lane === laneFilter);
if (!lanes.length) fail('No prepared lanes found.');
mkdirSync(output, { recursive: true, mode: 0o700 });
const save = (name, value) => writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

const NOUL_YES = 0.65, NOUL_NO = 0.35;
function judge(expected, answer) {
  if (answer.type === 'choice') return { ok: answer.choice === expected, got: `${answer.choice} (${answer.confidence.toFixed(2)})` };
  const p = answer.noul;
  const ok = expected === 'yes' ? p >= NOUL_YES : expected === 'no' ? p <= NOUL_NO : p > NOUL_NO && p < NOUL_YES;
  return { ok, got: p.toFixed(2) };
}

const timings = [];
let totalRequests = 0, totalInputTokens = 0, totalJudgments = 0, correctJudgments = 0;
const summary = {};
for (const lane of lanes) {
  const prep = JSON.parse(readFileSync(path.join(prepared, `${lane}.prepared.json`), 'utf8'));
  const expected = new Map(JSON.parse(readFileSync(path.join(prepared, `${lane}.expected.json`), 'utf8')).cases.map(c => [c.id, c.expected]));
  const rows = [];
  const perQuestion = {};
  const queue = [...prep.requests];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const item = queue.shift();
      totalRequests += 1;
      let result;
      try {
        result = await callJev({ request: item.request, apiKey, limits });
      } catch (error) {
        const code = error instanceof JevError ? error.code : 'unexpected';
        rows.push({ id: item.id, split: item.split, status: 'unevaluated', error: code, httpStatus: error.httpStatus ?? null });
        continue;
      }
      timings.push(result.latencyMs);
      totalInputTokens += result.response.usage.input_tokens;
      const misses = [];
      const got = {};
      for (const [question, label] of Object.entries(expected.get(item.id))) {
        const verdict = judge(label, result.response.answers[question]);
        got[question] = verdict.got;
        perQuestion[question] ??= { correct: 0, total: 0 };
        perQuestion[question].total += 1;
        totalJudgments += 1;
        if (verdict.ok) { perQuestion[question].correct += 1; correctJudgments += 1; } else misses.push({ question, expected: label, got: verdict.got });
      }
      rows.push({ id: item.id, split: item.split, status: misses.length ? 'miss' : 'pass', latencyMs: result.latencyMs, inputTokens: result.response.usage.input_tokens, got, misses, requestId: result.requestId ?? null });
    }
  }));
  rows.sort((a, b) => a.id.localeCompare(b.id));
  const bySplit = split => rows.filter(r => r.split === split);
  const passes = list => `${list.filter(r => r.status === 'pass').length}/${list.length}`;
  summary[lane] = { questionSetVersion: prep.questionSetVersion, questionHash: prep.questionHash, development: passes(bySplit('development')), heldout: passes(bySplit('heldout')), perQuestion, unevaluated: rows.filter(r => r.status === 'unevaluated').length };
  save(`${lane}.results.json`, { lane, model: prep.model, questionSetVersion: prep.questionSetVersion, questionHash: prep.questionHash, rows });
  console.log(`${lane}: development ${summary[lane].development} fully correct, heldout ${summary[lane].heldout}; ${Object.entries(perQuestion).map(([q, v]) => `${q} ${v.correct}/${v.total}`).join(', ')}${summary[lane].unevaluated ? `; ${summary[lane].unevaluated} unevaluated` : ''}`);
  for (const row of rows.filter(r => r.status !== 'pass')) {
    console.log(`  ${row.status === 'unevaluated' ? 'UNEVALUATED' : 'MISS'} ${row.id} [${row.split}] ${row.error ?? row.misses.map(m => `${m.question}: expected ${m.expected}, got ${m.got}`).join(' | ')}`);
  }
}
timings.sort((a, b) => a - b);
const pct = q => timings.length ? timings[Math.floor((timings.length - 1) * q)] : null;
const totals = { requests: totalRequests, evaluated: timings.length, inputTokens: totalInputTokens, judgments: { correct: correctJudgments, total: totalJudgments }, latencyMs: { p50: pct(0.5), p90: pct(0.9), max: pct(1) } };
save('manifest.json', { kind: 'jev-live-score', createdAt: new Date().toISOString(), preparedDir: path.resolve(prepared), model: 'jev-1.13.0', noulThresholds: { yes: NOUL_YES, no: NOUL_NO }, lanes: summary, totals, limits: ['Fictional fixture cases only', 'No database opened', 'No Cove data read', 'A score measures these question sets, not Cove'] });
console.log(`\nrequests ${totals.requests}, evaluated ${totals.evaluated}, judgments ${correctJudgments}/${totalJudgments}, input tokens ${totalInputTokens}, latency ms p50 ${totals.latencyMs.p50} p90 ${totals.latencyMs.p90} max ${totals.latencyMs.max}`);
