import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  coveDataDir,
  loadOperatorProfile,
  operatorName,
  operatorProfilePath,
  operatorTimezone,
  workspaceRoot,
} from '../src/lib/operator.ts';

function fixture(t) {
  const dir = path.join(os.tmpdir(), `cove-operator-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  const profilePath = path.join(dir, 'cove-profile.json');
  const previousProfilePath = process.env.COVE_PROFILE_PATH;
  const previousName = process.env.COVE_OPERATOR_NAME;
  process.env.COVE_PROFILE_PATH = profilePath;
  delete process.env.COVE_OPERATOR_NAME;
  t.after(() => {
    if (previousProfilePath === undefined) delete process.env.COVE_PROFILE_PATH;
    else process.env.COVE_PROFILE_PATH = previousProfilePath;
    if (previousName === undefined) delete process.env.COVE_OPERATOR_NAME;
    else process.env.COVE_OPERATOR_NAME = previousName;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, profilePath };
}

test('operator identity precedence is env, profile, then fallback', (t) => {
  const { profilePath } = fixture(t);
  assert.equal(operatorProfilePath(), profilePath);
  assert.equal(operatorName(), 'the operator');
  writeFileSync(profilePath, JSON.stringify({ name: 'Casey' }));
  assert.equal(operatorName(), 'Casey');
  process.env.COVE_OPERATOR_NAME = '  Morgan  ';
  assert.equal(operatorName(), 'Morgan');
  process.env.COVE_OPERATOR_NAME = '   ';
  assert.equal(operatorName(), 'Casey');
});

test('malformed profile JSON fails closed to the generic operator name', (t) => {
  const { profilePath } = fixture(t);
  writeFileSync(profilePath, '{not json');
  assert.equal(loadOperatorProfile(), undefined);
  assert.equal(operatorName(), 'the operator');
});

test('a profile written after the first read is discovered by a long-running process', (t) => {
  const { profilePath } = fixture(t);
  assert.equal(loadOperatorProfile(), undefined);
  writeFileSync(profilePath, JSON.stringify({ name: 'Riley', timezone: 'America/Chicago' }));
  assert.equal(loadOperatorProfile().name, 'Riley');
  assert.equal(operatorName(), 'Riley');
});

test('workspace root uses a trimmed env override, then an existing legacy Atlas root', () => {
  assert.equal(workspaceRoot({
    env: { COVE_BUDDY_WORKSPACE_ROOT: ' /srv/client-work ' },
    homeDir: '/Users/operator',
    exists: () => false,
  }), '/srv/client-work');
  assert.equal(workspaceRoot({
    env: { COVE_BUDDY_WORKSPACE_ROOT: ' ' },
    homeDir: '/Users/operator',
    exists: (candidate) => candidate === '/Users/operator/Atlas',
  }), '/Users/operator/Atlas');
  assert.equal(workspaceRoot({
    env: {},
    homeDir: '/Users/operator',
    exists: () => false,
  }), null);
});

test('cove data directory prefers an explicit argument, then COVE_DATA_DIR', (t) => {
  const previous = process.env.COVE_DATA_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.COVE_DATA_DIR;
    else process.env.COVE_DATA_DIR = previous;
  });
  process.env.COVE_DATA_DIR = ' /srv/cove-data ';
  assert.equal(coveDataDir(), '/srv/cove-data');
  assert.equal(coveDataDir('/tmp/explicit-cove-data'), '/tmp/explicit-cove-data');
});

test('operatorTimezone prefers the shared profile, then the env var, then this machine', (t) => {
  const { profilePath } = fixture(t);
  const previousZone = process.env.COVE_TIMEZONE;
  t.after(() => {
    if (previousZone === undefined) delete process.env.COVE_TIMEZONE;
    else process.env.COVE_TIMEZONE = previousZone;
  });

  delete process.env.COVE_TIMEZONE;
  writeFileSync(profilePath, JSON.stringify({ timezone: 'America/New_York' }));
  assert.equal(operatorTimezone(), 'America/New_York');

  process.env.COVE_TIMEZONE = 'Europe/Lisbon';
  assert.equal(operatorTimezone(), 'America/New_York');

  // A garbage zone must not be handed to Intl, where it throws at format time
  // rather than here. It falls through to the next source instead.
  process.env.COVE_TIMEZONE = 'Not/AZone';
  assert.equal(operatorTimezone(), 'America/New_York');

  writeFileSync(profilePath, JSON.stringify({ name: 'Jamie' }));
  process.env.COVE_TIMEZONE = 'Europe/Lisbon';
  assert.equal(operatorTimezone(), 'Europe/Lisbon');

  // With no env var and no usable profile value, fall back to this machine's
  // zone rather than a hardcoded one.
  delete process.env.COVE_TIMEZONE;
  assert.equal(operatorTimezone(), Intl.DateTimeFormat().resolvedOptions().timeZone);
});
