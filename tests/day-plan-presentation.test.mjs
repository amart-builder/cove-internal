import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  advanceMorningBriefAttachPoll,
  allSettlementDecisionsMade,
  claudeResumeUrl,
  canStartDayPlanSettlement,
  arrivalStartDayUnavailableReason,
  dayCloseUnavailableReason,
  combineSurfaceErrors,
  firstContinuingItem,
  focusBandItems,
  focusCountAfterArrivalDrag,
  executionReadinessMessage,
  executionRestartLabel,
  executionRunStatusLabel,
  executionWorkspaceLabel,
  helpfulProjectLabel,
  isMorningBriefWriting,
  morningBriefArrivalPresentation,
  morningBriefPendingLabel,
  MORNING_BRIEF_ATTACH_POLL_LIMIT,
  morningArrivalGreeting,
  ownerDescription,
  reorderDayPlanItems,
  resolveRitualContentSwap,
  selectBoardExecutionPresentation,
  selectCurrentExecutionRow,
  selectRecommendedHumanFocus,
  selectShelfTasks,
  shouldShowNeedsSetupToStart,
  shouldAutoPostProgress,
  shouldAttemptLateBriefAttach,
  shortArrivalSummary,
  shouldPollBriefGeneration,
  staleSettlementNotice,
  startDayReceiptCopy,
} from '../src/lib/day-plan/presentation.ts';
import { buildClaudeResumeCommand } from '../src/lib/claude-execution/resume-command.ts';

test('morning arrival greeting follows the plan timezone', () => {
  const timezone = 'America/Los_Angeles';
  assert.equal(morningArrivalGreeting(new Date('2026-07-16T17:00:00.000Z'), timezone), 'Good morning.');
  assert.equal(morningArrivalGreeting(new Date('2026-07-16T21:00:00.000Z'), timezone), 'Good afternoon.');
  assert.equal(morningArrivalGreeting(new Date('2026-07-17T02:00:00.000Z'), timezone), 'Good evening.');
});

test('a date-only arrival due date stays on its local calendar day', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      "import presentation from './src/lib/day-plan/presentation.ts'; process.stdout.write(presentation.formatArrivalDueDate('2026-08-04'));",
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, TZ: 'America/Los_Angeles' },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Aug 4');
});
import {
  planTaskReconciliation,
  reconciliationStateMatches,
} from '../src/lib/day-plan/reconciliation.ts';

function item(id, owner = 'me', position = 0) {
  return { id, taskId: `task-${id}`, owner, position };
}

test('drag reorder produces the same ordered plan without mutating input', () => {
  const original = [item('a', 'me', 0), item('b', 'me', 1), item('c', 'me', 2)];
  const reordered = reorderDayPlanItems(original, 'c', 'a');
  assert.deepEqual(reordered.map((entry) => entry.id), ['c', 'a', 'b']);
  assert.deepEqual(reordered.map((entry) => entry.position), [0, 1, 2]);
  assert.deepEqual(original.map((entry) => entry.id), ['a', 'b', 'c']);
  assert.deepEqual(original.map((entry) => entry.position), [0, 1, 2]);
});

test('arrival drag grows and shrinks the initial-priority band between one and three', () => {
  const items = [item('a', 'me', 0), item('b', 'me', 1), item('c', 'me', 2), item('d', 'me', 3)];

  assert.equal(focusCountAfterArrivalDrag(items, 'c', 'a', 1), 2);
  assert.equal(focusCountAfterArrivalDrag(items, 'd', 'a', 2), 3);
  assert.equal(focusCountAfterArrivalDrag(items, 'd', 'a', 3), 3);
  assert.equal(focusCountAfterArrivalDrag(items, 'b', 'c', 2), 1);
  assert.equal(focusCountAfterArrivalDrag(items, 'a', 'c', 1), 1);
  assert.equal(focusCountAfterArrivalDrag(items, 'a', 'b', 2), 2);
});

test('recommended focus is the highest ordered item involving the person', () => {
  const items = [item('claude', 'claude'), item('together', 'together'), item('me', 'me')];
  assert.equal(selectRecommendedHumanFocus(items)?.id, 'together');
  assert.equal(selectRecommendedHumanFocus(items, 'me')?.id, 'me');
});

test('an all-Claude plan still yields one deterministic handoff-preparation focus', () => {
  const items = [item('first', 'claude'), item('second', 'claude')];
  assert.equal(selectRecommendedHumanFocus(items)?.id, 'first');
  assert.equal(
    ownerDescription('claude', 'supabase'),
    'Starts a full Claude session in auto-edits mode when you start your day.',
  );
  assert.equal(
    ownerDescription('together', 'supabase'),
    'Starts the same task in plan mode when you start your day.',
  );
});

test('settlement derives tomorrow from progress before carry', () => {
  const items = [item('a'), item('b'), item('c')];
  const decisions = { a: 'carry', b: 'progress', c: 'drop' };
  assert.equal(firstContinuingItem(items, decisions)?.id, 'b');
  assert.equal(firstContinuingItem(items, { a: 'defer', b: 'carry', c: 'drop' })?.id, 'b');
  assert.equal(allSettlementDecisionsMade(items, decisions), true);
  assert.equal(allSettlementDecisionsMade(items, { a: 'carry' }), false);
});

test('automatic Progress preselection stops after two attempts per item', () => {
  assert.equal(shouldAutoPostProgress({ workedToday: true, hasDecision: false, attempts: 0 }), true);
  assert.equal(shouldAutoPostProgress({ workedToday: true, hasDecision: false, attempts: 1 }), true);
  assert.equal(shouldAutoPostProgress({ workedToday: true, hasDecision: false, attempts: 2 }), false);
  assert.equal(shouldAutoPostProgress({ workedToday: true, hasDecision: true, attempts: 0 }), false);
  assert.equal(shouldAutoPostProgress({ workedToday: false, hasDecision: false, attempts: 0 }), false);
});

test('arrival summaries stay genuinely short while preserving the stored description elsewhere', () => {
  const description = 'Review the complete client proposal, resolve the open pricing question, and prepare the final version for the decision meeting tomorrow morning.';
  const summary = shortArrivalSummary(description, 'Finalize the proposal');
  assert.ok(summary);
  assert.ok(summary.length <= 96);
  assert.match(summary, /…$/);
  assert.equal(shortArrivalSummary('Finalize the proposal', 'Finalize the proposal'), undefined);
});

test('project pills suppress operational tags and overlong labels', () => {
  assert.equal(helpfulProjectLabel('Catalyst'), 'Catalyst');
  assert.equal(helpfulProjectLabel('captured-today'), undefined);
  assert.equal(helpfulProjectLabel('x'.repeat(33)), undefined);
});

test('execution states use truthful non-completion labels', () => {
  assert.equal(executionRunStatusLabel('queued'), 'Waiting to start');
  assert.equal(executionRunStatusLabel('starting'), 'Waiting to start');
  assert.equal(executionRunStatusLabel('running'), 'Claude · working');
  assert.equal(executionRunStatusLabel('plan_ready'), 'Needs you · Review plan');
  assert.equal(executionRunStatusLabel('awaiting_review'), 'Needs you · Review plan');
  assert.equal(executionRunStatusLabel('cancelling'), 'Stopping…');
  assert.equal(executionRunStatusLabel('failed'), "Didn't finish · Retry");
  assert.equal(executionRunStatusLabel('cancelled'), 'Stopped · Restart');
  assert.notEqual(executionRunStatusLabel('cancelled'), executionRunStatusLabel('failed'));
  assert.notEqual(executionRunStatusLabel('plan_ready'), 'Completed');
});

test('readiness copy explains mode and brief resets without exposing paths', () => {
  assert.equal(
    executionReadinessMessage({ ready: false, codes: ['mode_required'], checkedAt: '' }, 'claude'),
    'Choose Plan with Claude or Hands-off before kickoff.',
  );
  assert.equal(
    executionReadinessMessage({ ready: false, codes: ['owner_not_agent'], checkedAt: '' }, 'claude'),
    'Choose Plan with Claude or Hands-off before kickoff.',
  );
  assert.equal(
    executionReadinessMessage({ ready: false, codes: ['brief_changed'], checkedAt: '' }, 'together'),
    'The brief changed. Choose a mode again to refresh it.',
  );
  const workspaceCopy = executionReadinessMessage({
    ready: false,
    codes: ['workspace_dirty'],
    checkedAt: '',
    workspacePath: '/secret/client/repo',
  }, 'claude');
  assert.equal(workspaceCopy.includes('/secret'), false);
});

test('an overdue defer is applied before its resurface against updated task state', () => {
  const columns = { notStartedId: 'not-started', todayId: 'today' };
  let state = { columnId: 'today', status: 'open' };

  const deferred = planTaskReconciliation('defer', state, columns);
  assert.deepEqual(deferred.patch, { columnId: 'not-started', status: 'open' });
  state = deferred.nextState;
  assert.equal(reconciliationStateMatches(state, deferred.nextState), true);

  const resurfaced = planTaskReconciliation('resurface', state, columns);
  assert.deepEqual(resurfaced.patch, { columnId: 'today', status: 'open' });
  state = resurfaced.nextState;
  assert.equal(reconciliationStateMatches(state, resurfaced.nextState), true);
});

function run(overrides = {}) {
  return {
    id: 'run-1',
    itemId: 'item-a',
    briefHash: 'brief-1',
    authorizationHash: 'auth-1',
    mode: 'plan_review',
    status: 'queued',
    createdAt: '2026-07-10T16:00:00.000Z',
    claudeSessionId: '00000000-0000-4000-8000-000000000000',
    ...overrides,
  };
}

function config(overrides = {}) {
  return { briefHash: 'brief-1', authorizationHash: 'auth-1', mode: 'plan_review', ...overrides };
}

test('current execution row takes the latest attempt only when brief, authorization, and mode still match', () => {
  const older = run({ id: 'old', createdAt: '2026-07-10T15:00:00.000Z' });
  const newer = run({ id: 'new', createdAt: '2026-07-10T16:00:00.000Z' });
  const other = run({ id: 'other-item', itemId: 'item-b' });
  const matched = selectCurrentExecutionRow([older, newer, other], 'item-a', config());
  assert.equal(matched.latestRun.id, 'new');
  assert.equal(matched.currentRun.id, 'new');

  // A drifted brief makes the latest run stale, so it is never surfaced as current.
  const stale = selectCurrentExecutionRow([newer], 'item-a', config({ briefHash: 'brief-2' }));
  assert.equal(stale.latestRun.id, 'new');
  assert.equal(stale.currentRun, undefined);

  assert.equal(selectCurrentExecutionRow([newer], 'item-a', undefined).currentRun, undefined);
});

test('board execution selector drives hero actions and retry-only kickoff visibility', () => {
  assert.deepEqual(
    selectBoardExecutionPresentation({ owner: 'claude' }),
    { action: 'start_plan', showKickoff: true, reviewable: false },
  );
  assert.deepEqual(
    selectBoardExecutionPresentation({ owner: 'me' }),
    { action: 'none', showKickoff: false, reviewable: false },
  );

  assert.deepEqual(
    selectBoardExecutionPresentation({ owner: 'claude', run: run({ status: 'failed' }) }),
    {
      statusLabel: "Didn't finish · Retry",
      action: 'retry',
      showKickoff: true,
      reviewable: false,
    },
  );
  for (const status of ['interrupted', 'cancelled']) {
    assert.deepEqual(selectBoardExecutionPresentation({ owner: 'claude', run: run({ status }) }), {
      statusLabel: 'Stopped · Restart',
      action: 'restart',
      showKickoff: true,
      reviewable: false,
    }, status);
    assert.equal(executionRestartLabel(status), 'Restart');
  }
  assert.equal(executionRestartLabel('failed'), 'Retry');

  for (const [status, statusLabel] of [
    ['queued', 'Waiting to start'],
    ['starting', 'Waiting to start'],
    ['running', 'Claude · working'],
  ]) {
    const presentation = selectBoardExecutionPresentation({ owner: 'together', run: run({ status }) });
    assert.equal(presentation.statusLabel, statusLabel, status);
    assert.equal(presentation.action, 'none', status);
    assert.equal(presentation.showKickoff, false, status);
  }

  for (const status of ['plan_ready', 'ready_to_join', 'awaiting_review']) {
    const presentation = selectBoardExecutionPresentation({ owner: 'claude', run: run({ status }) });
    assert.equal(presentation.statusLabel, 'Needs you · Review plan', status);
    assert.equal(presentation.action, 'open', status);
    assert.equal(presentation.reviewable, true, status);
    assert.equal(presentation.showKickoff, false, status);
  }

  const missingSession = selectBoardExecutionPresentation({
    owner: 'claude',
    run: run({ status: 'plan_ready', claudeSessionId: undefined }),
  });
  assert.deepEqual(missingSession, {
    statusLabel: 'Needs you · Review plan',
    action: 'restart',
    showKickoff: true,
    reviewable: true,
  });

  assert.deepEqual(
    selectBoardExecutionPresentation({ owner: 'claude', run: run(), taskDone: true }),
    { statusLabel: 'Done', action: 'none', showKickoff: false, reviewable: false },
  );
});

test('needs-setup chip is derived only for agent work skipped after the day starts', () => {
  const base = { planState: 'active', owner: 'claude', hasRun: false };
  assert.equal(shouldShowNeedsSetupToStart(base), true);
  assert.equal(shouldShowNeedsSetupToStart({ ...base, owner: 'together' }), true);
  assert.equal(shouldShowNeedsSetupToStart({ ...base, owner: 'me' }), false);
  assert.equal(shouldShowNeedsSetupToStart({ ...base, hasRun: true }), false);
  assert.equal(shouldShowNeedsSetupToStart({ ...base, planState: 'settled' }), false);
  assert.equal(shouldShowNeedsSetupToStart({ ...base, taskDone: true }), false);
  assert.equal(shouldShowNeedsSetupToStart({ ...base, startDayApplying: true }), false);
});

test('start-day receipt keeps setup details out and mentions only work already moving', () => {
  assert.equal(startDayReceiptCopy(2, 0), 'Claude is starting on 2 items.');
  assert.equal(startDayReceiptCopy(1, 2), 'Claude is starting on 1 item. 2 already in motion.');
  assert.equal(startDayReceiptCopy(0, 0).includes('setup'), false);
  assert.equal(startDayReceiptCopy(0, 0).includes('worker'), false);
  assert.equal(
    startDayReceiptCopy(1, 0, ['Second focus']),
    'Claude is starting on 1 item. Could not start: Second focus.',
  );
});

test('focus band matches Start My Day by retaining only preselected and accepted items', () => {
  const items = [
    { id: 'completed', position: 0, decision: 'completed' },
    { id: 'first', position: 1, decision: 'accepted' },
    { id: 'later', position: 2, decision: 'later' },
    { id: 'second', position: 3, decision: 'preselected' },
    { id: 'third', position: 4, decision: 'pending' },
    { id: 'fourth', position: 5, decision: 'accepted' },
  ];
  assert.deepEqual(focusBandItems(items, 3).map((item) => item.id), [
    'first', 'second', 'fourth',
  ]);
  assert.deepEqual(focusBandItems(items, 1).map((item) => item.id), ['first']);
  assert.deepEqual(focusBandItems(items, Number.NaN).map((item) => item.id), [
    'first', 'second', 'fourth',
  ]);
});

test('settlement availability includes snoozed proposed plans and matches active states', () => {
  const base = { state: 'proposed', arrivalState: 'opened', settlementState: 'not_due' };
  assert.equal(canStartDayPlanSettlement(base), false);
  assert.equal(canStartDayPlanSettlement({ ...base, arrivalState: 'snoozed' }), true);
  assert.equal(canStartDayPlanSettlement({ ...base, state: 'active' }), true);
  assert.equal(canStartDayPlanSettlement({
    ...base,
    state: 'settling',
    settlementState: 'in_progress',
  }), true);
});

test('a dimmed Close My Day always says why, and says nothing when it is available', () => {
  const base = { state: 'proposed', arrivalState: 'opened', settlementState: 'not_due' };
  // No plan yet, on a weekday and on a weekend.
  assert.match(dayCloseUnavailableReason({}), /once today's plan is ready/);
  assert.match(
    dayCloseUnavailableReason({ weekendWeekday: 'Saturday' }),
    /paused on Saturday/,
  );
  // The state the demo day actually sits in: planned, but he has not been
  // through Morning Arrival, so closing has nothing to settle yet.
  assert.match(
    dayCloseUnavailableReason({ plan: base }),
    /Morning Arrival first/,
  );
  assert.equal(dayCloseUnavailableReason({ plan: base, busy: true }), "Cove is updating today's plan.");
  assert.equal(
    dayCloseUnavailableReason({ plan: { ...base, state: 'settled' } }),
    'Today is already closed.',
  );
  // Available: no reason to show, which is what leaves the button enabled.
  assert.equal(dayCloseUnavailableReason({ plan: { ...base, state: 'active' } }), undefined);
  assert.equal(
    dayCloseUnavailableReason({ plan: { ...base, arrivalState: 'snoozed' } }),
    undefined,
  );
  // Whenever closing is unavailable there is a sentence for it, and whenever it
  // is available there is not: the button and the explanation cannot disagree.
  for (const plan of [
    undefined, base, { ...base, state: 'active' }, { ...base, state: 'settled' },
    { ...base, arrivalState: 'bypassed' }, { ...base, state: 'settling', settlementState: 'in_progress' },
  ]) {
    const reason = dayCloseUnavailableReason({ plan });
    const available = plan ? canStartDayPlanSettlement(plan) : false;
    assert.equal(Boolean(reason), !available, JSON.stringify(plan));
  }
});

test('resume command quotes both workspace and session for the copy fallback', () => {
  assert.equal(
    buildClaudeResumeCommand("/tmp/Jordan Rivers's project", 'session id'),
    `cd '/tmp/Jordan Rivers'"'"'s project' && claude --resume 'session id'`,
  );
  assert.equal(
    buildClaudeResumeCommand('/projects/acme-site', 'session-id', {
      permissionMode: 'auto',
      safeMode: true,
      tools: 'Read,Write',
      settingsPath: "/tmp/Cove's settings.json",
      mcpConfigPath: '/tmp/empty-mcp.json',
      noChrome: true,
    }),
    "cd '/projects/acme-site' && claude --resume 'session-id' --permission-mode auto --safe-mode --tools 'Read,Write' --settings '/tmp/Cove'\"'\"'s settings.json' --strict-mcp-config --mcp-config '/tmp/empty-mcp.json' --no-chrome",
  );
  assert.equal(executionWorkspaceLabel('/projects/acme-site'), 'Acme site');
});

test('brief-generation poll runs only on a visible, untouched arrival while writing', () => {
  const base = {
    view: 'arrival',
    documentVisible: true,
    briefAttached: false,
    arrivalInteracted: false,
    attachTimedOut: false,
    generationState: 'running',
  };
  assert.equal(shouldPollBriefGeneration(base), true);
  assert.equal(shouldPollBriefGeneration({ ...base, generationState: 'queued' }), true);
  assert.equal(shouldPollBriefGeneration({ ...base, generationState: 'succeeded' }), true);
  // The gate closes on every off condition.
  assert.equal(shouldPollBriefGeneration({ ...base, view: 'none' }), false);
  assert.equal(shouldPollBriefGeneration({ ...base, documentVisible: false }), false);
  assert.equal(shouldPollBriefGeneration({ ...base, arrivalInteracted: true }), false);
  assert.equal(shouldPollBriefGeneration({ ...base, briefAttached: true }), false);
  assert.equal(shouldPollBriefGeneration({ ...base, attachTimedOut: true }), true);
  assert.equal(
    shouldPollBriefGeneration({
      ...base,
      generationState: 'succeeded',
      attachTimedOut: true,
    }),
    false,
  );
  assert.equal(shouldPollBriefGeneration({ ...base, generationState: 'failed' }), false);
  assert.equal(shouldPollBriefGeneration({ ...base, generationState: 'idle' }), false);
  assert.equal(shouldPollBriefGeneration({ ...base, generationState: undefined }), false);
});

test('morning brief writing state covers the pristine succeeded-but-unattached window', () => {
  const base = {
    briefAttached: false,
    arrivalInteracted: false,
    attachTimedOut: false,
  };
  assert.equal(isMorningBriefWriting({ ...base, generationState: 'queued' }), true);
  assert.equal(isMorningBriefWriting({ ...base, generationState: 'running' }), true);
  assert.equal(isMorningBriefWriting({ ...base, generationState: 'succeeded' }), true);
  assert.equal(
    isMorningBriefWriting({ ...base, briefAttached: true, generationState: 'queued' }),
    false,
  );
  assert.equal(
    isMorningBriefWriting({ ...base, briefAttached: true, generationState: 'running' }),
    false,
  );
  assert.equal(
    isMorningBriefWriting({ ...base, arrivalInteracted: true, generationState: 'succeeded' }),
    false,
  );
  assert.equal(
    isMorningBriefWriting({ ...base, attachTimedOut: true, generationState: 'succeeded' }),
    false,
  );
  assert.equal(isMorningBriefWriting({ ...base, generationState: 'failed' }), false);
  assert.equal(isMorningBriefWriting({ ...base, generationState: 'idle' }), false);
  assert.equal(isMorningBriefWriting({ ...base, generationState: undefined }), false);
});

test('succeeded attach polling stops at the cap and exposes the stalled recovery path', () => {
  let pollState = { consecutiveSucceededPolls: 0, attachTimedOut: false };
  for (let poll = 0; poll < MORNING_BRIEF_ATTACH_POLL_LIMIT; poll += 1) {
    pollState = advanceMorningBriefAttachPoll({
      consecutiveSucceededPolls: pollState.consecutiveSucceededPolls,
      briefAttached: false,
      generationState: 'succeeded',
    });
    assert.equal(
      pollState.attachTimedOut,
      poll + 1 === MORNING_BRIEF_ATTACH_POLL_LIMIT,
    );
  }

  const writing = isMorningBriefWriting({
    briefAttached: false,
    arrivalInteracted: false,
    attachTimedOut: pollState.attachTimedOut,
    generationState: 'succeeded',
  });
  assert.equal(writing, false);
  assert.equal(shouldPollBriefGeneration({
    view: 'arrival',
    documentVisible: true,
    briefAttached: false,
    arrivalInteracted: false,
    attachTimedOut: pollState.attachTimedOut,
    generationState: 'succeeded',
  }), false);
  assert.deepEqual(
    morningBriefArrivalPresentation({
      paragraphs: ['A deterministic fallback must not masquerade as the brief.'],
      hasBriefContent: false,
      briefWriting: writing,
      briefAttached: false,
      generationState: 'succeeded',
    }),
    {
      stalled: true,
      failed: false,
      leadHeadline: "Today's brief isn't written yet.",
      body: [],
    },
  );
});

test('a saturated attach-poll counter resets on attach and on a new generation', () => {
  const saturated = MORNING_BRIEF_ATTACH_POLL_LIMIT;
  assert.deepEqual(
    advanceMorningBriefAttachPoll({
      consecutiveSucceededPolls: saturated,
      briefAttached: true,
      generationState: 'succeeded',
    }),
    { consecutiveSucceededPolls: 0, attachTimedOut: false },
  );
  assert.deepEqual(
    advanceMorningBriefAttachPoll({
      consecutiveSucceededPolls: saturated,
      briefAttached: false,
      generationState: 'running',
    }),
    { consecutiveSucceededPolls: 0, attachTimedOut: false },
  );
});

test('brief pending copy distinguishes queued work from finishing attachment', () => {
  assert.equal(morningBriefPendingLabel('queued'), 'Your brief is queued…');
  assert.equal(morningBriefPendingLabel('succeeded'), 'Finishing up…');
});

test('client arrival-heal gate accepts the exact pristine route payload with omitted optional fields', () => {
  const response = {
    currentPlan: {
      id: 'bb572818-repro',
      localDate: '2026-07-19',
      timezone: 'America/Detroit',
      state: 'proposed',
      arrivalState: 'opened',
      settlementState: 'not_due',
      version: 2,
      lastMutationId: 'arrival-open:repro',
      items: [],
      createdAt: '2026-07-19T12:00:00.000Z',
      updatedAt: '2026-07-19T12:00:00.000Z',
    },
    briefGeneration: { state: 'succeeded' },
  };
  const plan = response.currentPlan;
  const input = {
    planState: plan.state,
    arrivalState: plan.arrivalState,
    hasConsumedBrief: Boolean(plan.briefId),
    arrivalInteractedAt: plan.arrivalInteractedAt,
    interacted: false,
    documentVisible: true,
    candidatesReady: true,
    candidateCount: 3,
    generationState: response.briefGeneration.state,
    itemCount: plan.items.length,
    alreadyAttempted: false,
  };
  assert.equal('briefId' in plan, false);
  assert.equal('arrivalInteractedAt' in plan, false);
  assert.equal(shouldAttemptLateBriefAttach(input), true);
  assert.equal(shouldAttemptLateBriefAttach({ ...input, alreadyAttempted: true }), false);
  assert.equal(
    shouldAttemptLateBriefAttach({ ...input, candidatesReady: false, candidateCount: 0 }),
    true,
    'a completed brief opens the attachment path even when there are no items to heal',
  );
  assert.equal(
    shouldAttemptLateBriefAttach({ ...input, candidatesReady: true, candidateCount: 0 }),
    true,
    'brief attachment remains independent from candidate-backed item healing',
  );
});

test('claude resume deep link encodes the session id', () => {
  assert.equal(
    claudeResumeUrl('00000000-0000-4000-8000-000000000000'),
    'claude://resume?session=00000000-0000-4000-8000-000000000000',
  );
  assert.equal(claudeResumeUrl('a b/c'), 'claude://resume?session=a%20b%2Fc');
});

test('ritual view swaps crossfade, cut immediately under reduced motion, and skip no-ops', () => {
  assert.equal(
    resolveRitualContentSwap({ displayedKey: 'arrival', nextKey: 'arrival', reducedMotion: false }),
    'none',
  );
  assert.equal(
    resolveRitualContentSwap({ displayedKey: 'arrival', nextKey: 'arrival', reducedMotion: true }),
    'none',
  );
  assert.equal(
    resolveRitualContentSwap({ displayedKey: 'arrival', nextKey: 'settlement', reducedMotion: false }),
    'crossfade',
  );
  assert.equal(
    resolveRitualContentSwap({ displayedKey: 'arrival', nextKey: 'settlement', reducedMotion: true }),
    'immediate',
  );
});

test('settlement explains itself only when the plan being closed is not today', () => {
  assert.equal(staleSettlementNotice('2026-07-14', '2026-07-14'), undefined);
  assert.equal(
    staleSettlementNotice('2026-07-31', '2026-08-03'),
    "Friday, July 31 was never closed. Close it before today's plan begins.",
  );
  assert.equal(staleSettlementNotice('2026-07-31', '2026-08-03').includes('yesterday'), false);
});

test('writing brief presentation never exposes the deterministic fallback', () => {
  const fallback = 'Cove does not have enough current evidence to choose your first move yet.';
  for (const generationState of ['queued', 'running', 'succeeded']) {
    const presentation = morningBriefArrivalPresentation({
      paragraphs: [fallback],
      hasBriefContent: false,
      briefWriting: true,
      briefAttached: false,
      generationState,
    });
    assert.equal(presentation.leadHeadline, 'Your brief is on the way.');
    assert.deepEqual(presentation.body, []);
    assert.equal(JSON.stringify(presentation).includes(fallback), false);
  }
});

test('ritual and secondary surface failures remain visible together', () => {
  assert.equal(
    combineSurfaceErrors('Morning Arrival could not load.', 'Suggestions are unavailable.'),
    'Morning Arrival could not load. Suggestions are unavailable.',
  );
  assert.equal(
    combineSurfaceErrors('Morning Arrival could not load.', 'Morning Arrival could not load.'),
    'Morning Arrival could not load.',
  );
});

test('the shelf holds only the email current and recurring occurrences', () => {
  const shelf = selectShelfTasks([
    { _id: 'held', title: 'One-off held by Cove', tags: ['jarvis-held'], position: 0 },
    { _id: 'email', title: 'Email needs you', tags: ['email-current'], position: 1 },
    { _id: 'tagged', title: 'Tag without a template link', tags: ['recurring'], position: 2 },
    { _id: 'rhythm', title: 'Water the plants', tags: ['recurring'], recurringTemplateId: 'template-1', position: 3 },
    { _id: 'plain', title: 'Ordinary task', tags: [], position: 4 },
  ]);
  // Recurring occurrences sort ahead of the email card; jarvis-held one-offs
  // and tag-only "recurring" tasks stay off the shelf entirely.
  assert.deepEqual(shelf.map((task) => task._id), ['rhythm', 'email']);
});

test('the shelf overflow count reflects the filtered list, not held one-offs', () => {
  const tasks = [
    { _id: 'held-a', tags: ['jarvis-held'], position: 0 },
    { _id: 'held-b', tags: ['jarvis-held'], position: 1 },
    { _id: 'email', tags: ['Email-Current '], position: 2 },
    ...['a', 'b', 'c', 'd'].map((suffix, index) => ({
      _id: `rhythm-${suffix}`,
      tags: ['recurring'],
      recurringTemplateId: `template-${suffix}`,
      position: 3 + index,
    })),
  ];
  const shelf = selectShelfTasks(tasks);
  assert.equal(shelf.length, 5);
  // The shelf shows three cards; the tail button reads "+2 more on the shelf".
  assert.equal(shelf.length - 3, 2);
  assert.deepEqual(
    shelf.map((task) => task._id),
    ['rhythm-a', 'rhythm-b', 'rhythm-c', 'rhythm-d', 'email'],
  );
});


test('full saved brief stays visible while a later attempt waits or fails', () => {
  for (const generationState of ['queued', 'running', 'deferred', 'failed', 'succeeded']) {
    const result = morningBriefArrivalPresentation({ headline: 'The full brief', paragraphs: ['First complete paragraph.', 'Second complete paragraph.'], hasBriefContent: true, briefAttached: true, briefWriting: false, generationState });
    assert.equal(result.leadHeadline, 'The full brief');
    assert.deepEqual(result.body, ['First complete paragraph.', 'Second complete paragraph.']);
    assert.equal(result.failed, false);
    assert.equal(result.stalled, false);
  }
});

test('missing or unreadable brief never displays task fallback text', () => {
  for (const generationState of ['queued', 'running', 'deferred', 'failed', 'succeeded']) {
    for (const briefAttached of [true, false]) {
      const result = morningBriefArrivalPresentation({ headline: 'Current task', paragraphs: ['Added from Not today.'], hasBriefContent: false, briefAttached, briefWriting: generationState === 'running', generationState });
      assert.deepEqual(result.body, []);
      assert.doesNotMatch(result.leadHeadline ?? '', /Current task|Added from Not today/);
    }
  }
});

test('a dimmed Start my day always says what would un-dim it', () => {
  // The arrival covers the screen: a dimmed button with no sentence beside it
  // is the whole of what a person can see, and on a brand-new install with no
  // tasks that is exactly the state they arrive in.
  assert.equal(
    arrivalStartDayUnavailableReason({ finalStep: true, plannedCount: 1 }),
    undefined,
  );
  assert.match(
    arrivalStartDayUnavailableReason({ finalStep: true, plannedCount: 0 }),
    /Continue to Today/,
  );
  assert.match(
    arrivalStartDayUnavailableReason({ finalStep: true, plannedCount: 3, busy: true }),
    /setting your day/i,
  );
  assert.match(
    arrivalStartDayUnavailableReason({ finalStep: true, plannedCount: 3, buddyActive: true }),
    /Buddy/,
  );
  // Earlier steps advance the ritual rather than start the day, so they are
  // never blocked by an empty plan.
  for (const plannedCount of [0, 1, 3]) {
    assert.equal(
      arrivalStartDayUnavailableReason({ finalStep: false, plannedCount, busy: true }),
      undefined,
    );
  }
});
