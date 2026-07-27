import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { buildDayPlanCandidates } from '../src/lib/day-plan/candidates.ts';
import { createDayPlanStore, DayPlanInvalidTransition } from '../src/lib/day-plan/store.ts';
import { buildExecutionCommand } from '../src/lib/claude-execution/commands.ts';
import {
  includesClaudeSessionId,
  publicExecutionReadiness,
  publicExecutionRun,
} from '../src/lib/day-plan/public-execution.ts';

function setup(t, executionEnvironment = { autonomousEnabled: false, workspaces: new Map() }) {
  const file = path.join(os.tmpdir(), `forge-execution-${process.pid}-${Date.now()}-${Math.random()}.db`);
  const store = createDayPlanStore({
    dbPath: file,
    now: () => new Date('2026-07-10T16:00:00.000Z'),
    executionEnvironment,
  });
  t.after(() => {
    store.close();
    rmSync(file, { force: true });
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
  });
  let plan = store.ensureDayPlan({
    localDate: '2026-07-10',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:execution',
    candidates: buildDayPlanCandidates({
      localDate: '2026-07-10',
      timezone: 'America/Los_Angeles',
      tasks: ['a', 'b'].map((id, position) => ({
        id: `task-${id}`,
        title: `Task ${id}`,
        description: `Finish task ${id}`,
        definitionOfDone: `Task ${id} is verified`,
        priority: position === 0 ? 'high' : 'medium',
        position,
        column: 'today',
        status: 'open',
        updatedAt: '2026-07-10T15:00:00.000Z',
        refreshedAt: '2026-07-10T16:00:00.000Z',
      })),
    }),
  }).plan;
  plan = store.mutateDayPlan({
    planId: plan.id,
    expectedVersion: plan.version,
    mutationId: 'arrival-open:execution',
    action: 'arrival_open',
  }).plan;
  return { store, plan, file };
}

function mutate(store, plan, action, patch = {}) {
  return store.mutateDayPlan({
    planId: plan.id,
    expectedVersion: plan.version,
    mutationId: `${action}:${plan.version}:${Math.random()}`.replaceAll('.', '-'),
    action,
    ...patch,
  }).plan;
}

test('Start My Day queues Together plan review without a workspace', (t) => {
  const { store, plan: original } = setup(t);
  let plan = mutate(store, original, 'item_owner', {
    itemId: original.items[0].id,
    owner: 'together',
  });
  const configured = store.configureExecution({
    planId: plan.id,
    itemId: plan.items[0].id,
    expectedVersion: plan.version,
    mutationId: 'configure:together',
    mode: 'plan_review',
    modelAlias: 'sonnet',
  });
  assert.equal(configured.readiness.ready, true);
  assert.equal(configured.config.workspaceId, undefined);

  const started = store.mutateDayPlan({
    planId: plan.id,
    expectedVersion: plan.version,
    mutationId: 'start-day:together',
    action: 'start_day',
  });
  const [run] = started.executionRuns;
  assert.equal(run.status, 'queued');
  assert.equal(run.owner, 'together');
  assert.equal(run.mode, 'plan_review');
  assert.match(run.claudeSessionId, /^[0-9a-f-]{36}$/);
  assert.equal(started.plan.items[0].decision, 'accepted');
  assert.equal(store.mutateDayPlan({
    planId: plan.id,
    expectedVersion: plan.version,
    mutationId: 'start-day:together',
    action: 'start_day',
  }).replayed, true);
});

test('enqueued runs use the latest progress snapshot for the task within 14 days', (t) => {
  const { store, plan: original, file } = setup(t);
  const db = new Database(file);
  for (const [date, note, nextStep] of [
    ['2026-07-08', 'Outlined the first section.', 'Draft the examples.'],
    ['2026-07-09', 'Drafted the full argument.', 'Review the pricing section.'],
  ]) {
    db.prepare(
      `INSERT INTO day_plans
        (id, local_date, timezone, open_slot, plan_state, arrival_state, settlement_state,
         version, items_json, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'settled', 'confirmed', 'settled', 1, '[]', ?, ?)`,
    ).run(`plan-${date}`, date, 'America/Los_Angeles', `${date}T16:00:00.000Z`, `${date}T23:00:00.000Z`);
    db.prepare(
      `INSERT INTO day_snapshots
        (id, day_plan_id, local_date, timezone, version, body_json, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      `snapshot-${date}`,
      `plan-${date}`,
      date,
      'America/Los_Angeles',
      JSON.stringify({
        completedHumanTaskIds: [],
        returnedAgentWork: [],
        unresolvedItems: [{
          dayPlanItemId: `item-${date}`,
          taskId: 'task-a',
          title: 'Task a',
          owner: 'together',
          disposition: 'progress',
          progressNote: note,
          nextStep,
        }],
        humanDecisionEventIds: [],
        overnightQueue: [],
      }),
      `${date}T23:00:00.000Z`,
    );
  }
  db.close();

  const plan = mutate(store, original, 'item_owner', {
    itemId: original.items[0].id,
    owner: 'together',
  });
  const started = store.mutateDayPlan({
    planId: plan.id,
    expectedVersion: plan.version,
    mutationId: 'start-day:progress-context',
    action: 'start_day',
  });
  const run = started.executionRuns.find((candidate) => candidate.taskId === 'task-a');
  assert.equal(run.promptSnapshot.progressNote, 'Drafted the full argument.');
  assert.equal(run.promptSnapshot.nextStep, 'Review the pricing section.');
  assert.equal(
    store.getExecutionRun(run.id).promptSnapshot.progressNote,
    'Drafted the full argument.',
  );
});

test('plan-review runs persist the resolved project directory for execution and resume', (t) => {
  const file = path.join(os.tmpdir(), `forge-execution-project-${process.pid}-${Date.now()}.db`);
  const projectDir = '/private/tmp/atlas-projects/supernova-engine';
  const hints = [];
  let resolvedProjectDir = projectDir;
  const store = createDayPlanStore({
    dbPath: file,
    now: () => new Date('2026-07-10T16:00:00.000Z'),
    executionEnvironment: { autonomousEnabled: false, workspaces: new Map() },
    resolveProjectDirectory: (hint) => {
      hints.push(hint);
      return hint === 'Supernova Engine' ? resolvedProjectDir : null;
    },
  });
  t.after(() => {
    store.close();
    rmSync(file, { force: true });
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
  });
  let plan = store.ensureDayPlan({
    localDate: '2026-07-10',
    timezone: 'America/Los_Angeles',
    mutationId: 'ensure:project-resolution',
    candidates: buildDayPlanCandidates({
      localDate: '2026-07-10',
      timezone: 'America/Los_Angeles',
      tasks: [{
        id: 'task-project', title: 'Draft the launch plan', description: 'Plan it',
        priority: 'high', position: 0, column: 'today', status: 'open',
        project: 'Supernova Engine',
        updatedAt: '2026-07-10T15:00:00.000Z', refreshedAt: '2026-07-10T16:00:00.000Z',
      }],
    }),
  }).plan;
  plan = mutate(store, plan, 'arrival_open');
  plan = mutate(store, plan, 'item_owner', { itemId: plan.items[0].id, owner: 'together' });
  const [run] = store.mutateDayPlan({
    planId: plan.id,
    expectedVersion: plan.version,
    mutationId: 'start-day:project-resolution',
    action: 'start_day',
  }).executionRuns;

  assert.equal(hints[0], 'Supernova Engine');
  assert.equal(run.workspacePath, projectDir);
  assert.equal(store.getExecutionRun(run.id).workspacePath, projectDir);
  assert.equal(buildExecutionCommand({
    claudePath: '/fake/claude',
    emptyMcpConfigPath: '/tmp/empty-mcp.json',
    fallbackCwd: '/forge',
    run,
  }).cwd, projectDir);
  assert.match(
    publicExecutionRun(run, 'loopback').resumeCommand,
    /^cd '\/private\/tmp\/atlas-projects\/supernova-engine' && claude --resume /,
  );
  resolvedProjectDir = '/private/tmp/atlas-projects/renamed-after-enqueue';
  const claimed = store.claimNextExecutionRun();
  assert.equal(claimed.status, 'starting');
  assert.equal(claimed.workspacePath, projectDir);
  assert.deepEqual(hints, ['Supernova Engine']);
});

test('Together can never be configured for autonomous execution', (t) => {
  const { store, plan: original } = setup(t);
  const plan = mutate(store, original, 'item_owner', {
    itemId: original.items[0].id,
    owner: 'together',
  });
  assert.throws(
    () => store.configureExecution({
      planId: plan.id,
      itemId: plan.items[0].id,
      expectedVersion: plan.version,
      mutationId: 'configure:together:auto',
      mode: 'autonomous',
      modelAlias: 'sonnet',
      workspaceId: 'forge',
      budgetUsd: 1,
    }),
    (error) => error instanceof DayPlanInvalidTransition,
  );
});

test('arrival never permits kickoff and Start My Day uses the final edited brief', (t) => {
  const { store, plan: original } = setup(t);
  let plan = mutate(store, original, 'item_owner', {
    itemId: original.items[0].id,
    owner: 'claude',
  });
  store.configureExecution({
    planId: plan.id,
    itemId: plan.items[0].id,
    expectedVersion: plan.version,
    mutationId: 'configure:brief',
    mode: 'plan_review',
    modelAlias: 'sonnet',
  });
  assert.throws(
    () => store.kickoffItem({
      planId: plan.id,
      itemId: plan.items[0].id,
      expectedVersion: plan.version,
      mutationId: 'kickoff:during-arrival',
    }),
    (error) => error instanceof DayPlanInvalidTransition,
  );
  assert.equal(store.listExecutionRuns(plan.id).length, 0);
  plan = mutate(store, plan, 'item_edit', {
    itemId: plan.items[0].id,
    outcome: 'A newly clarified outcome',
  });
  const readiness = store.getExecutionReadiness(plan.id, plan.items[0].id);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.codes.includes('brief_changed'));
  const started = store.mutateDayPlan({
    planId: plan.id,
    expectedVersion: plan.version,
    mutationId: 'start-day:edited-brief',
    action: 'start_day',
  });
  assert.equal(started.executionRuns.length, 1);
  assert.equal(started.executionRuns[0].promptSnapshot.outcome, 'A newly clarified outcome');
  assert.equal(started.executionRuns[0].status, 'queued');
});

test('execution can be configured for an accepted agent item once the day is active, but not for me-owned or dropped items', (t) => {
  const { store, plan: original } = setup(t);
  // item[0] -> Claude (accepted agent work), item[1] stays me-owned. Both are accepted
  // by Start My Day.
  const plan = mutate(store, original, 'item_owner', {
    itemId: original.items[0].id,
    owner: 'claude',
  });
  const started = store.mutateDayPlan({
    planId: plan.id,
    expectedVersion: plan.version,
    mutationId: 'start-day:active-config',
    action: 'start_day',
  });
  const active = started.plan;
  assert.equal(active.state, 'active');

  const agentItem = active.items.find(
    (item) => item.decision === 'accepted' && item.owner === 'claude',
  );
  const meItem = active.items.find(
    (item) => item.decision === 'accepted' && item.owner === 'me',
  );
  assert.ok(agentItem && meItem);

  const configured = store.configureExecution({
    planId: active.id,
    itemId: agentItem.id,
    expectedVersion: active.version,
    mutationId: 'configure:active:agent',
    mode: 'plan_review',
    modelAlias: 'sonnet',
  });
  assert.equal(configured.config.mode, 'plan_review');

  // A me-owned accepted item is denied while the day is active (configure does not bump
  // the plan version, so the same expectedVersion still applies).
  assert.throws(
    () => store.configureExecution({
      planId: active.id,
      itemId: meItem.id,
      expectedVersion: active.version,
      mutationId: 'configure:active:me',
      mode: 'plan_review',
      modelAlias: 'sonnet',
    }),
    (error) => error instanceof DayPlanInvalidTransition,
  );
});

test('a dropped item can never be configured for execution, even while the day is active', (t) => {
  const { store, plan: original } = setup(t);
  // item[0] -> Claude then dropped; item[1] stays me-owned so Start My Day still has a focus.
  let plan = mutate(store, original, 'item_owner', {
    itemId: original.items[0].id,
    owner: 'claude',
  });
  plan = mutate(store, plan, 'item_dismiss', { itemId: plan.items[0].id });
  const started = store.mutateDayPlan({
    planId: plan.id,
    expectedVersion: plan.version,
    mutationId: 'start-day:dropped',
    action: 'start_day',
  });
  const active = started.plan;
  assert.equal(active.state, 'active');
  const dropped = active.items.find((item) => item.decision === 'dismissed');
  assert.ok(dropped);
  assert.throws(
    () => store.configureExecution({
      planId: active.id,
      itemId: dropped.id,
      expectedVersion: active.version,
      mutationId: 'configure:active:dropped',
      mode: 'plan_review',
      modelAlias: 'sonnet',
    }),
    (error) => error instanceof DayPlanInvalidTransition,
  );
});

test('claudeSessionId is projected for loopback actionable runs only', () => {
  const statuses = [
    'queued', 'starting', 'running', 'plan_ready', 'ready_to_join',
    'awaiting_review', 'failed', 'interrupted', 'cancelling', 'cancelled',
  ];
  for (const status of statuses) {
    const exposed = [
      'queued', 'starting', 'running', 'plan_ready', 'ready_to_join', 'awaiting_review',
    ].includes(status);
    assert.equal(includesClaudeSessionId('loopback', status), exposed);
    assert.equal(includesClaudeSessionId('session', status), false);
    assert.equal(includesClaudeSessionId(undefined, status), false);
  }

  const baseRun = {
    id: 'run-projection',
    dayPlanId: 'plan-projection',
    itemId: 'item-projection',
    taskId: 'task-projection',
    owner: 'together',
    mode: 'plan_review',
    modelAlias: 'sonnet',
    status: 'plan_ready',
    idempotencyKey: 'projection',
    attempt: 1,
    claudeSessionId: '00000000-0000-4000-8000-000000000000',
    briefHash: 'hash',
    authorizationHash: 'auth',
    promptSnapshot: { title: 'Projected task', outcome: 'Safe', whyToday: 'Accepted work' },
    workspacePath: '/private/allowlisted/project',
    pid: 4242,
    readiness: { ready: true, codes: ['ready'], checkedAt: '', workspacePath: '/private/allowlisted/project' },
    createdAt: '2026-07-10T16:00:00.000Z',
    updatedAt: '2026-07-10T16:00:00.000Z',
  };
  assert.equal(publicExecutionRun(baseRun, 'loopback').claudeSessionId, baseRun.claudeSessionId);
  assert.equal(
    publicExecutionRun(baseRun, 'loopback').resumeCommand,
    "cd '/private/allowlisted/project' && claude --resume '00000000-0000-4000-8000-000000000000'",
  );
  assert.equal(publicExecutionRun(baseRun, 'session').claudeSessionId, undefined);
  assert.equal(publicExecutionRun(baseRun, 'session').resumeCommand, undefined);
  assert.equal(publicExecutionRun(baseRun).claudeSessionId, undefined);
  assert.equal(publicExecutionRun({ ...baseRun, status: 'running' }, 'loopback').claudeSessionId, baseRun.claudeSessionId);
  assert.equal(publicExecutionRun({ ...baseRun, status: 'ready_to_join' }, 'loopback').claudeSessionId, baseRun.claudeSessionId);

  // Raw workspacePath, pid, and the readiness path stay stripped regardless of access mode.
  const stripped = publicExecutionRun(baseRun, 'loopback');
  assert.equal(stripped.workspacePath, undefined);
  assert.equal(stripped.pid, undefined);
  assert.equal(stripped.readiness.workspacePath, undefined);
});

test('Start My Day batch-kicks every accepted Claude and Together item in plan mode', (t) => {
  const { store, plan: original } = setup(t);
  let plan = original;
  plan = mutate(store, plan, 'item_owner', { itemId: plan.items[0].id, owner: 'together' });
  plan = mutate(store, plan, 'item_owner', { itemId: plan.items[1].id, owner: 'claude' });
  const started = store.mutateDayPlan({
    planId: plan.id,
    expectedVersion: plan.version,
    mutationId: 'start-day:execution',
    action: 'start_day',
  });
  assert.equal(started.plan.state, 'active');
  assert.equal(started.executionRuns.length, 2);
  assert.deepEqual(
    new Set(started.executionRuns.map((run) => run.itemId)),
    new Set(plan.items.map((item) => item.id)),
  );
  assert.equal(started.executionRuns.every((run) => run.mode === 'plan_review'), true);
  assert.equal(started.executionRuns.every((run) => run.status === 'queued'), true);
  assert.equal(started.unreadyItems?.length ?? 0, 0);
  assert.equal(started.kickoffSkips?.length ?? 0, 0);
  assert.equal(store.listExecutionRuns(plan.id).length, 2);
  const replay = store.mutateDayPlan({
    planId: plan.id,
    expectedVersion: plan.version,
    mutationId: 'start-day:execution',
    action: 'start_day',
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.executionRuns.length, 2);
  assert.equal(store.listExecutionRuns(plan.id).length, 2);
});

test('reopening arrival quiesces queued and running agent work before a fresh restart', (t) => {
  const { store, plan: original } = setup(t);
  let plan = original;
  for (const item of plan.items) {
    plan = mutate(store, plan, 'item_owner', { itemId: item.id, owner: 'together' });
  }
  const started = store.mutateDayPlan({
    planId: plan.id,
    expectedVersion: plan.version,
    mutationId: 'start-day:before-reopen',
    action: 'start_day',
  });
  plan = started.plan;
  assert.equal(started.executionRuns.length, 2);

  const claimed = store.claimNextExecutionRun(111);
  const running = store.markExecutionRunRunning(claimed.id, 222);
  const queued = started.executionRuns.find((run) => run.id !== running.id);
  assert.equal(running.status, 'running');
  assert.equal(queued.status, 'queued');

  plan = mutate(store, plan, 'arrival_reopen');
  assert.equal(plan.state, 'proposed');
  assert.equal(store.getExecutionRun(queued.id).status, 'cancelled');
  assert.equal(store.getExecutionRun(queued.id).errorCode, 'user_cancelled');
  assert.equal(store.getExecutionRun(running.id).status, 'cancelling');
  assert.equal(store.heartbeatExecutionRun(running.id, 222), false);
  const restarted = store.mutateDayPlan({
    planId: plan.id,
    expectedVersion: plan.version,
    mutationId: 'start-day:while-one-cancels',
    action: 'start_day',
  });
  plan = restarted.plan;
  assert.equal(restarted.executionRuns.length, 1);
  assert.equal(restarted.executionRuns[0].itemId, queued.itemId);
  assert.equal(restarted.executionRuns[0].attempt, 2);
  assert.deepEqual(restarted.kickoffSkips.map(({ itemId, reason, status }) => ({ itemId, reason, status })), [{
    itemId: running.itemId,
    reason: 'already_live',
    status: 'cancelling',
  }]);
  assert.equal(
    store.listExecutionRuns(plan.id).filter((run) =>
      run.itemId === running.itemId &&
      ['queued', 'starting', 'running', 'cancelling'].includes(run.status)
    ).length,
    1,
  );
  assert.equal(store.finishExecutionRun({ runId: running.id }).status, 'cancelled');

  const replacement = store.kickoffItem({
    planId: plan.id,
    itemId: running.itemId,
    expectedVersion: plan.version,
    mutationId: 'kickoff:after-reopen-cancelled',
  });
  plan = replacement.plan;
  assert.equal(replacement.run.status, 'queued');
  assert.equal(replacement.run.attempt, 2);
  assert.notEqual(replacement.run.id, running.id);

  const liveStatuses = new Set(['queued', 'starting', 'running', 'cancelling']);
  const allRuns = store.listExecutionRuns(plan.id);
  for (const item of plan.items) {
    assert.equal(
      allRuns.filter((run) => run.itemId === item.id && liveStatuses.has(run.status)).length,
      1,
    );
  }
});

test('autonomous readiness requires enablement, allowlisted clean Git, DoD, opt-in, and budget', (t) => {
  const repo = path.join(os.tmpdir(), `forge-ready-repo-${process.pid}-${Date.now()}`);
  mkdirSync(repo);
  writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  execFileSync('/usr/bin/git', ['-C', repo, 'init', '-q']);
  execFileSync('/usr/bin/git', ['-C', repo, '-c', 'user.name=Forge Test', '-c', 'user.email=forge@example.test', 'add', 'README.md']);
  execFileSync('/usr/bin/git', ['-C', repo, '-c', 'user.name=Forge Test', '-c', 'user.email=forge@example.test', 'commit', '-qm', 'fixture']);
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const environment = {
    autonomousEnabled: true,
    workspaces: new Map([['fixture', {
      id: 'fixture',
      path: repo,
      autonomousEnabled: true,
      maximumBudgetUsd: 2,
    }]]),
  };
  const { store, plan: original } = setup(t, environment);
  const plan = mutate(store, original, 'item_owner', {
    itemId: original.items[0].id,
    owner: 'claude',
  });
  const configured = store.configureExecution({
    planId: plan.id,
    itemId: plan.items[0].id,
    expectedVersion: plan.version,
    mutationId: 'configure:auto:ready',
    mode: 'autonomous',
    modelAlias: 'sonnet',
    workspaceId: 'fixture',
    budgetUsd: 1.5,
  });
  assert.equal(configured.readiness.ready, true);
  assert.equal(configured.readiness.workspacePath, realpathSync(repo));
  writeFileSync(path.join(repo, 'dirty.txt'), 'dirty\n');
  const dirty = store.getExecutionReadiness(plan.id, plan.items[0].id);
  assert.equal(dirty.ready, false);
  assert.ok(dirty.codes.includes('workspace_dirty'));
});

test('browser execution payloads omit local paths and process identifiers', () => {
  const readiness = {
    ready: true,
    codes: ['ready'],
    checkedAt: '2026-07-10T16:00:00.000Z',
    workspacePath: '/private/allowlisted/project',
  };
  assert.equal(publicExecutionReadiness(readiness).workspacePath, undefined);
  const run = publicExecutionRun({
    id: 'run-public',
    dayPlanId: 'plan-public',
    itemId: 'item-public',
    taskId: 'task-public',
    owner: 'claude',
    mode: 'autonomous',
    modelAlias: 'sonnet',
    status: 'running',
    idempotencyKey: 'public',
    attempt: 1,
    claudeSessionId: '00000000-0000-4000-8000-000000000000',
    briefHash: 'hash',
    promptSnapshot: {
      title: 'Public task',
      outcome: 'A safe public response',
      whyToday: 'Accepted work',
    },
    workspacePath: '/private/allowlisted/project',
    pid: 4242,
    readiness,
    createdAt: '2026-07-10T16:00:00.000Z',
    updatedAt: '2026-07-10T16:00:00.000Z',
  });
  assert.equal(run.workspacePath, undefined);
  assert.equal(run.resumeCommand, undefined);
  assert.equal(run.pid, undefined);
  assert.equal(run.readiness.workspacePath, undefined);
});

test('authorization revisions cancel queued runs for mode, model, budget, and workspace changes', (t) => {
  function gitRepo(label) {
    const repo = path.join(os.tmpdir(), `forge-auth-${label}-${process.pid}-${Date.now()}`);
    mkdirSync(repo);
    writeFileSync(path.join(repo, 'README.md'), `${label}\n`);
    execFileSync('/usr/bin/git', ['-C', repo, 'init', '-q']);
    execFileSync('/usr/bin/git', ['-C', repo, '-c', 'user.name=Forge Test', '-c', 'user.email=forge@example.test', 'add', 'README.md']);
    execFileSync('/usr/bin/git', ['-C', repo, '-c', 'user.name=Forge Test', '-c', 'user.email=forge@example.test', 'commit', '-qm', 'fixture']);
    t.after(() => rmSync(repo, { recursive: true, force: true }));
    return repo;
  }
  const first = gitRepo('first');
  const second = gitRepo('second');
  const environment = {
    autonomousEnabled: true,
    workspaces: new Map([
      ['first', { id: 'first', path: first, autonomousEnabled: true, maximumBudgetUsd: 3 }],
      ['second', { id: 'second', path: second, autonomousEnabled: true, maximumBudgetUsd: 3 }],
    ]),
  };
  const { store, plan: original, file } = setup(t, environment);
  let plan = mutate(store, original, 'item_owner', {
    itemId: original.items[0].id,
    owner: 'claude',
  });
  const itemId = plan.items[0].id;
  let sequence = 0;
  const configure = (patch) => store.configureExecution({
    planId: plan.id, itemId, expectedVersion: plan.version,
    mutationId: `configure:auth:${++sequence}`,
    mode: 'autonomous', modelAlias: 'sonnet', workspaceId: 'first', budgetUsd: 1,
    ...patch,
  }).config;
  const kickoff = () => {
    const result = store.kickoffItem({
      planId: plan.id, itemId, expectedVersion: plan.version,
      mutationId: `kickoff:auth:${++sequence}`,
    });
    plan = result.plan;
    return result.run;
  };

  const started = store.mutateDayPlan({
    planId: plan.id,
    expectedVersion: plan.version,
    mutationId: 'start-day:auth',
    action: 'start_day',
  });
  plan = started.plan;
  const initialConfig = store.getExecutionConfig(plan.id, itemId);
  const modelRun = started.executionRuns[0];
  const modelConfig = configure({ modelAlias: 'opus' });
  assert.notEqual(modelConfig.authorizationHash, initialConfig.authorizationHash);
  assert.equal(store.getExecutionRun(modelRun.id).errorCode, 'authorization_changed');

  const budgetRun = kickoff();
  configure({ modelAlias: 'opus', budgetUsd: 1.5 });
  assert.equal(store.getExecutionRun(budgetRun.id).status, 'cancelled');

  const workspaceRun = kickoff();
  configure({ modelAlias: 'opus', budgetUsd: 1.5, workspaceId: 'second' });
  assert.equal(store.getExecutionRun(workspaceRun.id).errorCode, 'authorization_changed');

  const modeRun = kickoff();
  configure({ mode: 'plan_review', modelAlias: 'opus', workspaceId: undefined, budgetUsd: undefined });
  assert.equal(store.getExecutionRun(modeRun.id).status, 'cancelled');

  const tamperedRun = kickoff();
  const db = new Database(file);
  db.prepare('UPDATE day_plan_execution_configs SET model_alias = ? WHERE day_plan_id = ? AND item_id = ?')
    .run('sonnet', plan.id, itemId);
  db.close();
  assert.equal(store.claimNextExecutionRun(123), undefined);
  assert.equal(store.getExecutionRun(tamperedRun.id).errorCode, 'authorization_changed');

  const metadata = store.listExecutionWorkspaces();
  assert.deepEqual(metadata, [
    { id: 'first', maximumBudgetUsd: 3 },
    { id: 'second', maximumBudgetUsd: 3 },
  ]);
  assert.equal(JSON.stringify(metadata).includes(first), false);
});

test('failed and cancelled runs can be retried under the same current authorization', (t) => {
  const { store, plan: original } = setup(t);
  let plan = mutate(store, original, 'item_owner', {
    itemId: original.items[0].id,
    owner: 'claude',
  });
  const started = store.mutateDayPlan({
    planId: plan.id,
    expectedVersion: plan.version,
    mutationId: 'start-day:retry',
    action: 'start_day',
  });
  plan = started.plan;
  const first = { run: started.executionRuns[0], plan };
  assert.equal(first.run.attempt, 1);
  const claimed = store.claimNextExecutionRun(12345);
  assert.equal(claimed.id, first.run.id);
  store.finishExecutionRun({ runId: claimed.id, errorCode: 'claude_failed' });
  plan = store.getPlan(plan.id);

  const second = store.kickoffItem({
    planId: plan.id,
    itemId: plan.items[0].id,
    expectedVersion: plan.version,
    mutationId: 'kickoff:retry:second',
  });
  assert.notEqual(second.run.id, first.run.id);
  assert.equal(second.run.attempt, 2);
  assert.equal(second.run.status, 'queued');
  const cancelled = store.cancelExecutionRun(second.run.id);
  assert.equal(cancelled.status, 'cancelled');
  plan = store.getPlan(plan.id);

  const third = store.kickoffItem({
    planId: plan.id,
    itemId: plan.items[0].id,
    expectedVersion: plan.version,
    mutationId: 'kickoff:retry:third',
  });
  assert.notEqual(third.run.id, second.run.id);
  assert.equal(third.run.attempt, 3);
  assert.equal(third.run.status, 'queued');
});
