import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const handoffFiles = [
  'AGENTS.md',
  'README.md',
  'SETUP.md',
  'CONFIGURATION.md',
  'scripts/install-cove-local.sh',
];

test('the public agent handoff contains no developer identity or absolute home path', () => {
  for (const relativePath of handoffFiles) {
    const text = readFileSync(path.join(root, relativePath), 'utf8');
    assert.doesNotMatch(text, /\/Users\/[A-Za-z0-9._-]+/i, relativePath);
    assert.doesNotMatch(text, /alexanderjmartin|alex(?:ander)? martin/i, relativePath);
    assert.doesNotMatch(text, /amart-builder\/cove-internal/i, relativePath);
  }
});

test('the public setup checks real release commands and keeps judgment shadowed', () => {
  const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const setup = readFileSync(path.join(root, 'SETUP.md'), 'utf8');
  const installer = readFileSync(path.join(root, 'scripts/install-cove-local.sh'), 'utf8');
  const verifyScript = readFileSync(path.join(root, 'scripts/cove-verify.mjs'), 'utf8');

  assert.equal(packageJson.scripts.verify, 'node scripts/cove-verify.mjs');
  assert.equal(
    packageJson.scripts['check:brief-writer'],
    'node scripts/cove-check-brief-writer.mjs',
  );
  assert.match(setup, /npm run verify/);
  assert.match(
    setup,
    /npm run check:brief-writer -- --expect-configured --expect-local-sources/,
  );
  assert.match(verifyScript, /process\.execPath/);
  assert.match(verifyScript, /path\.dirname\(process\.execPath\)/);
  assert.match(verifyScript, /"build", "--webpack"/);
  assert.doesNotMatch(verifyScript, /\["npx", \["tsx"/);
  assert.match(
    installer,
    /printf '%s\\n' '\{"shadow":true,"email_shadow":true\}' > "\$ATTENTION_CONFIG"/,
  );
});

test('the release gate runs the suite in the zone its fixtures were written in', () => {
  const verifyScript = readFileSync(path.join(root, 'scripts/cove-verify.mjs'), 'utf8');
  // SETUP.md Step 1 runs this gate and tells the setup agent not to start Cove
  // if it fails. Cove's wall-clock rules are asserted against fixed instants
  // written with a Pacific offset, so without a pinned zone eight tests in six
  // files fail on a Mac set to New York and a healthy install is stopped.
  // Both halves are pinned: the test step has to carry a zone, and the runner
  // has to pass a step's env through, since either alone does nothing.
  const testStep = verifyScript.match(
    /\[\s*process\.execPath,\s*\["--import", "tsx", "--test"[\s\S]*?\],\s*(\{[\s\S]*?\}),\s*\]/,
  );
  assert.ok(testStep, 'cove-verify.mjs no longer passes an environment to its test step');
  assert.match(
    testStep[1],
    /TZ: process\.env\.COVE_VERIFY_TZ \?\? "America\/Los_Angeles"/,
  );
  assert.match(verifyScript, /for \(const \[command, args, stepEnv\] of steps\)/);
  assert.match(verifyScript, /env: \{ \.\.\.process\.env, PATH: childPath, \.\.\.stepEnv \}/);
});

test('the public agent notes keep the client on the supported local runtime', () => {
  const contract = readFileSync(path.join(root, 'AGENT_CONTRACT.md'), 'utf8');
  assert.match(contract, /supported runtime is one local server and one local SQLite database/);
  assert.doesNotMatch(contract, /In a Supabase or Convex setup/);
});
