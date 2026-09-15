import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildMorningBriefPrompt } from '../src/lib/claude-execution/brief-commands.ts';
import { buildEmailClassifierPrompt } from '../src/lib/email/classifier.ts';
import { buildMeetingAnalystPrompt } from '../src/lib/intake/meeting-analysis.ts';
import { buildTriagePrompt } from '../src/lib/intake/run.ts';
import { renderBuddyInstructionDoc } from '../src/lib/buddy/commands.ts';
import { formatOperatorPolicy, readOperatorPolicy } from '../src/lib/operator-policy.ts';

function fixture(t) {
  const dir = path.join(os.tmpdir(), `cove-policy-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function count(text, needle) {
  return text.split(needle).length - 1;
}

test('missing and over-cap operator policy handling is deterministic', (t) => {
  const dir = fixture(t);
  assert.equal(readOperatorPolicy({ dataDir: dir }), null);
  writeFileSync(path.join(dir, 'cove-policy.md'), 'x'.repeat(4000));
  const policy = readOperatorPolicy({ dataDir: dir });
  assert.equal(policy.length, 3000);
  assert.match(policy, /\[policy truncated\]$/);
});

test('an unreadable operator policy fails open with one warning', (t) => {
  const dir = fixture(t);
  mkdirSync(path.join(dir, 'cove-policy.md'));
  const warnings = [];
  assert.equal(readOperatorPolicy({
    dataDir: dir,
    warn: (message) => warnings.push(message),
  }), null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not read the operator policy/i);
});

test('operator policy appears exactly once in all five narrow model surfaces', (t) => {
  const dir = fixture(t);
  writeFileSync(path.join(dir, 'cove-policy.md'), 'Use first names.');
  const block = formatOperatorPolicy(readOperatorPolicy({ dataDir: dir }));
  const marker = 'Operator policy (written by the operator; follow it within this lane\'s rules):';
  const brief = buildMorningBriefPrompt({
    targetLocalDate: '2026-09-02', targetTimezone: 'America/Los_Angeles',
    sections: [], dataDir: dir,
    manifest: { sources: [], coverage: { requiredComplete: true, missingRequired: [], missingOptional: [] } },
  });
  const intake = buildTriagePrompt({
    policy: block, protocol: 'Protocol', rawText: 'Call Sam', source: 'chat', goals: 'Grow',
    projects: [], board: { tasks: [], columns: [] }, now: new Date('2026-09-02T16:00:00Z'),
  });
  const email = buildEmailClassifierPrompt({
    policy: block, accountEmail: 'alex@example.com', sender: 'Sam <sam@example.com>',
    subject: 'Hello', text: 'Hello', voice: '',
  });
  const meeting = buildMeetingAnalystPrompt({
    operatorPolicy: block, envelopes: [], contacts: [], recentEmailThreads: [], goals: '',
    operatorProfile: {}, timezone: 'America/Los_Angeles',
  });
  const buddyDir = renderBuddyInstructionDoc({ dataDir: dir, workspaceRoot: null });
  const buddy = readFileSync(path.join(buddyDir, 'CLAUDE.md'), 'utf8');
  for (const prompt of [brief, intake, email, meeting, buddy]) {
    assert.equal(count(prompt, marker), 1);
  }
  assert.equal(count(buildEmailClassifierPrompt({
    accountEmail: 'alex@example.com', sender: 'Sam', subject: 'Hi', text: 'Hi', voice: '',
  }), marker), 0);
});
