import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('settlement completion controls stay accessible and avoid progress races', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'src/components/tasks/DaySettlement.tsx'),
    'utf8',
  );

  assert.match(source, /aria-label=\{`Mark \$\{view\.title\} complete`\}/);
  assert.match(source, />\s*Mark complete\s*<\/button>/);
  assert.match(source, /aria-label=\{`Reopen \$\{item\.title\}`\}/);
  assert.match(source, />\s*Reopen\s*<\/button>/);
  assert.match(
    source,
    /disabled=\{saving \|\| closing \|\| completingIds\.has\(view\.item\.id\)\}/,
  );
  assert.match(
    source,
    /disabled=\{closing \|\| savingItemIds\.has\(item\.itemId\) \|\| completingIds\.has\(item\.itemId\)\}/,
  );
  // Both clicks must go through the pending guard, not straight to the props.
  assert.match(source, /onClick=\{\(\) => void completeItem\(view\.item\.id, view\.title\)\}/);
  assert.match(source, /onClick=\{\(\) => void reopenItem\(item\.itemId, item\.title\)\}/);
  assert.doesNotMatch(source, /onClick=\{\(\) => void onComplete\(/);
  assert.doesNotMatch(source, /onClick=\{\(\) => void onReopen\(/);
  assert.match(
    source,
    /!completingIds\.has\(item\.id\) && shouldAutoPostProgress/,
  );
  assert.match(source, /Mark each open item complete/);
});
