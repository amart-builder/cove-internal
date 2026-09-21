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

test('a disabled control also looks disabled', () => {
  // On a closed day Today disables its three focus-card checks. They kept
  // their full blue, their glow and their pointer, so the three largest,
  // most inviting buttons on the screen looked exactly as pressable as they
  // had all day and did nothing when pressed. Today's own day-ritual links,
  // two inches above them, already dim to .38 with not-allowed.
  const selector = '.today2-focus-card:not(.is-completing) .today2-check-orb:disabled';
  const at = css.indexOf(selector);
  assert.notEqual(at, -1, 'the disabled focus-card check no longer has a rule of its own');
  const block = css.slice(at, css.indexOf('}', at));
  assert.match(block, /opacity:\s*\.38/, 'the disabled check is no longer dimmed, so it reads as pressable');
  assert.match(block, /box-shadow:\s*none/, 'the disabled check keeps its glow, which is what made it look live');
  assert.match(block, /cursor:\s*not-allowed/, 'the disabled check no longer says it cannot be pressed');
});

test('the check stays whole while its card is completing', () => {
  // The orb is disabled for the length of the completion animation too. That
  // card is already running its own fade, so dimming the orb underneath it
  // would show through as a flicker at the moment of the one reward on the
  // screen. The :not(.is-completing) in the rule above is what prevents it.
  assert.match(css, /\.today2-focus-card:not\(\.is-completing\)\s+\.today2-check-orb:disabled/,
    'the dim rule now also catches the card that is completing');
  assert.match(css, /\.today2-focus-card\.is-completing\s*\{[^}]*animation:\s*today2-complete-fade/,
    'the completing card no longer runs its own fade, so re-check what the dim rule should exclude');
});

test('the way back from Follow-through is big enough to hit', () => {
  // "Back to Today" stands on its own above the heading rather than inside a
  // sentence, so the 24px WCAG 2.2 asks of a target applies to it. Measured in
  // a browser before the padding: 97x16.
  const source = readFileSync(
    new URL('../src/components/reliability/ResponsibilityOverview.tsx', import.meta.url), 'utf8');
  const at = source.indexOf('Back to Today');
  assert.notEqual(at, -1, 'Follow-through no longer offers a way back to Today');
  const link = source.slice(source.lastIndexOf('<Link', at), at);
  assert.match(link, /\bpy-\d/, 'the Back to Today link has no vertical padding, so it is 16px tall');
  assert.match(link, /\binline-block\b/,
    'padding on an inline link does not grow its box, so the target stays 16px tall');
});

test('a river bead is pressed through something big enough to press', () => {
  // The painted bead is 11x13px on screen, and the river stretches its own
  // coordinates unevenly, so it cannot be drawn bigger without changing how
  // the river looks. An invisible circle around it carries the press instead:
  // measured at 1440x900, the target is 26x30 and the dot is still 11x13.
  const stage = readFileSync(
    new URL('../src/components/tasks/TodayRiverStageV2.tsx', import.meta.url), 'utf8');
  const at = stage.indexOf('today2-bead-target');
  assert.notEqual(at, -1, 'the bead no longer has a target of its own');
  const group = stage.slice(at, stage.indexOf('</g>', at));

  const hit = group.match(/today2-bead-hit[^/]*?r="(\d+)"/);
  const dot = group.match(/today2-bead is-\$\{index \+ 1\}`\}[\s\S]*?r="(\d+)"/);
  assert.ok(hit && dot, 'the bead is no longer drawn as an invisible target around a painted dot');
  assert.ok(Number(hit[1]) >= Number(dot[1]) * 2,
    `the invisible target (r=${hit?.[1]}) is no longer twice the painted dot (r=${dot?.[1]}), so it is back under 24px`);

  // The press has to be on the group. On the painted circle it would be the
  // small one again, whatever is drawn around it.
  assert.match(group.slice(0, group.indexOf('<circle')), /role="button"[\s\S]*onClick=/,
    'the press moved off the group and back onto something the size of the dot');
  assert.doesNotMatch(css, /\.today2-bead\s*\{[^}]*pointer-events:\s*auto/,
    'the painted bead takes presses again, which puts the small target back in front of the big one');
  assert.match(css, /\.today2-bead-hit\s*\{[^}]*pointer-events:\s*all/,
    'the invisible target takes no presses, so nothing is clickable at all');
});

// A second target-size sweep, this time with the modals open. The first sweep
// only ever saw the six screens, so the sheet a person opens to edit any task
// -- and the screen they reach a deleted one through -- were never measured.
// Sizes below are from a browser at 1440x900 before the padding.

test('the task editor can be closed without taking aim', () => {
  // 15x18, the smallest target in Cove, on its most-opened sheet. The two
  // newer task sheets already put this same X in a 36px circle.
  const source = readFileSync(
    new URL('../src/components/tasks/TaskDetail.tsx', import.meta.url), 'utf8');
  const at = source.indexOf('aria-label="Close task"');
  assert.notEqual(at, -1, 'the task editor no longer has a labelled close button');
  const button = source.slice(source.lastIndexOf('<button', at), source.indexOf('</button>', at));
  assert.match(button, /\bsize-9\b/, 'the close button is back to the size of its glyph');
  assert.match(button, /-m[ry]-/,
    'without a negative margin the bigger button moves the X away from the panel edge');
});

test('deleting a task is not a 18px target', () => {
  const source = readFileSync(
    new URL('../src/components/tasks/TaskDetail.tsx', import.meta.url), 'utf8');
  const at = source.indexOf('Delete task');
  assert.notEqual(at, -1, 'the task editor no longer offers a delete');
  const button = source.slice(source.lastIndexOf('<button', at), at);
  assert.match(button, /\bpy-\d/, 'the delete button has no vertical padding, so it is 18px tall');
});

test('Recently deleted can be left and its rows pressed', () => {
  // 63x16 to get back to the board, and 86x18 for the one irreversible
  // action in Cove. Restore beside it was already 72x30.
  const source = readFileSync(
    new URL('../src/components/tasks/RecentlyDeleted.tsx', import.meta.url), 'utf8');
  for (const [label, note] of [
    ['← All Work', 'the way back out of Recently deleted is 16px tall again'],
    ['Delete forever', 'the permanent delete is 18px tall again'],
  ]) {
    const at = source.indexOf(label);
    assert.notEqual(at, -1, `Recently deleted no longer offers "${label}"`);
    const button = source.slice(source.lastIndexOf('<button', at), at);
    assert.match(button, /\bpy-\d/, note);
  }
});
