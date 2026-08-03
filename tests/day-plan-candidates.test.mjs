import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDayPlanCandidates,
  orderArrivalCandidatesByTier,
  selectArrivalCandidateTasks,
} from '../src/lib/day-plan/candidates.ts';

const base = {
  description: '',
  priority: 'medium',
  position: 0,
  column: 'today',
  status: 'open',
  updatedAt: '2026-07-10T15:00:00.000Z',
  refreshedAt: '2026-07-10T16:00:00.000Z',
};

function build(tasks) {
  return buildDayPlanCandidates({
    localDate: '2026-07-10',
    timezone: 'America/Los_Angeles',
    tasks,
  });
}

test('builds at most three deterministic accepted task candidates', () => {
  const tasks = [
    { ...base, id: 'task-low', title: 'Low', priority: 'low', position: 0 },
    { ...base, id: 'task-high', title: 'High', priority: 'high', position: 4 },
    { ...base, id: 'task-mid', title: 'Mid', position: 2 },
    { ...base, id: 'task-flight', title: 'Flight', column: 'in_flight', position: 1 },
  ];

  const first = build(tasks);
  const second = build([...tasks].reverse());
  assert.equal(first.length, 3);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map((candidate) => candidate.taskId),
    ['task-high', 'task-flight', 'task-mid'],
  );
  assert.ok(first.every((candidate) => candidate.commitment === 'ink'));
  assert.ok(first.every((candidate) => candidate.owner === 'me'));
});
test('verified dates rank explicitly while prose never invents urgency', () => {
  const candidates = build([
    {
      ...base,
      id: 'waiting-prose',
      title: 'Maybe reply',
      description: 'A named person is definitely waiting urgently.',
      priority: 'high',
    },
    {
      ...base,
      id: 'due-task',
      title: 'File the form',
      priority: 'low',
      dueAt: '2026-07-10T18:00:00.000Z',
    },
  ]);

  assert.equal(candidates[0].taskId, 'due-task');
  assert.ok(candidates[0].sourceRefs[0].supports.includes('deadline'));
  const prose = candidates.find((candidate) => candidate.taskId === 'waiting-prose');
  assert.equal(prose.sourceRefs[0].supports.includes('waiting_person'), false);
  assert.equal(prose.rankReasons.some((reason) => reason.includes('urgent')), false);
});

test('suppresses stale, closed, malformed, and duplicated evidence', () => {
  const candidates = build([
    { ...base, id: 'stale', title: 'Stale', freshness: 'stale' },
    { ...base, id: 'done', title: 'Done', status: 'done' },
    { ...base, id: 'blank', title: '   ' },
    { ...base, id: 'one', title: 'One', outcomeKey: 'same-outcome' },
    { ...base, id: 'two', title: 'Two', outcomeKey: 'same-outcome', position: 1 },
  ]);

  assert.deepEqual(candidates.map((candidate) => candidate.taskId), ['one']);
});

test('returns an honest empty set when there is no credible work', () => {
  assert.deepEqual(build([]), []);
  assert.deepEqual(
    build([{ ...base, id: 'archived', title: 'Archived', status: 'archived' }]),
    [],
  );
});

test('arrival candidates include dated backlog without admitting undated or held work', () => {
  const tasks = [
    { id: 'today-backlog', columnId: 'backlog', dueAt: '2026-07-11T02:00:00.000Z', position: 3, tags: [] },
    { id: 'overdue-backlog', columnId: 'backlog', dueAt: '2026-07-09T18:00:00.000Z', position: 4, tags: [] },
    { id: 'undated-backlog', columnId: 'backlog', position: 0, tags: [] },
    { id: 'held-backlog', columnId: 'backlog', dueAt: '2026-07-01T18:00:00.000Z', position: 0, tags: [' Jarvis-Held '] },
    { id: 'email-backlog', columnId: 'backlog', dueAt: '2026-07-01T18:00:00.000Z', position: 1, tags: ['email-current'] },
    { id: 'recurring-backlog', columnId: 'backlog', dueAt: '2026-07-01T18:00:00.000Z', position: 2, tags: ['recurring'] },
  ];

  assert.deepEqual(
    selectArrivalCandidateTasks(tasks, {
      localDate: '2026-07-10',
      timezone: 'America/Los_Angeles',
      todayColumnId: 'today',
      inFlightColumnId: 'flight',
      localMode: true,
    }).map((task) => task.id),
    ['overdue-backlog', 'today-backlog'],
  );
});

test('arrival candidate cap keeps commitments first, then due backlog by date and position', () => {
  const tasks = [
    { id: 'today', columnId: 'today', position: 2, tags: [] },
    { id: 'flight', columnId: 'flight', position: 8, tags: [] },
    ...Array.from({ length: 10 }, (_, index) => ({
      id: `backlog-${index}`,
      columnId: 'backlog',
      dueAt: `${index < 2 ? '2026-07-08' : `2026-07-${String(index + 1).padStart(2, '0')}`}T18:00:00.000Z`,
      position: index === 0 ? 5 : index === 1 ? 1 : index,
      tags: [],
    })),
  ];

  assert.deepEqual(
    selectArrivalCandidateTasks(tasks, {
      localDate: '2026-07-10',
      timezone: 'America/Los_Angeles',
      todayColumnId: 'today',
      inFlightColumnId: 'flight',
      localMode: false,
      maximum: 10,
    }).map((task) => task.id),
    [
      'flight',
      'today',
      'backlog-2',
      'backlog-3',
      'backlog-4',
      'backlog-5',
      'backlog-6',
      'backlog-1',
      'backlog-0',
      'backlog-7',
    ],
  );
});

test('composed arrival selection keeps honest backlog labels and evidence rank within tiers', () => {
  const localDate = '2026-08-03';
  const timezone = 'America/Los_Angeles';
  const tasks = [
    {
      id: 'today-undated-low',
      columnId: 'today',
      title: 'Low board-first task',
      priority: 'low',
      position: 0,
      tags: [],
    },
    {
      id: 'today-due-high',
      columnId: 'today',
      title: 'High due-today task',
      priority: 'high',
      dueAt: '2026-08-04T02:00:00.000Z',
      position: 20,
      tags: [],
    },
    {
      id: 'backlog-due-today',
      columnId: 'not-started',
      title: 'Evening backlog deadline',
      priority: 'medium',
      dueAt: '2026-08-04T02:00:00.000Z',
      position: 1,
      tags: [],
    },
  ];
  const selected = selectArrivalCandidateTasks(tasks, {
    localDate,
    timezone,
    todayColumnId: 'today',
    inFlightColumnId: 'flight',
    localMode: true,
    maximum: 10,
  });
  assert.ok(selected.some((task) => task.id === 'backlog-due-today'));

  const built = buildDayPlanCandidates({
    localDate,
    timezone,
    tasks: selected.map((task) => ({
      ...base,
      id: task.id,
      title: task.title,
      priority: task.priority,
      dueAt: task.dueAt,
      position: task.position,
      column: task.columnId === 'flight'
        ? 'in_flight'
        : task.columnId === 'today'
          ? 'today'
          : 'due_backlog',
      updatedAt: '2026-08-03T15:00:00.000Z',
      refreshedAt: '2026-08-03T16:00:00.000Z',
    })),
  }, 10);
  const tierByTaskId = new Map(selected.map((task) => [
    task.id,
    task.columnId === 'today' || task.columnId === 'flight' ? 0 : 1,
  ]));
  const ordered = orderArrivalCandidatesByTier(built, tierByTaskId);

  assert.deepEqual(ordered.map((candidate) => candidate.taskId), [
    'today-due-high',
    'today-undated-low',
    'backlog-due-today',
  ]);
  const backlog = ordered.find((candidate) => candidate.taskId === 'backlog-due-today');
  assert.equal(backlog.whyToday, 'This is due today and still open.');
  assert.ok(backlog.rankReasons.includes('due_backlog'));
  assert.ok(backlog.rankReasons.includes('verified_due_today'));
  assert.equal(backlog.rankReasons.includes('accepted_today'), false);
  assert.equal(backlog.rankReasons.includes('verified_overdue'), false);
  assert.doesNotMatch(backlog.whyToday, /accepted|overdue/i);
});

test('a bare local-date due_at stays on its own day and reads due today, not overdue', () => {
  const localDate = '2026-08-03';
  const timezone = 'America/Los_Angeles';
  const selected = selectArrivalCandidateTasks([
    {
      id: 'legacy-date-only',
      columnId: 'not-started',
      title: 'Legacy date-only deadline',
      priority: 'medium',
      dueAt: '2026-08-03',
      position: 0,
      tags: [],
    },
  ], {
    localDate,
    timezone,
    todayColumnId: 'today',
    inFlightColumnId: 'flight',
    localMode: true,
    maximum: 10,
  });
  assert.equal(selected.length, 1);

  const built = buildDayPlanCandidates({
    localDate,
    timezone,
    tasks: [{
      ...base,
      id: 'legacy-date-only',
      title: 'Legacy date-only deadline',
      priority: 'medium',
      dueAt: '2026-08-03',
      position: 0,
      column: 'due_backlog',
      updatedAt: '2026-08-03T15:00:00.000Z',
      refreshedAt: '2026-08-03T16:00:00.000Z',
    }],
  }, 10);
  assert.equal(built.length, 1);
  assert.ok(built[0].rankReasons.includes('verified_due_today'));
  assert.equal(built[0].rankReasons.includes('verified_overdue'), false);
  assert.equal(built[0].whyToday, 'This is due today and still open.');
});

test('brief picks lead the capped arrival pool and stay deduped', () => {
  const tasks = [
    { id: 'today', columnId: 'today', dueAt: null, position: 0, tags: [] },
    { id: 'picked-backlog', columnId: 'not-started', dueAt: null, position: 0, tags: [] },
    { id: 'due', columnId: 'not-started', dueAt: '2026-08-03', position: 1, tags: [] },
    { id: 'held', columnId: 'not-started', dueAt: null, position: 2, tags: ['jarvis-held'] },
  ];
  const selected = selectArrivalCandidateTasks(tasks, {
    localDate: '2026-08-03',
    timezone: 'America/Los_Angeles',
    todayColumnId: 'today',
    inFlightColumnId: 'flight',
    localMode: true,
    preferredTaskIds: ['picked-backlog', 'today', 'picked-backlog', 'held'],
    maximum: 3,
  });
  assert.deepEqual(selected.map((task) => task.id), ['picked-backlog', 'today', 'due']);
  const built = buildDayPlanCandidates({
    localDate: '2026-08-03',
    timezone: 'America/Los_Angeles',
    tasks: [{
      ...base,
      id: 'picked-backlog',
      title: 'Strategic backlog',
      column: 'due_backlog',
      briefPicked: true,
      updatedAt: '2026-08-03T15:00:00.000Z',
      refreshedAt: '2026-08-03T16:00:00.000Z',
    }],
  }, 10);
  assert.equal(built[0].taskId, 'picked-backlog');
  assert.ok(built[0].rankReasons.includes('brief_pick_transport'));
});

test('bounds task prose to the day-plan API contract without dropping the task', () => {
  const [candidate] = build([
    {
      ...base,
      id: 'long-task',
      title: 'A'.repeat(300),
      description: 'B'.repeat(2685),
      project: 'C'.repeat(180),
    },
  ]);

  assert.equal(candidate.taskId, 'long-task');
  assert.equal(candidate.title.length, 240);
  assert.equal(candidate.outcome.length, 1200);
  assert.equal(candidate.project.length, 120);
  assert.match(candidate.title, /…$/);
  assert.match(candidate.outcome, /…$/);
});

test('oversized identity metadata cannot collapse tasks or reject the whole plan', () => {
  const sharedPrefix = 'same'.repeat(70);
  const candidates = build([
    {
      ...base,
      id: 'task-one',
      title: 'One',
      outcomeKey: `${sharedPrefix}-one`,
      humanDecisionEventIds: [
        ...Array.from({ length: 24 }, (_, index) => `event-${index}`),
        'X'.repeat(201),
      ],
    },
    {
      ...base,
      id: 'task-two',
      title: 'Two',
      position: 1,
      outcomeKey: `${sharedPrefix}-two`,
    },
  ]);

  assert.deepEqual(candidates.map((candidate) => candidate.outcomeKey), [
    'task:task-one',
    'task:task-two',
  ]);
  assert.equal(candidates[0].humanDecisionEventIds.length, 20);
  assert.ok(candidates[0].humanDecisionEventIds.every((eventId) => eventId.length <= 200));
});
