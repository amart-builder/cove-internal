import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// With the API failing, Tasks and People put the thrown Error's own message
// straight on the screen. What that says is built in src/lib/supabase/rest.ts:
// "Cove GET task_columns failed: {"error":"..."}" — the HTTP verb, the table
// name and the server's raw body. A dropped connection reads "Failed to fetch".
// Today and Follow-through already handled the same failure in plain
// sentences, so these were the screens that did not. The detail is still worth
// having for whoever is setting Cove up; it goes to a disclosure or the
// console instead of to the person using it.

const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');

const PANELS = [
  ['../src/components/tasks/KanbanBoard.tsx', 'Tasks could not load.', /your task list/],
  ['../src/components/crm/LocalCRMView.tsx', 'People could not load.', /your contacts/],
];

for (const [file, heading, subject] of PANELS) {
  test(`${heading} explains itself in its own words`, () => {
    const source = read(file);
    const at = source.indexOf(heading);
    assert.notEqual(at, -1, `${file} no longer shows "${heading}"`);
    const after = source.slice(at, at + 700);
    assert.match(after, /Cove could not reach/, `${file} no longer explains the failure in its own words`);
    assert.match(after, subject, `${file} no longer names what it could not reach`);
    assert.match(after, /Nothing has been lost\./, `${file} no longer reassures that nothing was lost`);
  });

  test(`${heading} keeps the thrown message, behind a disclosure`, () => {
    const source = read(file);
    const at = source.indexOf(heading);
    const after = source.slice(at, at + 900);
    assert.match(after, /<details[\s\S]*What went wrong[\s\S]*\{error\}[\s\S]*<\/details>/,
      `${file} no longer offers the technical detail to whoever is setting Cove up`);
  });
}

test('a thrown message is not routed anywhere that renders it inline', () => {
  // Each of these components caught an error and put its raw text into state
  // that renders on the page. The two left are the ones whose state is only
  // ever shown inside the disclosure above. A new one here is a new leak: give
  // it a sentence and console.error the original, as the others do.
  const ALLOWED = {
    '../src/components/crm/LocalCRMView.tsx': 1, // feeds the People panel
    '../src/components/tasks/KanbanBoard.tsx': 1, // feeds the Tasks panel
    // The pipeline is behind salesPipelineEnabled() and does not render for
    // this install, so its eight remaining sites are recorded rather than
    // rewritten tonight. Its per-field alert shares a component test with
    // People and is fixed. If this number moves, someone added a ninth.
    '../src/components/crm/PipelineView.tsx': 8,
  };
  for (const [file, allowed] of Object.entries(ALLOWED)) {
    // Any identifier, not just ones called err: this file had them under
    // loadError, submitError, pickError, resolveError and createError.
    const found = [...read(file).matchAll(/(\w+) instanceof Error \? \1\.message : String\(\1\)/g)].length;
    assert.equal(found, allowed,
      `${file} routes the thrown message to state ${found} times, expected ${allowed}`);
  }
});

test('the thrown message really is the internal one, so it is worth hiding', () => {
  assert.match(read('../src/lib/supabase/rest.ts'), /throw new Error\(`Cove \$\{method\} \$\{table\} failed/,
    'the thrown message changed shape; check whether it is now fit to show someone');
});
