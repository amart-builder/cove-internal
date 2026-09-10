import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const readComponent = (name) => readFileSync(new URL(`../src/components/tasks/${name}.tsx`, import.meta.url), 'utf8');

test('the full-plan entry closes the grid and uses the planner task count', () => {
  const stage = readComponent('TodayRiverStageV2');
  const footer = stage.slice(stage.indexOf('<footer className="today2-grid-footer">'));
  assert.match(footer, /disabled={model.morningArrivalDisabled}/);
  assert.match(footer, /setGridOpen\(false\);\s*callbacks.onOpenDayPlan\(\)/);
  assert.match(footer, /model.notTodayCount/);
  assert.match(readComponent('TodayView'), /notTodayCount: notTodayTasks.length/);
});

test('full-plan entry starts at the plan while normal and new-day arrivals start at the brief', () => {
  const today = readComponent('TodayView');
  assert.match(today, /onOpenDayPlan: \(\) => void openMorningArrival\('plan'\)/);
  assert.match(today, /step: 'brief' \| 'plan' = 'brief'/);
  assert.match(today, /initialStep={arrivalEntry\?\.planId === dayRitual.plan.id \? arrivalEntry.step : 'brief'}/);
  const arrival = readComponent('MorningArrival');
  assert.match(arrival, /initialStep = 'brief'/);
  assert.match(arrival, /useState<ArrivalStep>\(initialStep\)/);
});
