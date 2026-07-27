import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDayPlanCandidates } from '../src/lib/day-plan/candidates.ts';

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
