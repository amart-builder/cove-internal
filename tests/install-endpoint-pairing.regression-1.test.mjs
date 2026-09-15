import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveInstallRuntime, persistInstallRuntime } from '../scripts/lib/cove-install-runtime.mjs';
import { renderLanePlist } from '../scripts/lib/render-lane-plist.mjs';
import { loadLocalEnv } from '../scripts/lib/load-local-env.mjs';
import { assertWebBaseMatchesDatabase, inboundTaskExists } from '../src/lib/intake/task-writer.ts';
import { loadEmailConfig } from '../scripts/cove-meeting-watch.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cove-installed-pair-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const selected = path.join(root, 'private & data'); mkdirSync(selected);
  writeFileSync(path.join(root, '.env.local'), `# Preserve this setting\nCOVE_DATA_DIR='${selected}'\nCOVE_BRIEF_WEB_BASE=http://127.0.0.1:4317\nCOVE_NOTIFY=0\n`);
  return { root, selected };
}
function envValue(plist, key) {
  return new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1];
}

test('installation preserves custom data and port across CLI and every rendered lane', t => {
  const f = fixture(t); writeFileSync(path.join(f.selected, 'forge.db'), 'synthetic legacy marker');
  const runtime = resolveInstallRuntime(f.root, {});
  assert.equal(runtime.port, '4317'); assert.equal(runtime.host, '127.0.0.1');
  assert.equal(runtime.dbPath, path.join(f.selected, 'forge.db'));
  persistInstallRuntime(f.root, runtime);
  const first = readFileSync(path.join(f.root, '.env.local'), 'utf8');
  persistInstallRuntime(f.root, runtime);
  assert.equal(readFileSync(path.join(f.root, '.env.local'), 'utf8'), first);
  assert.match(first, /# Preserve this setting/); assert.match(first, /COVE_NOTIFY=0/);
  const saved = loadLocalEnv(f.root, {});
  assert.equal(saved.COVE_BRIEF_WEB_BASE, runtime.webBase);
  assert.equal(saved.COVE_DB_PATH, runtime.dbPath); assert.equal(saved.COVE_DATA_DIR, f.selected);
  assert.deepEqual(resolveInstallRuntime(f.root, {}), runtime);
  for (const name of readdirSync(path.join(repo, 'scripts/launchd')).filter(name => /^com\.cove\..*\.plist$/.test(name))) {
    const rendered = renderLanePlist({ source: path.join(repo, 'scripts/launchd', name), destination: path.join(f.root, name),
      repoDir: f.root, dataDir: f.selected, homeDir: f.root, atlasRoot: f.root, nodePath: process.execPath,
      webBase: runtime.webBase, dbPath: runtime.dbPath });
    assert.equal(envValue(rendered, 'COVE_BRIEF_WEB_BASE'), runtime.webBase, name);
    assert.equal(envValue(rendered, 'COVE_DB_PATH'), xml(runtime.dbPath), name);
    assert.equal(envValue(rendered, 'COVE_DATA_DIR'), xml(f.selected), name);
    assert.doesNotMatch(rendered, /__COVE_BRIEF_WEB_BASE__|__COVE_DB_PATH__/);
  }
});

test('actual inline server, jobs, email and worker templates render the same custom endpoint', t => {
  const f = fixture(t); const runtime = resolveInstallRuntime(f.root, {});
  const installer = readFileSync(path.join(repo, 'scripts/install-cove-local.sh'), 'utf8');
  const runtimeBlock = /xml_escape\(\) \{[\s\S]*?\n\nmkdir -p/.exec(installer)?.[0].replace(/\n\nmkdir -p$/, '');
  assert.ok(runtimeBlock);
  for (const label of ['SERVER_PLIST', 'WORKER_PLIST', 'JOBS_PLIST', 'TRIAGE_PLIST', 'MINI_BRIEF_PLIST']) {
    const template = new RegExp(`cat > "\\$${label}" <<EOF\\n([\\s\\S]*?)\\nEOF`).exec(installer)?.[1];
    assert.ok(template, label);
    // Only expand the extracted XML here-document. Never execute the installer.
    const result = spawnSync('/bin/bash', ['-c', `${runtimeBlock}\ncat <<EOF\n${template}\nEOF`], { encoding: 'utf8', cwd: f.root,
      env: { PATH: '/usr/bin:/bin', COVE_DATA_DIR: runtime.dataDir, COVE_DB_PATH: runtime.dbPath, COVE_BRIEF_WEB_BASE: runtime.webBase, WEB_PORT: runtime.port, WEB_HOST: runtime.host,
        REPO_DIR: f.root, HOME: f.root, BUDDY_APP_URL: runtime.webBase } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(envValue(result.stdout, 'COVE_BRIEF_WEB_BASE'), runtime.webBase, label);
    assert.equal(envValue(result.stdout, 'COVE_DB_PATH'), xml(runtime.dbPath), label);
    if (label === 'SERVER_PLIST') assert.match(result.stdout, /<string>-p<\/string>\s*<string>4317<\/string>/);
  }
});

test('configured installed pairing passes guard while unrelated scratch without base still fails before fetch', async t => {
  const f = fixture(t); const runtime = resolveInstallRuntime(f.root, {});
  const keys = ['COVE_DATA_DIR', 'FORGE_DATA_DIR', 'COVE_DB_PATH', 'FORGE_DB_PATH', 'COVE_BRIEF_WEB_BASE', 'FORGE_BRIEF_WEB_BASE'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  for (const key of keys) delete process.env[key];
  process.env.COVE_DATA_DIR = runtime.dataDir; process.env.COVE_DB_PATH = runtime.dbPath;
  let calls = 0;
  const fetchImpl = async url => { calls++; assert.ok(String(url).startsWith(`${runtime.webBase}/`)); return Response.json([]); };
  await assert.rejects(inboundTaskExists('synthetic', { fetchImpl }), /inbound_web_base_required/);
  assert.equal(calls, 0);
  persistInstallRuntime(f.root, runtime); Object.assign(process.env, loadLocalEnv(f.root, {}));
  assert.doesNotThrow(() => assertWebBaseMatchesDatabase({ dbPath: runtime.dbPath }));
  assert.equal(await inboundTaskExists('synthetic', { fetchImpl }), false);
  assert.equal(calls, 1);
  const workspace = path.join(f.root, 'cove-workspace.json');
  writeFileSync(workspace, JSON.stringify({ provider: 'google-api', account_email: 'fixture@example.test', cove_url: 'http://127.0.0.1:3200' }));
  assert.equal(loadEmailConfig(workspace).coveUrl, runtime.webBase);
  delete process.env.COVE_BRIEF_WEB_BASE;
  assert.equal(loadEmailConfig(workspace).coveUrl, 'http://127.0.0.1:3200');
});

test('local endpoint selection accepts legacy settings and rejects remote or mismatched HTTP origins', t => {
  const f = fixture(t);
  assert.equal(resolveInstallRuntime(f.root, { COVE_BRIEF_WEB_BASE: 'http://localhost:4421' }).port, '4421');
  const empty = path.join(f.root, 'empty'); mkdirSync(empty);
  assert.equal(resolveInstallRuntime(empty, { FORGE_BRIEF_WEB_BASE: 'http://127.0.0.1:4422' }).port, '4422');
  mkdirSync(path.join(empty, 'data'));
  writeFileSync(path.join(empty, 'data/cove-workspace.json'), JSON.stringify({ cove_url: 'http://127.0.0.1:4423' }));
  assert.equal(resolveInstallRuntime(empty, {}).port, '4423');
  assert.equal(resolveInstallRuntime(empty, { COVE_BRIEF_WEB_BASE: 'http://127.0.0.1:4424' }).port, '4424');
  for (const base of ['https://localhost:4317', 'http://example.test:4317', 'http://user@localhost:4317', 'http://localhost:4317/tasks', 'http://localhost:4317?x=1']) {
    assert.throws(() => resolveInstallRuntime(f.root, { COVE_BRIEF_WEB_BASE: base }), /loopback origin/);
  }
});

test('direct intake loads the saved pairing and triage checks the selected config directory', t => {
  const f = fixture(t); const runtime = resolveInstallRuntime(f.root, {});
  persistInstallRuntime(f.root, runtime);
  for (const file of ['scripts/cove-intake.mjs', 'scripts/cove-email-triage.sh', 'scripts/lib/load-local-env.mjs',
    'scripts/lib/cove-runtime-paths.mjs', 'src/lib/env-runtime.mjs']) {
    const target = path.join(f.root, file); mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(repo, file), target);
  }
  symlinkSync(path.join(repo, 'node_modules'), path.join(f.root, 'node_modules'), 'dir');
  const stubRun = path.join(f.root, 'src/lib/intake/run.ts'); mkdirSync(path.dirname(stubRun), { recursive: true });
  writeFileSync(stubRun, `export async function runCoveIntake() {
    process.stdout.write(JSON.stringify({base:process.env.COVE_BRIEF_WEB_BASE,data:process.env.COVE_DATA_DIR}));
    return {exitCode:0}; }`);
  const env = { HOME: f.root, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` };
  const cli = spawnSync(process.execPath, [path.join(f.root, 'scripts/cove-intake.mjs'), '--source', 'chat', '--text', 'Synthetic'], {
    cwd: os.tmpdir(), env, encoding: 'utf8',
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), { base: runtime.webBase, data: runtime.dataDir });
  mkdirSync(path.join(f.root, 'Library/Logs'), { recursive: true });
  writeFileSync(path.join(f.selected, 'cove-workspace.json'), JSON.stringify({ weekdays_only: false }));
  // The shell schedule wrapper runs only this synthetic replacement, never Gmail.
  writeFileSync(path.join(f.root, 'scripts/cove-email-runner.ts'), `console.log('SYNTHETIC_TRIAGE_STARTED');`);
  const triage = spawnSync('/bin/bash', [path.join(f.root, 'scripts/cove-email-triage.sh')], { cwd: os.tmpdir(), env, encoding: 'utf8' });
  assert.equal(triage.status, 0, triage.stderr);
  assert.match(readFileSync(path.join(f.root, 'Library/Logs/cove-email-triage.log'), 'utf8'), /SYNTHETIC_TRIAGE_STARTED/);
});
