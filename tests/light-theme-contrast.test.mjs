import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseColor, over, contrast } from './helpers/contrast.mjs';

// Light mode had eighty-one of its hundred and thirty-eight visible text
// elements under the 4.5:1 that WCAG AA asks for small text, measured across
// every route in a browser. Almost all of it came from a handful of :root
// tokens and from one secondary ink used at too many different alphas. The
// theme follows the reader's OS setting, so this is not a niche path.

const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');

/** The near-white surfaces the app actually paints text on, measured in Chromium. */
const SURFACES = [
  '#FFFFFF', // a card
  '#FAFAF8', // the page
  '#FAF8F4', // the All Work toolbar
  '#F7F4EF', // the All Work surface
  '#F0F3F7', // the guide's panels
  '#FAF1E6', // the warmest band on Today
];

/** A token's value, read out of the :root block rather than a .dark override. */
function token(name) {
  const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
  const found = new RegExp(`${name}:\\s*([^;]+);`).exec(root);
  assert.ok(found, `${name} is no longer declared in :root`);
  return found[1].trim();
}

function worstRatio(colour) {
  return SURFACES.reduce((lowest, surface) => {
    const bg = parseColor(surface);
    const ratio = contrast(over(parseColor(colour), bg), bg);
    return Math.min(lowest, ratio);
  }, Infinity);
}

// Every token below is used as text somewhere. The accents double as solid
// fills behind white, which only gets better as they darken.
const INK_TOKENS = [
  ['--muted-foreground', 'most of the secondary text in the app'],
  ['--accent-blue', 'links and counts'],
  ['--accent-green', 'the low-priority pill'],
  ['--accent-red', 'the high-priority pill'],
  ['--accent-orange', 'the medium-priority pill'],
  ['--accent-yellow', 'a warning'],
  ['--current-kicker', "a panel's own name"],
];

for (const [name, what] of INK_TOKENS) {
  test(`light mode: ${name} is readable where it is used for ${what}`, () => {
    const ratio = worstRatio(token(name));
    assert.ok(ratio >= 4.5, `${name} is ${token(name)}, which reads at ${ratio.toFixed(2)}:1 on a surface the app paints`);
  });
}

test('light mode: white on a solid accent fill clears AA', () => {
  for (const name of ['--accent-blue', '--accent-green', '--accent-red']) {
    const ratio = contrast(parseColor('#FFFFFF'), parseColor(token(name)));
    assert.ok(ratio >= 4.5, `white on ${name} (${token(name)}) reads at ${ratio.toFixed(2)}:1`);
  }
});

test('light mode: the secondary ink is never set below the alpha it needs', () => {
  // This ink is the app's quiet grey, written inline at a dozen alphas. Under
  // .64 it falls below AA on the surfaces above, so that is the floor. Above
  // it the alphas still range to .82, so the hierarchy survives.
  const alphas = [...css.matchAll(/color: rgba\(23,33,38,(\.\d+)\)/g)].map((m) => Number(`0${m[1]}`));
  assert.ok(alphas.length > 0, 'the secondary ink is no longer written this way; re-measure before deleting this test');
  const tooFaint = alphas.filter((a) => a < 0.64);
  assert.deepEqual(tooFaint, [], `these alphas fall under AA on a light surface: ${tooFaint.join(', ')}`);
});

test('light mode: the lightest of those alphas really does clear AA', () => {
  // Guards the floor itself, so lowering it fails here rather than silently.
  const bg = parseColor('#FAF1E6');
  const ratio = contrast(over(parseColor('rgba(23,33,38,.64)'), bg), bg);
  assert.ok(ratio >= 4.5, `the .64 floor reads at ${ratio.toFixed(2)}:1`);
});
