import test from 'node:test';
import assert from 'node:assert/strict';
import { responsibilityDate, capacityEstimate } from '../src/lib/responsibility/presentation.ts';
test('ambiguous source dates are preserved for confirmation, never silently interpreted as ISO dates',()=>{
 for(const value of ['2026-08-27 07:30 PT','Next Thursday','2026-02-31','']) {
  assert.match(responsibilityDate(value),/date needs confirmation/);
  assert.doesNotMatch(responsibilityDate(value),/Invalid Date/);
 }
 assert.doesNotMatch(responsibilityDate('2026-09-10'),/confirmation/);
 assert.doesNotMatch(responsibilityDate('2026-09-10T12:00:00-07:00'),/confirmation/);
});
test('unknown estimates never imply zero work',()=>{
 assert.match(capacityEstimate(3,0,3),/not set/);
 assert.match(capacityEstimate(3,25,2),/At least 25.*2 still need/);
 assert.match(capacityEstimate(3,90,0),/90 minutes estimated/);
});
