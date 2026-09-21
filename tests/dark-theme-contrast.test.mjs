import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseColor, over, contrast } from './helpers/contrast.mjs';

// Dark mode had three places where a light-theme colour was left behind, and
// each of them put text under the 4.5:1 that WCAG AA asks for small text. They
// were found by measuring in a browser; this keeps them measured, so the next
// person to reach for a colour here finds out before a user does.

const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');

/** The value a rule declares for one property, read out of the stylesheet. */
function declaration(selector, property, { nth = 0 } = {}) {
  let at = -1;
  for (let i = 0; i <= nth; i += 1) {
    at = css.indexOf(selector, at + 1);
    assert.notEqual(at, -1, `${selector} is no longer in globals.css`);
  }
  const block = css.slice(at + selector.length, css.indexOf('}', at));
  const found = new RegExp(`(?:^|[;{\\s])${property}\\s*:\\s*([^;}]+)`).exec(block);
  assert.ok(found, `${selector} no longer sets ${property}`);
  return found[1].trim();
}

/**
 * What each colour actually sits on, bottom first. These are the backgrounds
 * the surrounding rules paint, so a stack changing is a reason to re-measure.
 */
const PAGE = parseColor('#1A1917');
const SECOND_CURRENT_CARD = over(parseColor('rgba(42,60,68,.86)'), PAGE);
const RHYTHM_ENTRY = over(parseColor('rgba(28,41,47,.72)'), PAGE);
const RICH_SHEET = over(parseColor('rgba(28,41,47,.86)'), PAGE);

const CASES = [
  {
    what: 'the Second Current keeps its own name readable',
    selector: '.dark .today2-second-current-card > span:first-child',
    background: SECOND_CURRENT_CARD,
  },
  {
    what: 'a Second Current item keeps its eyebrow readable',
    selector: '.dark .today2-second-current-item span',
    background: SECOND_CURRENT_CARD,
  },
  {
    what: 'the Rhythms pill does not fade into its own fill',
    selector: '.dark .today2-rhythm-entry > div > button',
    background: over(parseColor('rgba(255,255,255,.06)'), RHYTHM_ENTRY),
  },
  {
    what: 'a task sheet says who and when in a readable grey',
    selector: '.dark .today2-rich-meta',
    background: RICH_SHEET,
  },
];

for (const { what, selector, background } of CASES) {
  test(`dark mode: ${what}`, () => {
    const ink = over(parseColor(declaration(selector, 'color')), background);
    const ratio = contrast(ink, background);
    assert.ok(ratio >= 4.5, `${selector} reads at ${ratio.toFixed(2)}:1, under the 4.5:1 small text needs`);
  });
}

test('dark mode: white on a solid accent-blue button clears AA', () => {
  const fill = parseColor(declaration('.dark .bg-accent-blue', 'background-color'));
  const ratio = contrast(parseColor('#FFFFFF'), fill);
  assert.ok(ratio >= 4.5, `white on ${declaration('.dark .bg-accent-blue', 'background-color')} reads at ${ratio.toFixed(2)}:1`);
});

test('dark mode: white on the planning button clears AA', () => {
  const fill = parseColor(declaration('.dark .today2-session-footer-actions > button.is-planning', 'background'));
  const ratio = contrast(parseColor('#FFFFFF'), fill);
  assert.ok(ratio >= 4.5, `white on the planning button reads at ${ratio.toFixed(2)}:1`);
});

test('the accent-blue a dark button is filled with is only moved for the solid fill', () => {
  // The tints sit behind dark text and are already fine; moving them would be
  // a change nobody measured. This fails if the override stops being specific.
  assert.match(css, /\.dark \.bg-accent-blue \{ background-color: #[0-9A-Fa-f]{6}; \}/);
  assert.doesNotMatch(css, /\.dark \.bg-accent-blue\\\//);
});

// The Focus Grid is a dark glass panel in both themes, so the page behind it
// is what decides its surface. A light page is the worse of the two, and it is
// the one that put twelve of the panel's eighteen text elements under AA until
// the scrim behind it was deepened. Measuring against the light page therefore
// covers dark mode too.

const LIGHT_PAGE = parseColor('#FAFAF8');

function gridScrim() {
  const declared = declaration('.today2-root [data-day-ritual-layer]', 'background');
  return over(parseColor(declared), LIGHT_PAGE);
}

/** The panel's gradient is a pair of stops; the lower one is the more see-through. */
function gridPanel() {
  const gradient = declaration('.today2-grid-panel', 'background');
  const stops = gradient.match(/rgba\([^)]+\)/g);
  assert.ok(stops && stops.length >= 2, `the panel no longer paints a two-stop gradient: ${gradient}`);
  const weakest = stops
    .map(parseColor)
    .reduce((lowest, stop) => (stop.a < lowest.a ? stop : lowest));
  return over(weakest, gridScrim());
}

const GRID_CASES = [
  {
    what: 'the header says how much of the day is left',
    selector: '.today2-grid-heading span',
    fill: null,
  },
  {
    what: 'the one line that explains how to use the grid',
    selector: '.today2-grid-tools > p',
    fill: null,
  },
  {
    what: 'the focus counts you are not on stay readable',
    selector: '.today2-focus-dial button',
    fill: 'rgba(255,255,255,.08)',
  },
  {
    what: 'the focus count you are on stays readable',
    selector: '.today2-focus-dial button.is-active',
    fill: 'rgba(255,255,255,.08)',
  },
  {
    what: 'a card says which focus it is',
    selector: '.today2-grid-kicker',
    nth: 1,
    // A focused card is filled lighter than the rest, so it is the worst case.
    fill: 'rgba(255,255,255,.14)',
  },
  {
    what: 'a card says the work is yours',
    selector: ".today2-grid-card .today2-owner-chip[data-owner='You']",
    fill: 'rgba(255,255,255,.12)',
    under: 'rgba(255,255,255,.14)',
  },
  {
    what: 'the same chip is readable where the dark rule wins',
    selector: ".dark .today2-owner-chip[data-owner='You']",
    fill: 'rgba(255,255,255,.12)',
    under: 'rgba(255,255,255,.14)',
  },
];

for (const { what, selector, fill, under, nth } of GRID_CASES) {
  test(`the Focus Grid over a light page: ${what}`, () => {
    let background = gridPanel();
    if (under) background = over(parseColor(under), background);
    if (fill) background = over(parseColor(fill), background);
    const ink = over(parseColor(declaration(selector, 'color', { nth })), background);
    const ratio = contrast(ink, background);
    assert.ok(ratio >= 4.5, `${selector} reads at ${ratio.toFixed(2)}:1, under the 4.5:1 small text needs`);
  });
}

test('the scrim behind the Focus Grid stays deep enough to hide a light page', () => {
  const scrim = parseColor(declaration('.today2-root [data-day-ritual-layer]', 'background'));
  assert.ok(scrim.a >= 0.8, `the scrim is at ${scrim.a}; below .8 a light page shows through and the panel's own text falls under AA`);
});
