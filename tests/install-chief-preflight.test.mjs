import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Execute the installer's real prerequisite phase only. No launchctl, compiler,
// notification helper, or installed user configuration may run in this test.
const installer = readFileSync(new URL('../scripts/install-cove-local.sh', import.meta.url), 'utf8');
const boundary = installer.indexOf('CODEX_PLIST_ENTRY=""');
assert.ok(boundary > 0 && boundary < installer.indexOf('NOTIFICATION_ICON_PATH='));

function preflight(t, { enabled = true, codex = true, claude = true, provider, mandate } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cove-install-prereqs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const folder of ['scripts/lib', 'src/lib', 'node_modules/.bin', 'data', 'home']) {
    mkdirSync(path.join(root, folder), { recursive: true });
  }
  copyFileSync(new URL('../scripts/lib/load-local-env.mjs', import.meta.url), path.join(root, 'scripts/lib/load-local-env.mjs'));
  for (const name of ['agent-settings.mjs', 'operator-runtime.mjs', 'env-runtime.mjs']) copyFileSync(new URL(`../src/lib/${name}`, import.meta.url), path.join(root, 'src/lib', name));
  symlinkSync('/usr/bin/true', path.join(root, 'node_modules/.bin/next'));
  symlinkSync('/usr/bin/true', path.join(root, 'node_modules/.bin/tsx'));
  writeFileSync(path.join(root, 'scripts/install-cove-local.sh'), `${installer.slice(0, boundary)}\necho prerequisite-phase-passed\n`);
  writeFileSync(path.join(root, '.env.local'), enabled === null ? '' : `COVE_CHIEF_OF_STAFF=${enabled ? '1' : '0'}\n`);
  if (provider) writeFileSync(path.join(root, 'data/agent-settings.json'), JSON.stringify({ version: 1, provider, model: provider === 'codex' ? 'gpt-6-astra' : 'claude-fable-5-1', effort: 'low' }));
  if (mandate !== undefined) writeFileSync(path.join(root, 'data/cove-mandate.md'), mandate);
  return spawnSync('/bin/bash', [path.join(root, 'scripts/install-cove-local.sh')], {
    encoding: 'utf8',
    env: {
      HOME: path.join(root, 'home'),
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      COVE_JOB_RUNNER: 'claude',
      COVE_CLAUDE_BIN: claude ? '/usr/bin/true' : path.join(root, 'absent-claude'),
      COVE_CODEX_BIN: codex ? '/usr/bin/true' : path.join(root, 'absent-codex'),
    },
  });
}

test('requested chief of staff stops before installation when Codex is missing', (t) => {
  const result = preflight(t, { codex: false, mandate: '# Personal mandate\n' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Chief of staff was requested but Codex CLI is missing/);
  assert.doesNotMatch(result.stdout, /prerequisite-phase-passed/);
});

for (const mandate of [undefined, '']) {
  test(`requested chief of staff stops when mandate is ${mandate === undefined ? 'missing' : 'empty'}`, (t) => {
    const result = preflight(t, { mandate });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /mandate.md is missing or empty/);
  });
}

test('Claude-only baseline does not require optional chief-of-staff prerequisites', (t) => {
  const result = preflight(t, { enabled: false, codex: false });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /prerequisite-phase-passed/);
});

test('requested chief of staff with prerequisites reaches the next installer phase', (t) => {
  const result = preflight(t, { mandate: '# Personal mandate\n' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /prerequisite-phase-passed/);
});

for (const provider of ['claude', 'codex']) {
  test(`full ${provider} setup needs only its selected CLI and defaults chief on`, (t) => {
    const result = preflight(t, { provider, enabled: null, claude: provider === 'claude', codex: provider === 'codex', mandate: '# Personal mandate\n' });
    assert.equal(result.status, 0, result.stderr);
    const missing = preflight(t, { provider, enabled: null, claude: provider === 'claude', codex: provider === 'codex' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /mandate.md is missing or empty/);
  });
}
