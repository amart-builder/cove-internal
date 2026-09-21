import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Measured in a browser across the six main screens: fifty-three <button>
// elements, of which forty-five showed the browser's default cursor because
// nothing had set one. Links were never affected — a browser points at those
// on its own — so to a mouse, half of what you could press looked like text.

const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8')
  // Comments here talk about the very selectors these tests look for.
  .replace(/\/\*[\s\S]*?\*\//g, '');

test('a button shows a pointer', () => {
  assert.match(css, /button:not\(:disabled\)\s*\{[^}]*cursor:\s*pointer/,
    'nothing gives a plain button a pointer cursor any more');
});

test('the pointer rule leaves drag handles alone', () => {
  // The Focus Grid's cards carry role="button" from the drag library and have
  // to keep `grab`. A rule written against the role rather than the element
  // outranks the card's own and takes that away, which is why it is not.
  const rule = /\[role=['"]button['"]\][^{}]*\{[^}]*cursor:\s*pointer/;
  assert.doesNotMatch(css, rule, 'a pointer rule now matches [role="button"], which overrides cursor: grab');
  assert.match(css, /\.today2-grid-card\s*\{[^}]*cursor:\s*grab/, 'the Focus Grid card no longer declares grab');
});

test('a disabled control keeps the cursor its own rule gives it', () => {
  // These say not-allowed and wait. The pointer rule excludes :disabled so
  // they survive; without that exclusion they would all become pointers.
  for (const selector of [
    '.today2-quiet-actions button:disabled',
    '.today2-session-footer-actions > button:disabled',
    '.email-review-row-actions button:disabled',
  ]) {
    const at = css.indexOf(selector);
    assert.notEqual(at, -1, `${selector} is no longer in globals.css`);
    const block = css.slice(at, css.indexOf('}', at));
    assert.match(block, /cursor:\s*(not-allowed|wait|default)/, `${selector} no longer sets its own cursor`);
  }
});

test('the acknowledge controls are big enough to hit', () => {
  // They were 219x16 with no padding at all, against the 24px WCAG 2.2 asks
  // for. text-xs is 16px of line box, so the padding is what gets them there.
  for (const file of [
    '../src/components/reliability/ResponsibilityOverview.tsx',
    '../src/components/reliability/FollowThrough.tsx',
  ]) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    // disabled:opacity-50 is on the buttons and on nothing else; the same blue
    // is used for text on these screens, which is half of why they needed a
    // cursor in the first place.
    const buttons = [...source.matchAll(/className="([^"]*disabled:opacity-50[^"]*)"/g)].map((m) => m[1]);
    assert.ok(buttons.length > 0, `${file} no longer styles its actions this way; re-measure before deleting this`);
    for (const className of buttons) {
      assert.match(className, /\bpy-\d/, `an action in ${file} has no vertical padding: "${className}"`);
    }
  }
});
