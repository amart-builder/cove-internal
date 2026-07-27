import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  contentQuotaGap,
  followUpsDue,
  staleOpenItems,
} from '../src/lib/day-plan/gap-detectors.ts';

function fixture(t) {
  const engineDir = path.join(
    os.tmpdir(),
    `forge-gap-detectors-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  const queueDir = path.join(engineDir, 'pipeline', 'queue');
  const postedDir = path.join(engineDir, 'pipeline', 'posted');
  mkdirSync(queueDir, { recursive: true });
  mkdirSync(postedDir, { recursive: true });
  t.after(() => rmSync(engineDir, { recursive: true, force: true }));
  return { engineDir, queueDir, postedDir };
}

function frontmatter(values) {
  return ['---', ...Object.entries(values).map(([key, value]) => `${key}: ${value}`), '---'].join('\n');
}

test('content quota buckets queue and posted timestamps in Pacific time without double-counting posted files', (t) => {
  const { engineDir, queueDir, postedDir } = fixture(t);
  writeFileSync(path.join(queueDir, 'one.md'), frontmatter({
    status: 'scheduled',
    scheduled_for: '2026-07-18T07:00:00Z',
  }));
  writeFileSync(path.join(queueDir, 'two.md'), frontmatter({
    status: 'scheduled',
    scheduled_for: '2026-07-19T06:59:00Z',
  }));
  writeFileSync(path.join(queueDir, 'next-day.md'), frontmatter({
    status: 'scheduled',
    scheduled_for: '2026-07-19T07:00:00Z',
  }));
  writeFileSync(path.join(queueDir, 'review.md'), frontmatter({ status: 'review' }));
  writeFileSync(path.join(postedDir, 'posted.md'), frontmatter({
    status: 'scheduled',
    scheduled_for: '2026-07-18T12:00:00Z',
    posted_at: '2026-07-18T18:00:00Z',
  }));

  assert.deepEqual(contentQuotaGap({
    engineDir,
    targetLocalDate: '2026-07-18',
    quota: 4,
  }), {
    scheduled: 2,
    posted: 1,
    awaitingApproval: 1,
    quota: 4,
    gap: 1,
  });
});

test('content quota fails open when either pipeline directory is missing', (t) => {
  const { engineDir, postedDir } = fixture(t);
  rmSync(postedDir, { recursive: true, force: true });
  assert.equal(contentQuotaGap({ engineDir, targetLocalDate: '2026-07-18', quota: 2 }), null);
});

test('follow-up and stale detectors keep only open items and sort by their factual dates', () => {
  const commitments = [
    {
      id: 'review-first',
      status: 'open',
      due_at: null,
      review_at: '2026-07-18T09:00:00.000Z',
      updated_at: '2026-07-01T00:00:00.000Z',
    },
    {
      id: 'due-tomorrow',
      status: 'open',
      due_at: '2026-07-19T20:00:00.000Z',
      review_at: null,
      updated_at: '2026-07-17T00:00:00.000Z',
    },
    {
      id: 'too-late',
      status: 'open',
      due_at: '2026-07-20T07:00:00.000Z',
      review_at: null,
      updated_at: '2026-07-01T00:00:00.000Z',
    },
    {
      id: 'done-old',
      status: 'done',
      due_at: '2026-07-18T10:00:00.000Z',
      review_at: null,
      updated_at: '2026-06-01T00:00:00.000Z',
    },
  ];

  assert.deepEqual(
    followUpsDue(commitments, '2026-07-18').map((item) => item.id),
    ['review-first', 'due-tomorrow'],
  );
  assert.deepEqual(
    staleOpenItems(commitments, new Date('2026-07-18T00:00:00.000Z')).map((item) => item.id),
    ['review-first', 'too-late'],
  );
});

test('follow-up cutoff is Pacific end-of-tomorrow across DST boundaries', () => {
  const boundaryItems = (included, excluded) => [
    {
      id: 'included',
      status: 'open',
      due_at: included,
      review_at: null,
      updated_at: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'excluded',
      status: 'open',
      due_at: excluded,
      review_at: null,
      updated_at: '2026-01-01T00:00:00.000Z',
    },
  ];

  assert.deepEqual(
    followUpsDue(
      boundaryItems('2026-03-09T06:59:59.999Z', '2026-03-09T07:00:00.000Z'),
      '2026-03-07',
    ).map((item) => item.id),
    ['included'],
  );
  assert.deepEqual(
    followUpsDue(
      boundaryItems('2026-11-02T07:59:59.999Z', '2026-11-02T08:00:00.000Z'),
      '2026-10-31',
    ).map((item) => item.id),
    ['included'],
  );
});
