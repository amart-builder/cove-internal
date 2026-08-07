import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('saving a progress note does not block focus from moving to the next-step field', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'src/components/tasks/DaySettlement.tsx'),
    'utf8',
  );

  // A progress-note blur starts an async save before the browser focuses the
  // next-step input. Disabling the fieldset during that save cancels the focus
  // transition and silently loses everything the user intended to type next.
  assert.match(source, /<fieldset className="mt-4" disabled=\{closing\}>/);
  assert.doesNotMatch(source, /<fieldset[^>]+disabled=\{anyDecisionSaving \|\| closing\}/);

  // Choice changes stay locked while an item is saving, while the two text
  // fields remain editable and the existing close-day gate waits for the queue.
  assert.match(
    source,
    /disabled=\{saving \|\| \(decision\.value === 'defer' && !canDefer\)\}/,
  );
  assert.match(source, /disabled=\{closing \|\| !allDecided \|\| savingItemIds\.size > 0\}/);
});
