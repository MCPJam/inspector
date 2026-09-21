/**
 * Brand-colour validation: the hex shape, and the contrast rule.
 *
 * The contrast requirement is the interesting half. A brand colour is
 * composited against BOTH of ChatGPT's backgrounds, so a colour that is legible
 * on white and invisible on the dark surface fails for half the users — which
 * is why the check computes two ratios and takes the worse one rather than
 * picking a background.
 *
 * Pure. Safe from the browser entry.
 */

import { OPENAI_BRAND_COLOR_CONTRAST } from "../profile.js";

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

/**
 * Parse a six-digit hex colour.
 *
 * Six digits only. The three-digit shorthand is valid CSS, and accepting it
 * here would pass a value the portal rejects — a preflight that is more lenient
 * than the thing it previews is worse than no preflight, because it sends a
 * submitter to upload something that will bounce.
 */
export function parseHexColor(value: string): RgbColor | undefined {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return undefined;
  const int = Number.parseInt(match[1], 16);
  return {
    r: (int >> 16) & 0xff,
    g: (int >> 8) & 0xff,
    b: int & 0xff,
  };
}

/** WCAG relative luminance: sRGB channels linearised, then weighted. */
export function relativeLuminance(color: RgbColor): number {
  const channel = (value: number): number => {
    const scaled = value / 255;
    return scaled <= 0.04045
      ? scaled / 12.92
      : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(color.r) +
    0.7152 * channel(color.g) +
    0.0722 * channel(color.b)
  );
}

/** WCAG contrast ratio. Order-independent, between 1 and 21. */
export function contrastRatio(a: RgbColor, b: RgbColor): number {
  const luminanceA = relativeLuminance(a);
  const luminanceB = relativeLuminance(b);
  const lighter = Math.max(luminanceA, luminanceB);
  const darker = Math.min(luminanceA, luminanceB);
  return (lighter + 0.05) / (darker + 0.05);
}

export interface BrandColorCheck {
  /** `false` when the value is not a six-digit hex colour at all. */
  parsed: boolean;
  /** Ratio against the light background, when parsed. */
  lightRatio?: number;
  /** Ratio against the dark background, when parsed. */
  darkRatio?: number;
  /** The worse of the two — the one the requirement is actually about. */
  worstRatio?: number;
  /** Whether the worse ratio clears the minimum. */
  passes: boolean;
}

/**
 * Grade a brand colour against both backgrounds.
 *
 * Reports both ratios rather than only the verdict, because "1.4:1 on dark"
 * tells a designer which direction to move the colour and "fails" does not.
 */
export function checkBrandColor(value: string): BrandColorCheck {
  const color = parseHexColor(value);
  if (!color) return { parsed: false, passes: false };

  const light = parseHexColor(OPENAI_BRAND_COLOR_CONTRAST.lightBackground);
  const dark = parseHexColor(OPENAI_BRAND_COLOR_CONTRAST.darkBackground);
  // The backgrounds are our own constants; a malformed one is a bug here, not
  // a submitter's problem, and silently passing would hide it.
  if (!light || !dark) {
    throw new Error(
      "OPENAI_BRAND_COLOR_CONTRAST declares a background that is not a six-digit hex colour",
    );
  }

  const lightRatio = contrastRatio(color, light);
  const darkRatio = contrastRatio(color, dark);
  const worstRatio = Math.min(lightRatio, darkRatio);

  return {
    parsed: true,
    lightRatio,
    darkRatio,
    worstRatio,
    passes: worstRatio >= OPENAI_BRAND_COLOR_CONTRAST.minRatio,
  };
}
