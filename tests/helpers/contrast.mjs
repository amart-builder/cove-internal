/**
 * The colour maths WCAG contrast is defined in, shared by the theme tests.
 *
 * These read colours out of the stylesheet and composite the layers a rule
 * declares. That is exact for solid and alpha fills, and blind to anything the
 * compositor does on its own: a gradient, a backdrop-filter, or a page showing
 * through. Where those are in play, measure the rendered pixels in a browser
 * and write the result down as a fixed surface here.
 */

export function parseColor(value) {
  const text = String(value).trim();
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

export function over(fg, bg) {
  return {
    r: fg.a * fg.r + (1 - fg.a) * bg.r,
    g: fg.a * fg.g + (1 - fg.a) * bg.g,
    b: fg.a * fg.b + (1 - fg.a) * bg.b,
    a: 1,
  };
}

export function luminance({ r, g, b }) {
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** How far a colour reads on a background it may be drawn with alpha over. */
export function ratioOn(colour, background) {
  const bg = parseColor(background);
  return contrast(over(parseColor(colour), bg), bg);
}
