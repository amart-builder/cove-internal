import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = createRequire(import.meta.url).resolve('tsx');

for (const mode of ['canonical', 'legacy', 'database', 'saved', 'default']) {
  test(`voice samples selects ${mode} runtime configuration before reading mail`, t => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'cove-voice-paths-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const fixtureRepo = path.join(root, 'repo');
    const selected = path.join(root, 'selected');
    const home = path.join(root, 'empty-home');
    mkdirSync(selected); mkdirSync(home);
    for (const file of ['scripts/cove-voice-samples.ts', 'scripts/lib/load-local-env.mjs',
      'src/lib/email/runtime-paths.ts', 'src/lib/env.ts', 'src/lib/env-runtime.mjs']) {
      const target = path.join(fixtureRepo, file);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(path.join(repo, file), target);
    }
    // No real gateway, keychain, provider or account module is present in this fixture.
    const gateway = path.join(fixtureRepo, 'src/lib/workspace/google/gateway.ts');
    mkdirSync(path.dirname(gateway), { recursive: true });
    writeFileSync(gateway, `import {readFileSync} from 'node:fs';
      import path from 'node:path';
      export function createGoogleWorkspaceGateway({dataDir}) {
        const marker=JSON.parse(readFileSync(path.join(dataDir,'cove-workspace.json'),'utf8')).marker;
        return {mail:{listMessages:async()=>({messages:[{id:marker}]}),getMessage:async({messageId})=>({headers:[{name:'Subject',value:messageId}],text:'A synthetic authored sample with enough words to be included.'})}};
      }`);
    mkdirSync(path.join(fixtureRepo, 'data'));
    writeFileSync(path.join(fixtureRepo, 'data/cove-workspace.json'), JSON.stringify({ marker: 'repository' }));
    writeFileSync(path.join(selected, 'cove-workspace.json'), JSON.stringify({ marker: 'selected' }));
    const env = { HOME: home, PATH: path.dirname(process.execPath), NODE_NO_WARNINGS: '1' };
    if (mode === 'canonical') { env.COVE_DATA_DIR = selected; env.FORGE_DATA_DIR = path.join(root, 'wrong'); }
    if (mode === 'legacy') env.FORGE_DATA_DIR = selected;
    if (mode === 'database') env.COVE_DB_PATH = path.join(selected, 'cove.db');
    if (mode === 'saved') writeFileSync(path.join(fixtureRepo, '.env.local'), `COVE_DATA_DIR=${selected}\n`);
    const result = spawnSync(process.execPath, ['--import', tsx, path.join(fixtureRepo, 'scripts/cove-voice-samples.ts')], {
      cwd: root, env, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).samples[0].subject, mode === 'default' ? 'repository' : 'selected');
  });
}
