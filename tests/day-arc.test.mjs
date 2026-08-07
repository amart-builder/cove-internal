import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CURRENT_DAY_ARC,
  TODAY2_DAY_ARC,
  getDayProgress,
  pointOnCubicDayArc,
} from '../src/components/tasks/day-arc.ts';

test('the Today sun dot is evaluated from the exact cubic arc at several times', () => {
  assert.equal(getDayProgress(new Date(2026, 7, 6, 6, 0)), 0);
  assert.equal(getDayProgress(new Date(2026, 7, 6, 14, 0)), 0.5);
  assert.equal(getDayProgress(new Date(2026, 7, 6, 22, 0)), 1);

  // pointOnCubicDayArc rounds to 2 decimals so server and client render
  // byte-identical cx/cy attributes (hydration safety).
  const round2 = (value) => Math.round(value * 100) / 100;
  for (const arc of [CURRENT_DAY_ARC, TODAY2_DAY_ARC]) {
    assert.deepEqual(pointOnCubicDayArc(0, arc), arc.start);
    assert.deepEqual(pointOnCubicDayArc(1, arc), arc.end);
    const midpoint = pointOnCubicDayArc(0.5, arc);
    assert.deepEqual(midpoint, {
      x: round2((
        arc.start.x + 3 * arc.controlOne.x +
        3 * arc.controlTwo.x + arc.end.x
      ) / 8),
      y: round2((
        arc.start.y + 3 * arc.controlOne.y +
        3 * arc.controlTwo.y + arc.end.y
      ) / 8),
    });
  }
});
