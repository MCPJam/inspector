/**
 * Shared reader for the design system's canonical token file, plus the color
 * math needed to mirror those tokens into surfaces that cannot consume CSS
 * custom properties directly.
 *
 * WHY THIS EXISTS. `design-system/src/tokens.css` is the single source of
 * truth for the MCPJam palette, but three consumers cannot simply `@import`
 * it: Mintlify's `docs.json` wants literal hex, `@mcpjam/chat-ui` ships HSL
 * channel triplets so shadcn utilities resolve inside a host app, and
 * `DESIGN.md`'s front matter is YAML. Each of those was, at some point,
 * transcribed by hand — and each drifted. So every mirror now derives from
 * this module, and a `--check` mode in each sync script fails CI when a
 * mirror stops matching its source.
 *
 * The rules learned from the docs mirror that came first:
 *
 *   - the `.dark` block in tokens.css only records DELTAS, so a reader that
 *     does not fall back to `:root` silently loses `--radius`, `--spacing`,
 *     `--font-code` and every other light-only token;
 *   - a token that a mirror asks for but tokens.css does not define is a
 *     THROW, never a skipped line, because a mirror missing one color renders
 *     as a broken page rather than a failed build;
 *   - the conversions are exercised on every sync, so they self-check at
 *     import time — a silently wrong matrix would repaint the docs site and
 *     the published transcript in colors nobody chose.
 */

import { readFileSync } from "node:fs";

/**
 * Pull the body of a top-level `selector { … }` rule out of a stylesheet.
 *
 * Deliberately non-greedy up to a newline-anchored closing brace: tokens.css
 * nests no rules inside `:root`/`.dark`, and a greedy match would swallow
 * every block that follows.
 */
export function extractBlock(css, selector) {
  const re = new RegExp(
    String.raw`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\s*\{([\s\S]*?)\n\}`,
    "m",
  );
  const m = css.match(re);
  if (!m) throw new Error(`Could not locate ${selector} block in tokens.css`);
  return m[1];
}

/** Index of the closing quote of the CSS string starting at `i`. */
function endOfCssString(block, i) {
  const quote = block[i];
  for (let j = i + 1; j < block.length; j++) {
    if (block[j] === "\\") {
      j++;
      continue;
    }
    if (block[j] === quote) return j;
  }
  throw new Error("Unterminated string in tokens.css");
}

/**
 * `--name: value;` declarations in a rule body, in source order.
 *
 * A scanner rather than `split(";")`, and quote- and paren-aware rather than a
 * blind comment strip, because each shortcut fails SILENTLY on values this
 * palette could plausibly grow: a font family containing a semicolon truncates
 * at the quote, a `/*` sequence inside a string swallows everything to the next
 * close marker, and an unquoted `url(data:image/svg+xml;base64,...)` — where the
 * semicolon is ordinary content — truncates at the media type. A truncated value does not throw — it just repaints a mirrored
 * surface in a color nobody chose, which is the failure mode this module
 * exists to prevent.
 *
 * Declaration-oriented rather than line-oriented for the same reason: tokens.css
 * wraps its longest values across lines, and a line-based reader silently drops
 * all four font stacks and half the shadow scale. Wrapped values collapse to
 * single-spaced text, which is what every consumer of a font stack wants.
 */
export function parseVars(block) {
  const out = new Map();
  let decl = "";

  const flush = () => {
    const m = decl.match(/^\s*(--[a-z0-9-]+)\s*:\s*([\s\S]+)$/i);
    if (m) out.set(m[1], m[2].replace(/\s+/g, " ").trim());
    decl = "";
  };

  let parens = 0;

  for (let i = 0; i < block.length; i++) {
    const ch = block[i];

    if (ch === '"' || ch === "'") {
      const close = endOfCssString(block, i);
      decl += block.slice(i, close + 1);
      i = close;
      continue;
    }

    if (ch === "/" && block[i + 1] === "*") {
      const end = block.indexOf("*/", i + 2);
      if (end === -1) throw new Error("Unterminated comment in tokens.css");
      i = end + 1;
      continue;
    }

    // Only a top-level `;` ends a declaration; inside url()/calc()/oklch() it
    // is content.
    if (ch === ";" && parens === 0) {
      flush();
      parens = 0;
      continue;
    }

    if (ch === "(") parens++;
    else if (ch === ")" && parens > 0) parens--;

    decl += ch;
  }
  flush();

  return out;
}

/**
 * Both theme modes of tokens.css, with dark completed from light.
 *
 * The `.dark` block records only what dark mode overrides. Callers want a
 * COMPLETE picture of each mode — asking "what is --radius in dark mode?"
 * should answer `0.5rem`, not `undefined` — so light is merged underneath.
 */
export function readTokenModes(tokensPath) {
  const css = readFileSync(tokensPath, "utf8");
  const light = parseVars(extractBlock(css, ":root"));
  const dark = parseVars(extractBlock(css, ".dark"));
  for (const [k, v] of light) if (!dark.has(k)) dark.set(k, v);
  return { light, dark };
}

/**
 * Read one token out of a mode map, or throw naming both.
 *
 * Every mirror goes through here so a renamed or deleted token fails the sync
 * loudly instead of emitting an empty CSS value.
 */
export function requireToken(vars, name, modeLabel) {
  const value = vars.get(name);
  if (!value) {
    throw new Error(`Token ${name} missing from tokens.css (${modeLabel} mode)`);
  }
  return value;
}

/**
 * `oklch(L C H)` / `oklch(L C H / A)` -> sRGB channels in 0..1, gamut-clipped.
 *
 * Straight CSS Color 4: OKLCh -> OKLab -> LMS -> linear sRGB -> transfer
 * function. Clipping (rather than a perceptual gamut map) is what browsers do
 * for the in-gamut colors this palette actually uses; every token here was
 * authored against a browser rendering, so matching that rendering is the
 * goal, not improving on it.
 */
export function oklchToSrgb(value) {
  const m = String(value)
    .trim()
    .match(/^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+%?)\s*)?\)$/i);
  if (!m) throw new Error(`Not an oklch() color: ${value}`);

  const L = m[1].endsWith("%") ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
  const C = parseFloat(m[2]);
  const hDeg = parseFloat(m[3]);
  const alpha = m[4] === undefined
    ? 1
    : m[4].endsWith("%")
      ? parseFloat(m[4]) / 100
      : parseFloat(m[4]);

  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const lc = l_ * l_ * l_;
  const mc = m_ * m_ * m_;
  const sc = s_ * s_ * s_;

  const lin = [
    4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
  ];

  const [r, g, bl] = lin.map((c) => {
    const encoded = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.min(1, Math.max(0, encoded));
  });

  return { r, g, b: bl, alpha };
}

/** sRGB 0..1 -> `#rrggbb` (alpha dropped; no mirror target accepts it). */
export function srgbToHex({ r, g, b }) {
  const hex = (c) =>
    Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * sRGB 0..1 -> shadcn's `H S% L%` channel triplet.
 *
 * shadcn tokens are consumed as `hsl(var(--token))`, so the stored value is
 * the bare channel list with no `hsl()` wrapper — that is a convention of the
 * consumer, not a color space choice.
 */
export function srgbToHslTriplet({ r, g, b }) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;

  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }

  const round = (n) => String(Math.round(n * 10) / 10);
  return `${round(h)} ${round(s * 100)}% ${round(l * 100)}%`;
}

/**
 * WCAG 2.x relative luminance of an sRGB color.
 */
function relativeLuminance({ r, g, b }) {
  const channel = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * WCAG contrast ratio between two token values, as a number from 1 to 21.
 *
 * This exists so DESIGN.md can state what the palette's role pairs ACTUALLY
 * deliver instead of promising they are all legible. The promise was easy to
 * write and wrong: several solid status fills land nearer 3:1 than 4.5:1, and
 * an agent told they are safe will put small body copy on them.
 */
export function contrastRatio(valueA, valueB) {
  const colorA = oklchToSrgb(valueA);
  const colorB = oklchToSrgb(valueB);

  // A translucent color has no contrast ratio of its own — it has one against
  // whatever shows through. Ignoring alpha would report black-at-50%-on-white
  // as 21:1 when the composited truth is nearer 4:1, so refuse rather than
  // publish a confident wrong number into the accessibility table.
  if (colorA.alpha !== 1 || colorB.alpha !== 1) {
    throw new Error(
      `contrastRatio needs opaque colors; got ${valueA} and ${valueB}. ` +
        "Composite the translucent one over a known backdrop first.",
    );
  }

  const a = relativeLuminance(colorA);
  const b = relativeLuminance(colorB);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** Convenience: canonical token value straight to hex. */
export function oklchToHex(value) {
  return srgbToHex(oklchToSrgb(value));
}

/** Convenience: canonical token value straight to an HSL channel triplet. */
export function oklchToHslTriplet(value) {
  return srgbToHslTriplet(oklchToSrgb(value));
}

/*
 * Import-time self-check.
 *
 * A transposed matrix coefficient does not crash — it quietly repaints every
 * mirrored surface. These three anchors (both achromatic extremes plus a
 * saturated primary, which is the only case that exercises the chroma terms
 * and the gamut clip) turn that into an immediate, loud failure on any sync
 * or --check run.
 */
for (const [input, expected] of [
  ["oklch(1 0 0)", "#ffffff"],
  ["oklch(0 0 0)", "#000000"],
  ["oklch(0.62796 0.25768 29.234)", "#ff0000"],
]) {
  const actual = oklchToHex(input);
  if (actual !== expected) {
    throw new Error(
      `tokens-css.mjs color conversion is wrong: ${input} produced ${actual}, expected ${expected}`,
    );
  }
}
