import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Dark mode had three places where a light-theme colour was left behind, and
// each of them put text under the 4.5:1 that WCAG AA asks for small text. They
// were found by measuring in a browser; this keeps them measured, so the next
// person to reach for a colour here finds out before a user does.

const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8');

function parseColor(value) {
  const text = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const d = hex[1].length === 3 ? [...hex[1]].map((c) => c + c) : hex[1].match(/../g);
    return { r: parseInt(d[0], 16), g: parseInt(d[1], 16), b: parseInt(d[2], 16), a: 1 };
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  throw new Error(`cannot read colour ${value}`);
}

function over(fg, bg) {
  return {
    r: fg.a * fg.r + (1 - fg.a) * bg.r,
    g: fg.a * fg.g + (1 - fg.a) * bg.g,
    b: fg.a * fg.b + (1 - fg.a) * bg.b,
    a: 1,
  };
}

function luminance({ r, g, b }) {
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** The value a rule declares for one property, read out of the stylesheet. */
function declaration(selector, property) {
  const at = css.indexOf(selector);
  assert.notEqual(at, -1, `${selector} is no longer in globals.css`);
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
