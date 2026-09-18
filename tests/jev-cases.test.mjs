import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/evaluation/jev-cases.mjs', import.meta.url));
const shippedFixture = fileURLToPath(new URL('../fixtures/jev/cases.json', import.meta.url));
const SOURCE_FILES = [
  'src/lib/chief-of-staff/daily-planning.ts', 'src/lib/chief-of-staff/planning-time-text.ts', 'src/lib/day-plan/planning.ts',
  'src/lib/email/classification-job.ts', 'src/lib/email/classifier.ts', 'src/lib/email/automation.ts',
  'src/lib/responsibility/store.ts', 'src/lib/chief-of-staff/driver.ts', 'src/lib/model-runner-runtime.mjs',
  'scripts/evaluation/jev-cases.mjs',
];
const LANES = ['commitment-meaning', 'email-triage', 'draft-correctness', 'reply-fulfillment', 'task-identity', 'planning-evidence'];

function scratch(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cove-jev-cases-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function run(extra, env = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', script, ...extra], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env } });
}
function loadFixture() { return JSON.parse(readFileSync(shippedFixture, 'utf8')); }
function writeFixture(root, fixture) {
  const file = path.join(root, 'cases.json');
  writeFileSync(file, JSON.stringify(fixture));
  return file;
}

test('shipped fixture validates and prepares every lane without expected answers in any request', t => {
  const root = scratch(t);
  const output = path.join(root, 'prepared');
  // Inherited live paths must be stripped even though nothing here opens them.
  const result = run(['--output', output], { COVE_DB_PATH: path.join(root, 'never.db'), FORGE_DB_PATH: path.join(root, 'never.db') });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const manifest = JSON.parse(readFileSync(path.join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.kind, 'jev-offline-prepare');
  assert.equal(manifest.model, 'jev-1.13.0');
  assert.match(manifest.fixtureHash, /^[0-9a-f]{64}$/);
  for (const file of SOURCE_FILES) assert.match(manifest.sourceHashes[file] ?? '', /^[0-9a-f]{64}$/, `missing sourceHash for ${file}`);
  assert.deepEqual(manifest.lanes.map(l => l.id), LANES);
  assert.ok(manifest.limits.some(l => /no network/i.test(l)));
  const fixture = loadFixture();
  for (const lane of fixture.lanes) {
    const summary = manifest.lanes.find(l => l.id === lane.id);
    assert.deepEqual(summary.counts, { development: lane.development.length, heldout: lane.heldout.length });
    assert.ok(summary.counts.development >= 6 && summary.counts.heldout >= 4, `${lane.id} has too few cases`);
    assert.equal(summary.questionSetVersion, lane.questionSetVersion);
    assert.match(summary.questionHash, /^[0-9a-f]{64}$/);
    assert.match(result.stdout, new RegExp(`^${lane.id}: .*No model invoked`, 'm'));
    const preparedText = readFileSync(path.join(output, `${lane.id}.prepared.json`), 'utf8');
    assert.ok(!preparedText.includes('"expected"'), `${lane.id} prepared file leaks expected answers`);
    assert.ok(!preparedText.includes('"notes"'), `${lane.id} prepared file leaks notes`);
    const prepared = JSON.parse(preparedText);
    assert.equal(prepared.questionHash, summary.questionHash);
    const expected = JSON.parse(readFileSync(path.join(output, `${lane.id}.expected.json`), 'utf8'));
    assert.deepEqual(prepared.requests.map(r => r.id), expected.cases.map(c => c.id));
    for (const entry of prepared.requests) {
      assert.deepEqual(Object.keys(entry.request).sort(), ['model', 'questions', 'state']);
      assert.equal(entry.request.model, 'jev-1.13.0');
      assert.deepEqual(entry.request.questions, lane.questions);
      assert.match(entry.stateHash, /^[0-9a-f]{64}$/);
      const source = [...lane.development, ...lane.heldout].find(c => c.id === entry.id);
      assert.deepEqual(entry.request.state, source.state);
      assert.equal(entry.split, source.split);
    }
    for (const c of expected.cases) for (const key of Object.keys(lane.questions)) assert.ok(Object.hasOwn(c.expected, key), `${c.id} lacks expected ${key}`);
  }
  assert.equal(readdirSync(output).length, LANES.length * 2 + 1);
});

test('--lane narrows output to one lane and the manifest records the selection', t => {
  const root = scratch(t);
  const output = path.join(root, 'one');
  const result = run(['--output', output, '--lane', 'email-triage']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(output).sort(), ['email-triage.expected.json', 'email-triage.prepared.json', 'manifest.json']);
  const manifest = JSON.parse(readFileSync(path.join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.laneSelection, 'email-triage');
  assert.deepEqual(manifest.lanes.map(l => l.id), ['email-triage']);
  const unknown = run(['--output', path.join(root, 'two'), '--lane', 'no-such-lane']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /No lane named no-such-lane/);
});

test('malformed fixtures are rejected with a non-zero exit', t => {
  const root = scratch(t);
  const variants = {
    'expected label not in criteria': f => { f.lanes[0].development[0].expected.owner = 'nobody_in_particular'; return /not a criteria label of owner/; },
    'duplicate case id': f => { f.lanes[0].development[1].id = f.lanes[0].development[0].id; return /duplicate case id/; },
    'split mismatch': f => { f.lanes[0].heldout[0].split = 'development'; return /does not match the heldout array/; },
    'expected names unknown question': f => { f.lanes[1].development[0].expected.bogus = 'yes'; return /unknown question bogus/; },
    'noul expected must be yes, no or uncertain': f => { f.lanes[1].development[0].expected.reply_needed = 'maybe'; return /must be yes, no or uncertain/; },
    'state too large': f => { f.lanes[2].development[0].state.padding = 'x'.repeat(24 * 1024); return /exceeds 24576 bytes/; },
    'too many questions': f => { for (let i = 0; i < 32; i++) f.lanes[3].questions[`extra_${i}`] = { type: 'noul', instructions: 'x', criteria: { true: 'a', false: 'b' } }; return /at most 32 questions/; },
  };
  let n = 0;
  for (const [name, mutate] of Object.entries(variants)) {
    const fixture = loadFixture();
    const pattern = mutate(fixture);
    const result = run(['--output', path.join(root, `out-${n++}`), '--cases', writeFixture(root, fixture)]);
    assert.equal(result.status, 1, `${name}: expected exit 1, got ${result.status}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, pattern, name);
  }
});

test('an existing output directory and a missing --output are refused', t => {
  const root = scratch(t);
  const existing = run(['--output', root]);
  assert.equal(existing.status, 1);
  assert.match(existing.stderr, /must be new/);
  const missing = run([]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Required: --output/);
});

test('--live and --run exit 2 because live evaluation is not implemented', t => {
  const root = scratch(t);
  for (const flag of ['--live', '--run']) {
    const result = run(['--output', path.join(root, flag.slice(2)), flag]);
    assert.equal(result.status, 2, `${flag}: ${result.stderr}`);
    assert.match(result.stderr, /not implemented/);
    assert.match(result.stderr, /separate activation/);
    assert.deepEqual(readdirSync(root), [], 'live flags must not create output');
  }
});
