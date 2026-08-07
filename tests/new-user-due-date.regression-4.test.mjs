import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Regression: QA ISSUE-004 in the clean-user rehearsal documented at
// /private/tmp/cove-dual-sim.WDleYH/qa/qa-report-cove-local-2026-08-06.md.
// A date chosen as Aug 7 is stored as midnight UTC. Arrival and task-session
// copy converted that value to Pacific time and showed Aug 6.
test('midnight-UTC task dates stay on the calendar day the user chose', () => {
  const script = `
    import presentation from './src/lib/day-plan/presentation.ts';
    import manager from './src/lib/task-sessions/manager.ts';
    const dueAt = '2026-08-07T00:00:00.000Z';
    const prompt = manager.buildTaskSessionPrompt({
      mode: 'planning',
      outputDir: '/tmp/cove-regression-output',
      promptSnapshot: { title: 'Review renewal', detail: 'Review it.', dueAt },
    });
    process.stdout.write(JSON.stringify({ arrival: presentation.formatArrivalDueDate(dueAt), prompt }));
  `;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, TZ: 'America/Los_Angeles' },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.arrival, 'Aug 7');
  assert.match(parsed.prompt, /Due: Aug 7, 2026/);
  assert.doesNotMatch(parsed.prompt, /Due: Aug 6, 2026/);
});
