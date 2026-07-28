import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  coveConfigPath,
  coveConfigWritePath,
  coveEnv,
  coveEnvTrimmed,
} from '../src/lib/env.ts';
import { coveDataDir, operatorName, operatorTimezone } from '../src/lib/operator.ts';

// Forge was renamed to Cove. A machine installed before the rename still sets
// only FORGE_* and still has data/forge-*.json on disk, and must keep working
// with no edits. These tests are the contract for that.

function tempDir(t) {
  const dir = path.join(
    os.tmpdir(),
    `cove-compat-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function withEnv(t, values) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('a COVE_ variable wins, and the old FORGE_ name still works alone', (t) => {
  withEnv(t, { COVE_DB_PATH: undefined, FORGE_DB_PATH: undefined });

  assert.equal(coveEnv('DB_PATH'), undefined);

  process.env.FORGE_DB_PATH = '/legacy/forge.db';
  assert.equal(coveEnv('DB_PATH'), '/legacy/forge.db');

  process.env.COVE_DB_PATH = '/new/cove.db';
  assert.equal(coveEnv('DB_PATH'), '/new/cove.db');

  delete process.env.COVE_DB_PATH;
  assert.equal(coveEnv('DB_PATH'), '/legacy/forge.db');
});

test('an explicitly empty COVE_ value is honoured and does not fall through', (t) => {
  withEnv(t, { COVE_DAY_PLAN_ACCESS_MODE: '', FORGE_DAY_PLAN_ACCESS_MODE: 'loopback' });
  assert.equal(coveEnv('DAY_PLAN_ACCESS_MODE'), '');
  assert.equal(coveEnvTrimmed('DAY_PLAN_ACCESS_MODE'), undefined);
});

test('coveEnv reads a supplied environment object, not just process.env', (t) => {
  withEnv(t, { COVE_TABLE_PREFIX: undefined, FORGE_TABLE_PREFIX: undefined });
  assert.equal(coveEnv('TABLE_PREFIX', { FORGE_TABLE_PREFIX: 'forge_' }), 'forge_');
  assert.equal(
    coveEnv('TABLE_PREFIX', { COVE_TABLE_PREFIX: 'cove_', FORGE_TABLE_PREFIX: 'forge_' }),
    'cove_',
  );
});

test('config reads prefer cove-*.json, fall back to forge-*.json, and write cove-*.json', (t) => {
  const dir = tempDir(t);

  // Neither file exists: the canonical new name is what callers get.
  assert.equal(coveConfigPath(dir, 'email.json'), path.join(dir, 'cove-email.json'));

  // Only the pre-rename file exists: it is still read.
  writeFileSync(path.join(dir, 'forge-email.json'), '{}');
  assert.equal(coveConfigPath(dir, 'email.json'), path.join(dir, 'forge-email.json'));

  // Both exist: the new name wins.
  writeFileSync(path.join(dir, 'cove-email.json'), '{}');
  assert.equal(coveConfigPath(dir, 'email.json'), path.join(dir, 'cove-email.json'));

  // Writes never target the old name, so the first write migrates the file.
  assert.equal(coveConfigWritePath(dir, 'email.json'), path.join(dir, 'cove-email.json'));
});

test('the operator profile is read from a pre-rename data/forge-profile.json', (t) => {
  const dir = tempDir(t);
  writeFileSync(
    path.join(dir, 'forge-profile.json'),
    JSON.stringify({ name: 'Casey', timezone: 'America/New_York' }),
  );
  withEnv(t, {
    COVE_PROFILE_PATH: undefined,
    FORGE_PROFILE_PATH: undefined,
    COVE_OPERATOR_NAME: undefined,
    FORGE_OPERATOR_NAME: undefined,
    COVE_TIMEZONE: undefined,
    FORGE_TIMEZONE: undefined,
    COVE_DATA_DIR: undefined,
    FORGE_DATA_DIR: dir,
  });

  assert.equal(coveDataDir(), dir);
  assert.equal(operatorName(), 'Casey');
  assert.equal(operatorTimezone(), 'America/New_York');

  // The legacy env name for the operator still overrides the profile.
  process.env.FORGE_OPERATOR_NAME = 'Casey M';
  assert.equal(operatorName(), 'Casey M');
});

test('FORGE_TAILSCALE_TRUSTED_HOSTS alone still authorizes a trusted host', async () => {
  const { getForgeAllowedHosts, dayPlanLoopbackHosts, isTrustedRequestOrigin } =
    await import('../src/lib/request-security.ts');

  // A machine that has never heard of Cove: only the pre-rename names are set.
  const legacyEnv = {
    FORGE_TAILSCALE_TRUSTED_HOSTS: 'mini.tail1234.ts.net',
    FORGE_PUBLIC_URL: 'cove.local',
    FORGE_ALLOWED_HOSTS: 'extra.local',
  };

  const allowed = getForgeAllowedHosts(legacyEnv);
  assert.ok(allowed.includes('mini.tail1234.ts.net'));
  assert.ok(allowed.includes('cove.local'));
  assert.ok(allowed.includes('extra.local'));
  assert.ok(dayPlanLoopbackHosts(legacyEnv).includes('mini.tail1234.ts.net'));

  // The whole point: a request from that host is still trusted.
  assert.equal(
    isTrustedRequestOrigin({
      host: 'mini.tail1234.ts.net',
      origin: null,
      requestProtocol: 'https:',
      allowedHosts: allowed,
      trustProxy: false,
    }),
    true,
  );

  // An unlisted host is still rejected, so this is not a blanket allow.
  assert.equal(
    isTrustedRequestOrigin({
      host: 'attacker.example',
      origin: null,
      requestProtocol: 'https:',
      allowedHosts: allowed,
      trustProxy: false,
    }),
    false,
  );

  // And the new name still wins when both are present.
  assert.ok(
    getForgeAllowedHosts({
      ...legacyEnv,
      COVE_TAILSCALE_TRUSTED_HOSTS: 'new.tail1234.ts.net',
    }).includes('new.tail1234.ts.net'),
  );
});

test('the brief writer, codex binary, notify gate, and dump writer read FORGE_ too', async () => {
  const { configuredMorningBriefWriter, resolveCodexBinary } =
    await import('../src/lib/claude-execution/morning-brief-writer.ts');
  const { configuredDayDumpWriter } = await import('../src/lib/claude-execution/worker.ts');
  const { createExecutionNotifier } = await import('../src/lib/claude-execution/notify.ts');

  // FORGE_NOTIFY=1 alone must still let a notification through.
  const spawned = [];
  const notify = createExecutionNotifier({
    env: { FORGE_NOTIFY: '1' },
    processStartedAt: new Date('2026-07-16T17:59:00.000Z'),
    exists: (candidate) => candidate === '/opt/homebrew/bin/terminal-notifier',
    spawnImpl: (executable, args) => {
      spawned.push({ executable, args });
      const child = new EventEmitter();
      child.unref = () => undefined;
      queueMicrotask(() => child.emit('close', 0));
      return child;
    },
    logger: () => undefined,
  });
  await notify({
    runId: 'run-1',
    state: 'plan_ready',
    itemTitle: 'Launch brief',
    claudeSessionId: 'session-1',
    transitionedAt: '2026-07-16T18:00:00.000Z',
  });
  assert.equal(spawned.length, 1);

  assert.equal(configuredMorningBriefWriter({ FORGE_BRIEF_WRITER: 'claude' }), 'claude');
  assert.equal(
    configuredMorningBriefWriter({ FORGE_BRIEF_WRITER: 'claude', COVE_BRIEF_WRITER: 'codex' }),
    'codex',
  );
  assert.equal(configuredDayDumpWriter({ FORGE_DUMP_WRITER: 'claude' }), 'claude');
  assert.equal(
    resolveCodexBinary({ env: { FORGE_CODEX_BIN: '/opt/homebrew/bin/codex' }, exists: () => true }),
    '/opt/homebrew/bin/codex',
  );
});
