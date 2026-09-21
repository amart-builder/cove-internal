import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

// `cove-stop.sh --status` reads launchctl, so on a machine where Cove was
// started by hand -- setup Step 4, or anyone watching a log -- it used to
// answer "Cove is not installed on this Mac" while Cove was serving. That is
// the sentence that sends someone into a restore over a live writer.
//
// Only --status is exercised here. The stop mode boots services out, which a
// test must never do to the machine it runs on.

const SCRIPT = path.resolve(import.meta.dirname, '../scripts/cove-stop.sh');

// The script runs under spawnSync, which blocks this process, so the stand-in
// server has to be a separate one or it could never answer the probe.
async function serving(t, body) {
  const root = path.join(
    os.tmpdir(),
    `cove-stop-report-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'stand-in-server.mjs');
  writeFileSync(
    file,
    `import { createServer } from 'node:http';
const server = createServer((request, response) => {
  if (request.url !== '/api/health') { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'content-type': 'application/json' }).end(${JSON.stringify(body)});
});
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
`,
  );
  const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const port = await new Promise((resolve, reject) => {
    child.stdout.once('data', (chunk) => resolve(String(chunk).trim()));
    child.once('error', reject);
  });
  return `http://127.0.0.1:${port}`;
}

function status(webBase) {
  return spawnSync('/bin/bash', [SCRIPT, '--status'], {
    env: {
      ...process.env,
      COVE_NODE_PATH: process.execPath,
      ...(webBase ? { COVE_BRIEF_WEB_BASE: webBase } : {}),
    },
    encoding: 'utf8',
  });
}

test('--status names a Cove that launchd never started', async (t) => {
  const webBase = await serving(t, JSON.stringify({ readiness: { checkedAt: 'now' } }));
  const result = status(webBase);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /started by hand is still answering/);
  assert.match(result.stdout, new RegExp(webBase.replace(/[.]/g, '\\.')));
  // It must also say what the person can do, since this script cannot do it.
  assert.match(result.stdout, /terminal that started it/);
});

test('--status says nothing extra when nothing is answering', () => {
  const result = status('http://127.0.0.1:1');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /started by hand/);
});

test('--status does not report another program on the port as Cove', async (t) => {
  const webBase = await serving(t, '<html>a different program</html>');
  const result = status(webBase);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /started by hand/);
});

test('both scripts ask the same shared question', () => {
  const root = path.resolve(import.meta.dirname, '..');
  for (const name of ['scripts/cove-stop.sh', 'scripts/cove-restore-backup.sh']) {
    const source = spawnSync('/bin/cat', [path.join(root, name)], { encoding: 'utf8' }).stdout;
    assert.match(source, /scripts\/lib\/cove-serving\.sh/, `${name} should source the shared probe`);
    assert.match(source, /cove_is_serving/, `${name} should use the shared probe`);
  }
});

test('a missing probe does not stop the stop command from stopping', (t) => {
  // The shared probe is an extra line of information. Stopping Cove is the job,
  // so a checkout that somehow lacks the file still has to work.
  const root = path.join(
    os.tmpdir(),
    `cove-stop-noprobe-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(path.join(root, 'scripts/lib'), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  copyFileSync(SCRIPT, path.join(root, 'scripts/cove-stop.sh'));
  const result = spawnSync('/bin/bash', [path.join(root, 'scripts/cove-stop.sh'), '--status'], {
    env: { ...process.env, COVE_NODE_PATH: process.execPath },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /cove-serving\.sh/);
});
