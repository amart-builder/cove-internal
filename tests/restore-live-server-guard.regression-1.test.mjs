import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { openLocalDatabase } from '../src/lib/local/database.ts';
import { createSqliteBackup } from '../src/lib/reliability/backup.ts';

// The launchctl gate only sees Cove started the way the installer starts it.
// Setup Step 4 starts the web app by hand, and so does anyone debugging, and at
// an idle moment nothing holds the database open -- so before this guard a
// restore run against a live hand-started Cove was allowed, which is the exact
// loss finding 6 is about.

const SCRIPT = path.resolve(import.meta.dirname, '../scripts/cove-restore-backup.sh');

async function scratchInstall(t) {
  const root = path.join(
    os.tmpdir(),
    `cove-restore-guard-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  const dbPath = path.join(root, 'cove.db');
  const backupDir = path.join(root, 'backups');
  mkdirSync(root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  openLocalDatabase(dbPath).close();
  const backup = await createSqliteBackup({ dbPath, backupDir });
  return { root, dbPath, backupDir, backup };
}

// The restore runs under spawnSync, which blocks this process, so the stand-in
// server has to be a separate one or it could never answer the probe.
async function serving(t, root, body) {
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

function restore({ backup, dbPath, backupDir, webBase, allowRunning }) {
  return spawnSync('/bin/bash', [SCRIPT, '--yes', backup.path], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      COVE_DB_PATH: dbPath,
      COVE_BACKUP_DIR: backupDir,
      COVE_NODE_PATH: process.execPath,
      ...(webBase ? { COVE_BRIEF_WEB_BASE: webBase } : {}),
      ...(allowRunning ? { COVE_RESTORE_ALLOW_RUNNING: '1' } : {}),
    },
    encoding: 'utf8',
  });
}

test('a restore refuses while Cove is answering on its own port', async (t) => {
  const install = await scratchInstall(t);
  const webBase = await serving(t, install.root, JSON.stringify({ readiness: { checkedAt: 'now' } }));
  const result = restore({ ...install, webBase });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /is running and would overwrite a restore/);
  // The refusal has to name the way out, or it is just a wall.
  assert.match(result.stderr, /cove-stop\.sh/);
  assert.match(result.stderr, /COVE_RESTORE_ALLOW_RUNNING=1/);
  assert.match(result.stderr, new RegExp(webBase.replace(/[.]/g, '\\.')));
});

test('the escape hatch still gets through a live server', async (t) => {
  const install = await scratchInstall(t);
  const webBase = await serving(t, install.root, JSON.stringify({ readiness: {} }));
  const result = restore({ ...install, webBase, allowRunning: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('something else on the port does not block a restore', async (t) => {
  const install = await scratchInstall(t);
  const webBase = await serving(t, install.root, '<html>a different program</html>');
  const result = restore({ ...install, webBase });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('nothing listening is not treated as Cove running', async (t) => {
  const install = await scratchInstall(t);
  // Port 1 is privileged and nothing is on it; the probe must fail closed to
  // "not serving" rather than hang or refuse.
  const result = restore({ ...install, webBase: 'http://127.0.0.1:1' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('a checkout that was never installed probes nothing', async (t) => {
  const install = await scratchInstall(t);
  // No COVE_BRIEF_WEB_BASE and no .env.local recording one: the script must not
  // fall back to the documented default port and let whatever answers there
  // decide whether a restore is allowed. This is what keeps `npm test` on a Mac
  // with Cove running from depending on Cove running.
  const result = restore({ ...install });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /is running and would overwrite a restore/);
});
