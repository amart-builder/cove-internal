import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/evaluation/working-week-state.mjs', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cove-week-harness-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function run(output, env = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', script, '--output-dir', output], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env },
  });
}
test('five real-state days conserve commitments through closeout, restart and notification interactions', t => {
  const root = fixture(t);
  // Inherited production-style paths must never be read or modified.
  const sentinel = path.join(root, 'do-not-touch.db');
  writeFileSync(sentinel, 'private database sentinel');
  const output = path.join(root, 'results');
  const result = run(output, { COVE_DB_PATH: sentinel, FORGE_DB_PATH: sentinel, COVE_DATA_DIR: root });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${readFileSync(path.join(output, 'state-results.json'), 'utf8')}`);
  const evidence = JSON.parse(readFileSync(path.join(output, 'state-results.json'), 'utf8'));
  t.after(() => rmSync(path.dirname(evidence.safety.dbPath), { recursive: true, force: true }));
  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.days.length, 5);
  assert.equal(new Set(evidence.days.map(day => day.planId)).size, 5);
  assert.deepEqual(evidence.days.map(day => day.remainingOpen), [9, 8, 7, 6, 5]);
  assert.ok(evidence.processRestarts.length >= 10);
  assert.equal(evidence.summary.failedChecks, 0);
  assert.ok(evidence.summary.passedChecks >= 25);
  assert.equal(evidence.safety.networkCalls, 0);
  assert.equal(evidence.safety.realNotificationCalls, 0);
  assert.equal(readFileSync(sentinel, 'utf8'), 'private database sentinel');
  assert.notEqual(path.dirname(evidence.safety.dbPath), root);
});
test('refuses an existing output directory or symlink before touching any state', t => {
  const root = fixture(t);
  const sentinel = path.join(root, 'sentinel'); writeFileSync(sentinel, 'preserve');
  const alias = `${root}-link`; symlinkSync(root, alias); t.after(() => rmSync(alias, { force: true }));
  for (const output of [root, alias]) {
    const result = run(output);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EEXIST/);
    assert.equal(readFileSync(sentinel, 'utf8'), 'preserve');
  }
});

test('saved-response replay persists a valid control and rejects an invalid one without creating tasks', t => {
  const root = fixture(t);
  const inputs = path.join(root, 'inputs');
  const prepareScript = fileURLToPath(new URL('../scripts/evaluation/working-week-models.mjs', import.meta.url));
  const prepare = spawnSync(process.execPath, ['--import', 'tsx', prepareScript, '--output', inputs], { encoding: 'utf8', timeout: 30000 });
  assert.equal(prepare.status, 0, prepare.stderr);
  const fixtureInput = JSON.parse(readFileSync(path.join(inputs, 'capacity-unknown.input.json'), 'utf8'));
  const wire = {
    narrativeParagraphs: ['Synthetic control response. This is not a model-quality result.'],
    actions: [{ source: fixtureInput.context.references.find(r => r.kind === 'task' && r.id === 'proposals'), proposal: null, nextAction: 'Draft scope with unresolved pricing marked.', rationale: 'Private preparation is possible before terms are agreed.', assumptions: [], owner: 'me', state: 'ready', plannedFor: null, nextCheckAt: '2026-09-15T16:00:00.000Z' }],
    watches: [], questions: [],
  };
  for (const [repeat, nextCheckAt] of [[1, '2026-09-15T16:00:00.000Z'], [2, 'after lunch']]) {
    const response = { id: `capacity-unknown.codex.${repeat}`, caseId: 'capacity-unknown', provider: 'codex', validation: repeat === 1 ? 'pass' : 'fail', wire: structuredClone(wire) };
    response.wire.actions[0].nextCheckAt = nextCheckAt;
    writeFileSync(path.join(inputs, `${response.id}.result.json`), JSON.stringify(response));
  }
  const output = path.join(root, 'roundtrip');
  const replayScript = fileURLToPath(new URL('../scripts/evaluation/working-week-roundtrip.mjs', import.meta.url));
  const replay = spawnSync(process.execPath, ['--import', 'tsx', replayScript, '--input', inputs, '--output', output], { encoding: 'utf8', timeout: 30000 });
  const report = JSON.parse(readFileSync(path.join(output, 'roundtrip-results.json'), 'utf8'));
  t.after(() => rmSync(report.safety.scratch, { recursive: true, force: true }));
  assert.equal(replay.status, 0, `${replay.stdout}\n${replay.stderr}\n${JSON.stringify(report)}`);
  assert.deepEqual(report.summary, { inspected: 2, persistedAndProjected: 1, rejectedBeforePersistence: 1, failed: 0 });
  assert.equal(report.results[0].tasksBefore, 3);
  assert.equal(report.results[0].tasksAfter, 3);
  assert.equal(report.results[0].paragraphsPreserved, 1);
  assert.equal(report.safety.blockedSideEffectAttempts, 0);
});
