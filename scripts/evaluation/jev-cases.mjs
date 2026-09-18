#!/usr/bin/env node
/** Offline prepare/validate runner for the Jev judgment fixtures (W0).
 * It checks fixture integrity and writes the exact request bodies a later
 * live runner would send. It never calls the network, never reads a key,
 * never opens a database and never invokes a model. Expected answers are
 * written to a separate file so they can never leak into a request.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const MODEL = 'jev-1.13.0';
const MAX_STATE_BYTES = 24 * 1024;
const MAX_QUESTIONS_PER_LANE = 32;
const SOURCE_FILES = [
  'src/lib/chief-of-staff/daily-planning.ts',
  'src/lib/chief-of-staff/planning-time-text.ts',
  'src/lib/day-plan/planning.ts',
  'src/lib/email/classification-job.ts',
  'src/lib/email/classifier.ts',
  'src/lib/email/automation.ts',
  'src/lib/responsibility/store.ts',
  'src/lib/chief-of-staff/driver.ts',
  'src/lib/model-runner-runtime.mjs',
  'scripts/evaluation/jev-cases.mjs',
];

if (args.includes('--live') || args.includes('--run')) {
  console.error('Live Jev evaluation is not implemented in this runner. It requires separate activation (a later work package) with its own key, network and storage boundaries.');
  process.exit(2);
}
function option(key, fallback) {
  const i = args.indexOf(key);
  return i < 0 ? fallback : args[i + 1];
}
const outputArg = option('--output');
if (!outputArg) fail('Required: --output <new-results-directory> [--cases file.json] [--lane <id>]');
const output = path.resolve(outputArg);
if (existsSync(output)) fail('Results directory must be new; previous results must remain visible.');
const casesFile = path.resolve(option('--cases', path.join(root, 'fixtures/jev/cases.json')));
const laneFilter = option('--lane');
// Never inherit operator file selections, even though nothing here opens them.
for (const key of Object.keys(process.env)) if (key.startsWith('COVE_') || key.startsWith('FORGE_')) delete process.env[key];

const fixtureBytes = readFileSync(casesFile);
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
const problems = validate(fixture);
if (laneFilter && !fixture.lanes.some(lane => lane.id === laneFilter)) problems.push(`No lane named ${laneFilter}.`);
if (problems.length) fail(problems.map(p => `- ${p}`).join('\n'));

mkdirSync(output, { recursive: true, mode: 0o700 });
const save = (name, value) => writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const laneSummaries = [];
for (const lane of fixture.lanes) {
  if (laneFilter && lane.id !== laneFilter) continue;
  const questionHash = hash(canonical(lane.questions));
  const cases = [...lane.development, ...lane.heldout];
  const requests = cases.map(c => ({
    id: c.id, split: c.split, stateHash: hash(canonical(c.state)),
    request: { model: MODEL, state: c.state, questions: lane.questions },
  }));
  save(`${lane.id}.prepared.json`, { lane: lane.id, questionSetVersion: lane.questionSetVersion, questionHash, model: MODEL, requests });
  save(`${lane.id}.expected.json`, { lane: lane.id, questionSetVersion: lane.questionSetVersion, questionHash, cases: cases.map(c => ({ id: c.id, split: c.split, expected: c.expected, notes: c.notes })) });
  const summary = {
    id: lane.id, questionSetVersion: lane.questionSetVersion, questionHash, questionCount: Object.keys(lane.questions).length,
    counts: { development: lane.development.length, heldout: lane.heldout.length },
  };
  laneSummaries.push(summary);
  console.log(`${lane.id}: ${summary.counts.development} development, ${summary.counts.heldout} heldout, ${summary.questionCount} questions, questionHash ${questionHash.slice(0, 12)}. No model invoked.`);
}
save('manifest.json', {
  kind: 'jev-offline-prepare', createdAt: new Date().toISOString(), model: MODEL,
  fixtureFile: path.relative(root, casesFile), fixtureHash: hash(fixtureBytes), fixtureVersion: fixture.version,
  laneSelection: laneFilter ?? 'all', lanes: laneSummaries,
  sourceHashes: Object.fromEntries(SOURCE_FILES.map(f => [f, hash(readFileSync(path.join(root, f)))])),
  limits: ['No network access', 'No API key read or required', 'No live storage opened', 'No model invoked', 'Fixture integrity and request shape only; no accuracy claim'],
});

function validate(f) {
  const out = [];
  if (f?.version !== 1 || !Array.isArray(f.lanes) || !f.lanes.length) return ['Fixture must be { version: 1, lanes: [...] } with at least one lane.'];
  const laneIds = new Set();
  const caseIds = new Set();
  for (const lane of f.lanes) {
    const where = `lane ${lane?.id ?? '(missing id)'}`;
    if (typeof lane.id !== 'string' || !/^[a-z0-9-]+$/.test(lane.id)) out.push(`${where}: id must be a safe slug.`);
    if (laneIds.has(lane.id)) out.push(`${where}: duplicate lane id.`);
    laneIds.add(lane.id);
    if (!Number.isSafeInteger(lane.questionSetVersion) || lane.questionSetVersion < 1) out.push(`${where}: questionSetVersion must be a positive integer.`);
    const questions = lane.questions;
    if (!questions || typeof questions !== 'object' || Array.isArray(questions)) { out.push(`${where}: questions must be an object.`); continue; }
    const keys = Object.keys(questions);
    if (!keys.length) out.push(`${where}: at least one question is required.`);
    if (keys.length > MAX_QUESTIONS_PER_LANE) out.push(`${where}: at most ${MAX_QUESTIONS_PER_LANE} questions per lane.`);
    for (const [key, q] of Object.entries(questions)) {
      const qw = `${where} question ${key}`;
      if (!/^[a-z0-9_]+$/.test(key)) out.push(`${qw}: key must be a safe snake_case name.`);
      if (typeof q?.instructions !== 'string' || !q.instructions.trim()) out.push(`${qw}: instructions must be a non-empty string.`);
      if (!q?.criteria || typeof q.criteria !== 'object') { out.push(`${qw}: criteria must be an object.`); continue; }
      if (q.type === 'choice') {
        if (Object.keys(q.criteria).length < 2) out.push(`${qw}: choice needs at least two labels.`);
        for (const [label, text] of Object.entries(q.criteria)) if (!/^[a-z0-9_]+$/.test(label) || typeof text !== 'string' || !text.trim()) out.push(`${qw}: label ${label} must be a safe name with a description.`);
      } else if (q.type === 'noul') {
        const labels = Object.keys(q.criteria).sort().join(',');
        if (labels !== 'false,true' || typeof q.criteria.true !== 'string' || typeof q.criteria.false !== 'string') out.push(`${qw}: noul criteria must be exactly { true, false } strings.`);
      } else out.push(`${qw}: type must be choice or noul.`);
    }
    for (const split of ['development', 'heldout']) {
      if (!Array.isArray(lane[split])) { out.push(`${where}: ${split} must be an array.`); continue; }
      for (const c of lane[split]) {
        const cw = `${where} case ${c?.id ?? '(missing id)'}`;
        if (typeof c?.id !== 'string' || !/^[a-z0-9-]+$/.test(c.id)) out.push(`${cw}: id must be a safe slug.`);
        if (caseIds.has(c.id)) out.push(`${cw}: duplicate case id.`);
        caseIds.add(c.id);
        if (c.split !== split) out.push(`${cw}: split "${c.split}" does not match the ${split} array.`);
        if (!c.state || typeof c.state !== 'object' || Array.isArray(c.state) || !Object.keys(c.state).length) out.push(`${cw}: state must be a non-empty object.`);
        else if (Buffer.byteLength(JSON.stringify(c.state)) > MAX_STATE_BYTES) out.push(`${cw}: state exceeds ${MAX_STATE_BYTES} bytes.`);
        if (typeof c.notes !== 'string') out.push(`${cw}: notes must be a string.`);
        if (!c.expected || typeof c.expected !== 'object') { out.push(`${cw}: expected must be an object.`); continue; }
        for (const [key, value] of Object.entries(c.expected)) {
          const q = questions[key];
          if (!q) { out.push(`${cw}: expected names unknown question ${key}.`); continue; }
          if (q.type === 'choice' && !(typeof value === 'string' && Object.hasOwn(q.criteria ?? {}, value))) out.push(`${cw}: expected label "${value}" is not a criteria label of ${key}.`);
          if (q.type === 'noul' && !['yes', 'no', 'uncertain'].includes(value)) out.push(`${cw}: expected for noul ${key} must be yes, no or uncertain.`);
        }
        for (const key of keys) if (!Object.hasOwn(c.expected, key)) out.push(`${cw}: expected is missing an answer for ${key}.`);
      }
    }
  }
  return out;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function fail(message) { console.error(message); process.exit(1); }
