import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveBriefFileSourcePolicy } from '../src/lib/day-plan/brief-sources.ts';

// Regression: QA ISSUE-003 in the clean-user rehearsal documented at
// /private/tmp/cove-dual-sim.WDleYH/qa/qa-report-cove-local-2026-08-06.md.
// A new user's data/brief files were ignored when the host already had an
// Atlas/brain folder, so the generated brief read another operator's planning
// documents even though the setup agent had written the documented local files.
test('documented client brief files win over legacy Atlas brain files', (t) => {
  const root = path.join(
    os.tmpdir(),
    `cove-client-brief-precedence-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  const dataDir = path.join(root, 'data');
  const clientBriefDir = path.join(dataDir, 'brief');
  const homeDir = path.join(root, 'home');
  const legacyBrainDir = path.join(homeDir, 'Atlas', 'brain');
  mkdirSync(clientBriefDir, { recursive: true });
  mkdirSync(legacyBrainDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const clientPaths = {
    goals: path.join(clientBriefDir, 'goals.md'),
    operator_profile: path.join(clientBriefDir, 'operator-profile.md'),
    leadup: path.join(clientBriefDir, 'leadup.md'),
    sprint_memo: path.join(clientBriefDir, 'sprint-memo.md'),
  };
  for (const [id, filePath] of Object.entries(clientPaths)) {
    writeFileSync(filePath, `Client ${id}.`);
  }
  writeFileSync(path.join(legacyBrainDir, 'GOALS.md'), 'Legacy goals.');
  writeFileSync(path.join(legacyBrainDir, 'operator-profile.md'), 'Legacy operator.');
  writeFileSync(path.join(legacyBrainDir, 'brief-leadup.md'), 'Legacy leadup.');
  writeFileSync(path.join(legacyBrainDir, 'path-to-30k-2026-07.md'), 'Legacy sprint.');

  const envNames = [
    'COVE_BRIEF_GOALS_PATH',
    'COVE_BRIEF_OPERATOR_PROFILE_PATH',
    'COVE_BRIEF_LEADUP_PATH',
    'COVE_BRIEF_SPRINT_MEMO_PATH',
  ];
  const previous = new Map(envNames.map((name) => [name, process.env[name]]));
  for (const name of envNames) delete process.env[name];
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const policy = resolveBriefFileSourcePolicy({ dataDir, homeDir });
  assert.deepEqual(
    Object.fromEntries(Object.entries(policy).map(([id, value]) => [id, value.path])),
    clientPaths,
  );
  assert.equal(policy.operator_profile.format, undefined);
});

test('the setup profile JSON wins when no client operator markdown exists', (t) => {
  const root = path.join(
    os.tmpdir(),
    `cove-client-profile-precedence-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  const dataDir = path.join(root, 'data');
  const homeDir = path.join(root, 'home');
  const legacyBrainDir = path.join(homeDir, 'Atlas', 'brain');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(legacyBrainDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const profilePath = path.join(dataDir, 'cove-profile.json');
  writeFileSync(profilePath, JSON.stringify({ name: 'New Cove user' }));
  writeFileSync(path.join(legacyBrainDir, 'operator-profile.md'), 'Older profile.');

  const previous = process.env.COVE_BRIEF_OPERATOR_PROFILE_PATH;
  delete process.env.COVE_BRIEF_OPERATOR_PROFILE_PATH;
  t.after(() => {
    if (previous === undefined) delete process.env.COVE_BRIEF_OPERATOR_PROFILE_PATH;
    else process.env.COVE_BRIEF_OPERATOR_PROFILE_PATH = previous;
  });

  const policy = resolveBriefFileSourcePolicy({ dataDir, homeDir });
  assert.equal(policy.operator_profile.path, profilePath);
  assert.equal(policy.operator_profile.format, 'operator-profile-json');
});
