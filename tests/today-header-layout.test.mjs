import assert from 'node:assert/strict';
import test from 'node:test';
import { todayStageLayout } from '../src/components/tasks/today2/layout.ts';

test('growing header controls never intersect focus work or clip the grid control', () => {
  for (const [width, height] of [[1280, 720], [1440, 900], [1024, 640], [851, 500], [850, 500], [750, 500], [700, 500], [390, 844], [320, 568]]) {
    for (const headerBottom of [190, 270, 420, 680]) {
      for (const focusCount of [1, 2, 3]) {
        const focusHeight = width <= 850 ? focusCount * 158 + (focusCount - 1) * 14
          : width <= 1180 && focusCount === 3 ? 330 : 158;
        for (const secondCurrentHeight of [84, 310]) {
          const layout = todayStageLayout({ width, height, headerBottom, focusCount, focusHeight, secondCurrentHeight });
          assert.ok(layout.focusTop >= headerBottom + 24);
          assert.ok(layout.focusTop >= layout.secondTop + secondCurrentHeight + 24);
          assert.ok(layout.focusTop + focusHeight <= layout.contentHeight - 129);
          assert.ok(layout.contentHeight >= height);
          if (width <= 850) {
            assert.ok(layout.secondTop >= headerBottom + 24);
            assert.ok(layout.doneTop >= layout.secondTop + secondCurrentHeight);
            assert.ok(layout.doneTop + 28 <= layout.focusTop);
          }
        }
      }
    }
  }
});

test('short desktop header retains the original focus position; empty state also clears tall headers', () => {
  const normal = todayStageLayout({ width: 1280, height: 720, headerBottom: 180, focusCount: 3, focusHeight: 158, secondCurrentHeight: 84 });
  assert.equal(normal.contentHeight, 720);
  assert.equal(normal.focusTop, Math.ceil(720 * .46 - 79));
  const empty = todayStageLayout({ width: 390, height: 640, headerBottom: 360, focusCount: 1, focusHeight: 230, secondCurrentHeight: 84 });
  assert.ok(empty.focusTop >= 360 + 24 + 84 + 64);
  assert.ok(empty.focusTop + 230 <= empty.contentHeight - 130);
});
