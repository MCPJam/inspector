/**
 * The conformance share card: the 1200 × 630 image a shared run travels as.
 *
 * One SVG, drawn by whatever shows it. The share dialog shows it as an image
 * and saves it through a canvas ("Download PNG"); the server screenshots it in
 * headless Chromium for the link's og:image. Both draw the same markup, so the
 * download and the link preview cannot drift apart, and neither needs a
 * library: the card is a fixed layout, so every position is written down.
 *
 * An SVG drawn as an image cannot fetch anything, so its fonts travel inside
 * it as `@font-face` rules with each face inlined (`shareCardFontFaceCss`),
 * and the wordmark as a data URL.
 *
 * The rules ScoreHeadline keeps hold here too: the denominator and protocol
 * version travel with the number; checks that do not apply, could not run
 * or are not scored yet are said rather than folded in; and a run with
 * nothing applicable has no card. Checks that only need an input are left off
 * the card: they hold nothing back, so they are not news.
 */

import {
  conformanceVerdict,
  type ConformanceVerdictTone,
} from "./conformance-verdict";
import {
  MCPJAM_WORDMARK_ASPECT,
  MCPJAM_WORDMARK_DARK_DATA_URI,
} from "./conformance-share-card-wordmark";

export const SHARE_CARD_WIDTH = 1200;
export const SHARE_CARD_HEIGHT = 630;

/** The faces the card names. */
export const SHARE_CARD_FONTS = {
  display: "Montserrat",
  sans: "Instrument Sans",
  mono: "JetBrains Mono",
} as const;

/**
 * Every face the card draws with, as a file of the `@fontsource` packages
 * the inspector already depends on. The browser and the server inline the
 * same files.
 */
export const SHARE_CARD_FONT_FACES = [
  {
    family: SHARE_CARD_FONTS.display,
    weight: 600,
    file: "@fontsource/montserrat/files/montserrat-latin-600-normal.woff2",
  },
  {
    family: SHARE_CARD_FONTS.display,
    weight: 800,
    file: "@fontsource/montserrat/files/montserrat-latin-800-normal.woff2",
  },
  {
    family: SHARE_CARD_FONTS.sans,
    weight: 600,
    file: "@fontsource/instrument-sans/files/instrument-sans-latin-600-normal.woff2",
  },
  {
    family: SHARE_CARD_FONTS.mono,
    weight: 400,
    file: "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2",
  },
] as const;

/**
 * The card's `@font-face` rules, with `srcFor` giving each face's URL. Pass
 * data URLs: the card is drawn as an image, which cannot fetch a font.
 */
export function shareCardFontFaceCss(srcFor: (file: string) => string): string {
  return SHARE_CARD_FONT_FACES.map(
    ({ family, weight, file }) =>
      `@font-face{font-family:"${family}";font-style:normal;font-weight:${weight};` +
      `src:url(${JSON.stringify(srcFor(file))}) format("woff2");}`,
  ).join("");
}

export type ShareCardSuite = {
  kind: string;
  applicable: number;
  passed: number;
  failed: number;
  couldNotRun: number;
};

export type ConformanceShareCardData = {
  /** Omitted on the public link preview: a shared run is redacted. */
  serverName?: string | null;
  score: number;
  outcome: string;
  applicable: number;
  passed: number;
  failed: number;
  couldNotRun: number;
  notApplicable: number;
  /** Reported but not scored by the run's conformance profile. */
  pending: number;
  advisoryCount: number;
  protocolVersion?: string | null;
  suites: ShareCardSuite[];
  /** Where the run can be opened, without the scheme (e.g. app.mcpjam.com). */
  siteLabel?: string | null;
};

type Tone = ConformanceVerdictTone | "muted";

const COLOR = {
  bg: "#000000",
  fg: "#f4f1ea",
  muted: "#9a9690",
  faint: "#5e5a55",
  grid: "#1f1d1a",
  track: "#3a3733",
  ok: "#3D8A5A",
  bad: "#C45A3A",
  warn: "#C49A4A",
} as const;

const TONE_TEXT: Record<Tone, string> = {
  ok: "#6FC290",
  bad: "#E58466",
  warn: "#DDB25E",
  muted: COLOR.muted,
};

const SUITE_LABELS: Record<string, string> = {
  protocol: "Protocol",
  apps: "Apps",
  tasks: "Tasks",
  oauth: "OAuth",
};

export function shareCardSuiteLabel(kind: string): string {
  return (
    SUITE_LABELS[kind] ??
    kind.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase())
  );
}

/** 84, 85.7 or 100: at most one decimal, never a trailing ".0". */
export function formatShareCardScore(score: number): string {
  const rounded = Math.round(score * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

type CheckCounts = Pick<
  ShareCardSuite,
  "applicable" | "passed" | "failed" | "couldNotRun"
>;

/**
 * Checks that could not run only for want of an input. They count toward
 * `couldNotRun` but not toward `applicable`: the split
 * `describeConformanceScore` makes.
 */
function needsInputCount(counts: CheckCounts): number {
  return Math.max(
    0,
    counts.passed + counts.failed + counts.couldNotRun - counts.applicable,
  );
}

export function shareCardSuiteStatus(suite: ShareCardSuite): {
  label: string;
  tone: Tone;
} {
  if (suite.applicable <= 0) return { label: "NOT SCORED", tone: "muted" };
  if (suite.failed > 0) return { label: "FAILED", tone: "bad" };
  // A check that only needs an input doesn't hold a verdict back
  // (`decideConformanceOutcome`), so it doesn't hold a suite back either.
  if (suite.couldNotRun > needsInputCount(suite)) {
    return { label: "INCOMPLETE", tone: "warn" };
  }
  return { label: "PASSED", tone: "ok" };
}

/** The parts of the checks line, each a count the score did not fold in. */
export function shareCardChecksParts(data: ConformanceShareCardData): string[] {
  const otherUnrun = data.couldNotRun - needsInputCount(data);
  const parts = [`${data.passed}/${data.applicable} checks passed`];
  if (data.failed > 0) parts.push(`${data.failed} failed`);
  if (otherUnrun > 0) parts.push(`${otherUnrun} could not run`);
  if (data.pending > 0) parts.push(`${data.pending} not scored yet`);
  if (data.notApplicable > 0) parts.push(`${data.notApplicable} n/a`);
  return parts;
}

/** "24/28 checks passed · 4 could not run · 2 n/a" */
export function shareCardChecksLine(data: ConformanceShareCardData): string {
  return shareCardChecksParts(data).join(" · ");
}

/** A run with no applicable checks has no score to show, so no card. */
export function canDrawShareCard(
  data: Pick<ConformanceShareCardData, "score" | "applicable">,
): boolean {
  return Number.isFinite(data.score) && data.applicable > 0;
}

/** The card in words, for the image's alt text. */
export function shareCardAltText(data: ConformanceShareCardData): string {
  const subject = data.serverName ? `${data.serverName} scored` : "Scored";
  const verdict = conformanceVerdict(data.outcome, data.advisoryCount).label;
  return `${subject} ${formatShareCardScore(data.score)}/100 on MCP conformance. ${verdict}. ${shareCardChecksLine(data)}.`;
}

// --- drawing -----------------------------------------------------------------

/** JetBrains Mono advances 600/1000 em per glyph, so a line's width is exact. */
const MONO_FOOTER_SIZE = 15;
const MONO_FOOTER_ADVANCE = MONO_FOOTER_SIZE * 0.6;
const FOOTER_WIDTH = 1056;
const FOOTER_LINE_HEIGHT = 24;
const SERVER_NAME_MAX = 40;

const FAMILY = {
  display: `'${SHARE_CARD_FONTS.display}', sans-serif`,
  sans: `'${SHARE_CARD_FONTS.sans}', sans-serif`,
  mono: `'${SHARE_CARD_FONTS.mono}', monospace`,
};

/** At most `max` characters, cut by code point so no emoji is split in half. */
function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

function escapeXml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

type TextStyle = {
  family: string;
  size: number;
  weight?: number;
  fill?: string;
  anchor?: "start" | "end";
  spacing?: number;
};

function text(x: number, y: number, value: string, style: TextStyle): string {
  const spacing = style.spacing ? ` letter-spacing="${style.spacing}"` : "";
  return (
    `<text x="${x}" y="${y}" font-family="${style.family}" font-size="${style.size}"` +
    ` font-weight="${style.weight ?? 400}" fill="${style.fill ?? COLOR.fg}"` +
    ` text-anchor="${style.anchor ?? "start"}"${spacing}>${escapeXml(value)}</text>`
  );
}

function rect(
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
  radius = 0,
): string {
  const rx = radius ? ` rx="${radius}"` : "";
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}"${rx} fill="${fill}"/>`;
}

/** Segments side by side across `width`, sized by count, `gap` px apart. */
function segments(
  x: number,
  y: number,
  width: number,
  height: number,
  parts: Array<[number, string]>,
  gap: number,
  rounded: boolean,
): string {
  const live = parts.filter(([count]) => count > 0);
  const total = live.reduce((sum, [count]) => sum + count, 0);
  if (total === 0) return "";
  const room = width - gap * (live.length - 1);
  let at = x;
  return live
    .map(([count, fill]) => {
      const segment = (room * count) / total;
      const out = rect(
        round(at),
        y,
        round(segment),
        height,
        fill,
        rounded ? height / 2 : 0,
      );
      at += segment + gap;
      return out;
    })
    .join("");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * A bar's segments: only the scored checks (passed, failed, could not run),
 * so a run that passes everything it scores fills its bar green. Unlike the
 * app's score bar, checks that need an input or do not apply get no segment.
 */
function scoredSegments(counts: CheckCounts): Array<[number, string]> {
  return [
    [counts.passed, COLOR.ok],
    [counts.failed, COLOR.bad],
    [counts.couldNotRun - needsInputCount(counts), COLOR.warn],
  ];
}

/** The "+" marks where two frame lines cross. */
function cross(x: number, y: number): string {
  return (
    rect(x, y - 9, 1, 19, COLOR.faint) + rect(x - 9, y, 19, 1, COLOR.faint)
  );
}

const SUITE_TOP = 118;
const SUITE_LEFT = 720;
const SUITE_RIGHT = 1120;
const SUITE_BAR_WIDTH = 330;
/** Label line, 12 px gap, then the bar line: the block each row centers. */
const SUITE_CONTENT_HEIGHT = 56;

function suiteRow(
  suite: ShareCardSuite,
  index: number,
  rowHeight: number,
  last: boolean,
): string {
  const top = SUITE_TOP + index * rowHeight;
  const contentTop = top + Math.max(0, (rowHeight - SUITE_CONTENT_HEIGHT) / 2);
  const status = shareCardSuiteStatus(suite);
  const barY = round(contentTop + 44);
  const clipId = `suite-bar-${index}`;
  const bar =
    suite.applicable <= 0
      ? rect(SUITE_LEFT, barY, SUITE_BAR_WIDTH, 6, COLOR.grid, 3)
      : `<clipPath id="${clipId}">${rect(SUITE_LEFT, barY, SUITE_BAR_WIDTH, 6, "#fff", 3)}</clipPath>` +
        `<g clip-path="url(#${clipId})">` +
        rect(SUITE_LEFT, barY, SUITE_BAR_WIDTH, 6, COLOR.track) +
        segments(
          SUITE_LEFT,
          barY,
          SUITE_BAR_WIDTH,
          6,
          scoredSegments(suite),
          2,
          false,
        ) +
        `</g>`;
  return [
    text(
      SUITE_LEFT,
      round(contentTop + 21),
      truncate(shareCardSuiteLabel(suite.kind), 24),
      { family: FAMILY.sans, size: 22, weight: 600 },
    ),
    text(SUITE_RIGHT, round(contentTop + 18), status.label, {
      family: FAMILY.mono,
      size: 13,
      fill: TONE_TEXT[status.tone],
      anchor: "end",
      spacing: 1.6,
    }),
    bar,
    text(
      SUITE_RIGHT,
      round(contentTop + 52),
      suite.applicable > 0 ? `${suite.passed}/${suite.applicable}` : "n/a",
      { family: FAMILY.mono, size: 15, fill: COLOR.muted, anchor: "end" },
    ),
    last ? "" : rect(SUITE_LEFT, top + rowHeight - 1, 400, 1, COLOR.grid),
  ].join("");
}

/**
 * The checks line, wrapped onto further lines when it would run into the
 * footer's right-hand text. Monospace, so widths are counted in glyphs.
 */
function wrapChecks(parts: string[], firstLineRoom: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const part of parts) {
    const room = lines.length === 0 ? firstLineRoom : FOOTER_WIDTH;
    const next = line ? `${line} · ${part}` : part;
    if (line && next.length * MONO_FOOTER_ADVANCE > room) {
      lines.push(line);
      line = part;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The card for one run as an SVG document. Callers check `canDrawShareCard`
 * first. `fontFaceCss` comes from `shareCardFontFaceCss`, with each face
 * inlined.
 */
export function buildConformanceShareCardSvg(
  data: ConformanceShareCardData,
  { fontFaceCss }: { fontFaceCss: string },
): string {
  const verdict = conformanceVerdict(data.outcome, data.advisoryCount);
  const suites = data.suites.slice(0, 6);
  const rowHeight =
    suites.length > 0 ? Math.min(86, Math.floor(344 / suites.length)) : 0;
  const footerRight = [
    data.protocolVersion ? `MCP ${data.protocolVersion}` : null,
    data.siteLabel ?? null,
  ]
    .filter(Boolean)
    .join(" · ");
  const checksLines = wrapChecks(
    shareCardChecksParts(data),
    FOOTER_WIDTH - footerRight.length * MONO_FOOTER_ADVANCE - 24,
  );
  const serverName = data.serverName
    ? truncate(data.serverName, SERVER_NAME_MAX)
    : null;
  const wordmarkHeight = 23;
  const wordmarkWidth = Math.round(wordmarkHeight * MCPJAM_WORDMARK_ASPECT);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SHARE_CARD_WIDTH}" height="${SHARE_CARD_HEIGHT}" viewBox="0 0 ${SHARE_CARD_WIDTH} ${SHARE_CARD_HEIGHT}">`,
    `<defs><style><![CDATA[${fontFaceCss}]]></style>`,
    // The warm glow under the number: the score site's atmosphere.
    `<radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="220" cy="620" r="848"` +
      ` gradientTransform="translate(220 620) scale(1 0.633) translate(-220 -620)">` +
      `<stop offset="0" stop-color="rgb(232,96,56)" stop-opacity="0.32"/>` +
      `<stop offset="0.55" stop-color="rgb(232,96,56)" stop-opacity="0"/>` +
      `</radialGradient></defs>`,
    rect(0, 0, SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT, COLOR.bg),
    rect(0, 0, SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT, "url(#glow)"),
    rect(0, 100, SHARE_CARD_WIDTH, 1, COLOR.grid),
    rect(0, 480, SHARE_CARD_WIDTH, 1, COLOR.grid),
    ...[40, 680, 1160].map((x) => rect(x, 0, 1, SHARE_CARD_HEIGHT, COLOR.grid)),
    ...[40, 680, 1160].flatMap((x) => [cross(x, 100), cross(x, 480)]),
    `<image href="${MCPJAM_WORDMARK_DARK_DATA_URI}" x="72" y="39" width="${wordmarkWidth}" height="${wordmarkHeight}"/>`,
    text(1128, 55, "MCP CONFORMANCE REPORT", {
      family: FAMILY.mono,
      size: 13,
      fill: COLOR.muted,
      anchor: "end",
      spacing: 1.8,
    }),
    // Clipped to the left column: wide glyphs can outrun the character cap,
    // and the name must not cross into the suites.
    serverName
      ? `<clipPath id="server-name">${rect(72, 128, 590, 40, "#fff")}</clipPath>` +
        `<g clip-path="url(#server-name)">` +
        text(72, 158, serverName, {
          family: FAMILY.sans,
          size: 25,
          weight: 600,
        }) +
        `</g>`
      : "",
    `<text x="60" y="367" font-family="${FAMILY.display}" font-size="206" font-weight="800"` +
      ` letter-spacing="-11" fill="${COLOR.fg}">${escapeXml(formatShareCardScore(data.score))}` +
      `<tspan dx="12" dy="-15" font-size="41" font-weight="600" letter-spacing="0"` +
      ` fill="${COLOR.muted}">/100</tspan></text>`,
    `<circle cx="77.5" cy="431" r="5.5" fill="${TONE_TEXT[verdict.tone]}"/>`,
    text(95, 440, verdict.label, {
      family: FAMILY.sans,
      size: 25,
      weight: 600,
      fill: TONE_TEXT[verdict.tone],
    }),
    ...suites.map((suite, index) =>
      suiteRow(suite, index, rowHeight, index === suites.length - 1),
    ),
    segments(72, 522, FOOTER_WIDTH, 10, scoredSegments(data), 3, true),
    ...checksLines.map((line, index) =>
      text(72, 570 + index * FOOTER_LINE_HEIGHT, line, {
        family: FAMILY.mono,
        size: MONO_FOOTER_SIZE,
        fill: COLOR.muted,
      }),
    ),
    footerRight
      ? text(1128, 570, footerRight, {
          family: FAMILY.mono,
          size: MONO_FOOTER_SIZE,
          fill: COLOR.muted,
          anchor: "end",
        })
      : "",
    `</svg>`,
  ].join("");
}
