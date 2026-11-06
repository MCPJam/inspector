/**
 * The conformance share card: the 1200 × 630 image a shared run travels as.
 *
 * One element tree, drawn twice. The share dialog renders it with React and
 * saves it with html-to-image; the server hands the same tree to satori for
 * the link's og:image. So it uses only what satori lays out: flex boxes,
 * absolute positions, px units, solid fills and gradients, and an explicit
 * `display: flex` on every box with more than one child.
 *
 * The rules ScoreHeadline keeps hold here too: the denominator and protocol
 * version travel with the number, checks that do not apply are said rather
 * than folded in, and a run with nothing applicable has no card.
 */

import { createElement, type CSSProperties, type ReactElement } from "react";
import {
  MCPJAM_WORDMARK_ASPECT,
  MCPJAM_WORDMARK_DARK_DATA_URI,
} from "./conformance-share-card-wordmark";

export const SHARE_CARD_WIDTH = 1200;
export const SHARE_CARD_HEIGHT = 630;

/** The faces the card names. Each renderer loads them under these names. */
export const SHARE_CARD_FONTS = {
  display: "Montserrat",
  sans: "Instrument Sans",
  mono: "JetBrains Mono",
} as const;

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
  advisoryCount: number;
  protocolVersion?: string | null;
  suites: ShareCardSuite[];
  /** Where the run can be opened, without the scheme (e.g. app.mcpjam.com). */
  siteLabel?: string | null;
};

type Tone = "ok" | "bad" | "warn" | "muted";

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
  okText: "#6FC290",
  badText: "#E58466",
  warnText: "#DDB25E",
} as const;

const TONE_TEXT: Record<Tone, string> = {
  ok: COLOR.okText,
  bad: COLOR.badText,
  warn: COLOR.warnText,
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

/** The verdict in ScoreHeadline's words, so the card and the app agree. */
export function shareCardOutcome(
  data: Pick<ConformanceShareCardData, "outcome" | "advisoryCount">,
): { label: string; tone: Tone } {
  if (data.outcome === "failed")
    return { label: "Not conformant", tone: "bad" };
  if (data.outcome === "incomplete") {
    return { label: "Incomplete run", tone: "warn" };
  }
  return data.advisoryCount > 0
    ? { label: "Conformant, with advice", tone: "ok" }
    : { label: "Fully conformant", tone: "ok" };
}

export function shareCardSuiteStatus(suite: ShareCardSuite): {
  label: string;
  tone: Tone;
} {
  if (suite.applicable <= 0) return { label: "NOT SCORED", tone: "muted" };
  if (suite.failed > 0) return { label: "FAILED", tone: "bad" };
  if (suite.couldNotRun > 0) return { label: "INCOMPLETE", tone: "warn" };
  return { label: "PASSED", tone: "ok" };
}

/** "24/28 checks passed · 4 could not run · 2 n/a" */
export function shareCardChecksLine(data: ConformanceShareCardData): string {
  const parts = [`${data.passed}/${data.applicable} checks passed`];
  if (data.failed > 0) parts.push(`${data.failed} failed`);
  if (data.couldNotRun > 0) parts.push(`${data.couldNotRun} could not run`);
  if (data.notApplicable > 0) parts.push(`${data.notApplicable} n/a`);
  return parts.join(" · ");
}

/** A run with no applicable checks has no score to show, so no card. */
export function canDrawShareCard(
  data: Pick<ConformanceShareCardData, "score" | "applicable">,
): boolean {
  return Number.isFinite(data.score) && data.applicable > 0;
}

// --- element helpers -------------------------------------------------------

type Child = ReactElement | string | null;

function box(style: CSSProperties, ...children: Child[]): ReactElement {
  return createElement(
    "div",
    { style: { display: "flex", ...style } },
    ...children.filter((child) => child !== null),
  );
}

function at(
  left: number,
  top: number,
  style: CSSProperties,
  ...children: Child[]
): ReactElement {
  return box({ position: "absolute", left, top, ...style }, ...children);
}

function hLine(top: number): ReactElement {
  return at(0, top, {
    width: SHARE_CARD_WIDTH,
    height: 1,
    background: COLOR.grid,
  });
}

function vLine(left: number): ReactElement {
  return at(left, 0, {
    width: 1,
    height: SHARE_CARD_HEIGHT,
    background: COLOR.grid,
  });
}

/** The "+" Vercel-style marks where two frame lines cross. */
function cross(x: number, y: number): ReactElement {
  return at(
    x - 9,
    y - 9,
    { width: 19, height: 19 },
    at(9, 0, { width: 1, height: 19, background: COLOR.faint }),
    at(0, 9, { width: 19, height: 1, background: COLOR.faint }),
  );
}

function fill(count: number, color: string): ReactElement | null {
  return count > 0
    ? box({ flexGrow: count, flexBasis: 0, height: "100%", background: color })
    : null;
}

function suiteBar(suite: ShareCardSuite, height: number): ReactElement {
  if (suite.applicable <= 0) {
    return box({
      flexGrow: 1,
      height,
      borderRadius: 99,
      background: COLOR.grid,
    });
  }
  return box(
    {
      flexGrow: 1,
      height,
      borderRadius: 99,
      overflow: "hidden",
      background: COLOR.track,
      gap: 2,
    },
    fill(suite.passed, COLOR.ok),
    fill(suite.failed, COLOR.bad),
    fill(suite.couldNotRun, COLOR.warn),
  );
}

function suiteRow(
  suite: ShareCardSuite,
  height: number,
  last: boolean,
): ReactElement {
  const status = shareCardSuiteStatus(suite);
  return box(
    {
      flexDirection: "column",
      justifyContent: "center",
      height,
      borderBottom: last ? "none" : `1px solid ${COLOR.grid}`,
    },
    box(
      { justifyContent: "space-between", alignItems: "center" },
      box(
        {
          fontFamily: SHARE_CARD_FONTS.sans,
          fontSize: 22,
          fontWeight: 600,
          color: COLOR.fg,
        },
        shareCardSuiteLabel(suite.kind),
      ),
      box(
        {
          fontFamily: SHARE_CARD_FONTS.mono,
          fontSize: 13,
          letterSpacing: 1.6,
          color: TONE_TEXT[status.tone],
        },
        status.label,
      ),
    ),
    box(
      { alignItems: "center", marginTop: 12, gap: 14 },
      suiteBar(suite, 6),
      box(
        {
          width: 56,
          justifyContent: "flex-end",
          fontFamily: SHARE_CARD_FONTS.mono,
          fontSize: 15,
          color: COLOR.muted,
        },
        suite.applicable > 0 ? `${suite.passed}/${suite.applicable}` : "n/a",
      ),
    ),
  );
}

/**
 * The card as an element tree at 1200 × 630. Callers check
 * `canDrawShareCard` first.
 */
export function buildConformanceShareCard(
  data: ConformanceShareCardData,
): ReactElement {
  const outcome = shareCardOutcome(data);
  const suites = data.suites.slice(0, 6);
  const rowHeight =
    suites.length > 0 ? Math.min(86, Math.floor(344 / suites.length)) : 0;
  const footerRight = [
    data.protocolVersion ? `MCP ${data.protocolVersion}` : null,
    data.siteLabel ?? null,
  ]
    .filter(Boolean)
    .join(" · ");
  const wordmarkHeight = 23;

  return box(
    {
      position: "relative",
      width: SHARE_CARD_WIDTH,
      height: SHARE_CARD_HEIGHT,
      overflow: "hidden",
      background: COLOR.bg,
      color: COLOR.fg,
      fontFamily: SHARE_CARD_FONTS.sans,
    },
    // The warm glow under the number: the score site's atmosphere.
    // It fades out well inside its box, so no edge shows.
    at(-380, 240, {
      width: 1200,
      height: 760,
      backgroundImage:
        "radial-gradient(ellipse, rgba(232, 96, 56, 0.32) 0%, rgba(232, 96, 56, 0) 55%)",
    }),
    hLine(100),
    hLine(480),
    vLine(40),
    vLine(680),
    vLine(1160),
    cross(40, 100),
    cross(680, 100),
    cross(1160, 100),
    cross(40, 480),
    cross(680, 480),
    cross(1160, 480),
    at(
      72,
      39,
      {},
      createElement("img", {
        src: MCPJAM_WORDMARK_DARK_DATA_URI,
        alt: "MCPJam",
        width: Math.round(wordmarkHeight * MCPJAM_WORDMARK_ASPECT),
        height: wordmarkHeight,
        style: {
          width: Math.round(wordmarkHeight * MCPJAM_WORDMARK_ASPECT),
          height: wordmarkHeight,
        },
      }),
    ),
    at(
      844,
      42,
      {
        width: 284,
        justifyContent: "flex-end",
        fontFamily: SHARE_CARD_FONTS.mono,
        fontSize: 13,
        letterSpacing: 1.8,
        color: COLOR.muted,
      },
      "MCP CONFORMANCE REPORT",
    ),
    data.serverName
      ? at(
          72,
          132,
          {
            width: 590,
            fontSize: 25,
            fontWeight: 600,
            color: COLOR.fg,
            overflow: "hidden",
            whiteSpace: "nowrap",
            textOverflow: "ellipsis",
          },
          data.serverName,
        )
      : null,
    at(
      60,
      190,
      { alignItems: "flex-end" },
      box(
        {
          fontFamily: SHARE_CARD_FONTS.display,
          fontWeight: 800,
          fontSize: 206,
          lineHeight: 1,
          letterSpacing: -11,
          color: COLOR.fg,
        },
        formatShareCardScore(data.score),
      ),
      box(
        {
          fontFamily: SHARE_CARD_FONTS.display,
          fontWeight: 600,
          fontSize: 41,
          color: COLOR.muted,
          marginLeft: 12,
          paddingBottom: 34,
        },
        "/100",
      ),
    ),
    at(
      72,
      416,
      {
        alignItems: "center",
        gap: 12,
        fontSize: 25,
        fontWeight: 600,
        color: TONE_TEXT[outcome.tone],
      },
      box({
        width: 11,
        height: 11,
        borderRadius: 99,
        background: TONE_TEXT[outcome.tone],
      }),
      outcome.label,
    ),
    at(
      720,
      118,
      { flexDirection: "column", width: 400 },
      ...suites.map((suite, index) =>
        suiteRow(suite, rowHeight, index === suites.length - 1),
      ),
    ),
    at(
      72,
      522,
      { width: 1056, height: 10, gap: 3 },
      ...[
        [data.passed, COLOR.ok],
        [data.failed, COLOR.bad],
        [data.couldNotRun, COLOR.warn],
        [data.notApplicable, COLOR.track],
      ]
        .filter(([count]) => (count as number) > 0)
        .map(([count, color]) =>
          box({
            flexGrow: count as number,
            flexBasis: 0,
            height: 10,
            borderRadius: 99,
            background: color as string,
          }),
        ),
    ),
    at(
      72,
      556,
      {
        width: 1056,
        justifyContent: "space-between",
        fontFamily: SHARE_CARD_FONTS.mono,
        fontSize: 15,
        color: COLOR.muted,
      },
      box({}, shareCardChecksLine(data)),
      box({}, footerRight),
    ),
  );
}
