import { describe, expect, it } from "vitest";
import {
  SHARE_CARD_FONT_FACES,
  buildConformanceShareCardSvg,
  canDrawShareCard,
  formatShareCardScore,
  shareCardAltText,
  shareCardChecksLine,
  shareCardFontFaceCss,
  shareCardSuiteStatus,
  type ConformanceShareCardData,
} from "../conformance-share-card";

function card(
  overrides: Partial<ConformanceShareCardData> = {},
): ConformanceShareCardData {
  return {
    serverName: "amazon-test",
    score: 85.7,
    outcome: "incomplete",
    applicable: 28,
    passed: 24,
    failed: 0,
    couldNotRun: 4,
    notApplicable: 2,
    pending: 0,
    advisoryCount: 0,
    protocolVersion: "2025-11-25",
    suites: [
      {
        kind: "protocol",
        applicable: 16,
        passed: 16,
        failed: 0,
        couldNotRun: 0,
      },
      { kind: "tasks", applicable: 5, passed: 1, failed: 0, couldNotRun: 4 },
      { kind: "oauth", applicable: 0, passed: 0, failed: 0, couldNotRun: 0 },
    ],
    siteLabel: "app.mcpjam.com",
    ...overrides,
  };
}

function svgOf(data: ConformanceShareCardData): string {
  return buildConformanceShareCardSvg(data, { fontFaceCss: "" });
}

/** The text of every <text> element, in document order. */
function texts(svg: string): string[] {
  return [...svg.matchAll(/<text[^>]*>([^<]*)/g)].map((match) => match[1]!);
}

describe("conformance share card", () => {
  it("shows at most one decimal and never a trailing .0", () => {
    expect(formatShareCardScore(85.71)).toBe("85.7");
    expect(formatShareCardScore(84)).toBe("84");
    expect(formatShareCardScore(99.96)).toBe("100");
  });

  it("says a suite with nothing applicable is not scored, never zero", () => {
    expect(
      shareCardSuiteStatus({
        kind: "oauth",
        applicable: 0,
        passed: 0,
        failed: 0,
        couldNotRun: 0,
      }).label,
    ).toBe("NOT SCORED");
  });

  it("does not hold a suite back for checks that only need input", () => {
    // Two unrun checks need input, so they are outside `applicable`.
    const suite = {
      kind: "protocol",
      applicable: 3,
      passed: 3,
      failed: 0,
      couldNotRun: 2,
    };
    expect(shareCardSuiteStatus(suite).label).toBe("PASSED");
    // One of the two could not run for another reason.
    expect(shareCardSuiteStatus({ ...suite, applicable: 4 }).label).toBe(
      "INCOMPLETE",
    );
  });

  it("draws checks that need input apart from checks that could not run", () => {
    const footerFills = (data: ConformanceShareCardData) =>
      [...svgOf(data).matchAll(/<rect [^>]*y="522"[^>]*fill="([^"]+)"/g)].map(
        (match) => match[1]!,
      );
    // Passed, could not run, needs input and n/a: four segments, four colors.
    const split = footerFills(card({ applicable: 26 }));
    expect(split).toHaveLength(4);
    expect(new Set(split).size).toBe(4);
    // When every unrun check only needs input, no bar on the card is amber.
    const amber = footerFills(card())[1]!;
    const inputOnly = svgOf(
      card({
        outcome: "passed",
        applicable: 24,
        suites: [
          {
            kind: "protocol",
            applicable: 24,
            passed: 24,
            failed: 0,
            couldNotRun: 4,
          },
        ],
      }),
    );
    expect(inputOnly).not.toContain(`fill="${amber}"`);
  });

  it("keeps the denominator, the unrun and the not-applicable checks", () => {
    expect(shareCardChecksLine(card())).toBe(
      "24/28 checks passed · 4 could not run · 2 n/a",
    );
  });

  it("tells checks that need input from checks that could not run", () => {
    // Two of the four unrun checks need an input, so they are not applicable:
    // the same split describeConformanceScore makes.
    expect(shareCardChecksLine(card({ applicable: 26 }))).toBe(
      "24/26 checks passed · 2 need input · 2 could not run · 2 n/a",
    );
    expect(
      shareCardChecksLine(card({ applicable: 27, couldNotRun: 4 })),
    ).toContain("1 needs input · 3 could not run");
  });

  it("says how many checks the profile does not score yet", () => {
    expect(shareCardChecksLine(card({ pending: 3 }))).toBe(
      "24/28 checks passed · 4 could not run · 3 not scored yet · 2 n/a",
    );
  });

  it("draws no card when nothing was applicable", () => {
    expect(canDrawShareCard({ score: 100, applicable: 0 })).toBe(false);
    expect(canDrawShareCard({ score: 85.7, applicable: 28 })).toBe(true);
  });

  it("puts the score, the protocol version and every suite on the card", () => {
    const svg = svgOf(card());
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('width="1200" height="630"');
    expect(svg).toContain(">85.7<tspan");
    expect(svg).toContain(">/100</tspan>");
    expect(texts(svg)).toEqual(
      expect.arrayContaining([
        "amazon-test",
        "Incomplete run",
        "Protocol",
        "PASSED",
        "Tasks",
        "INCOMPLETE",
        "1/5",
        "OAuth",
        "NOT SCORED",
        "n/a",
        "24/28 checks passed · 4 could not run · 2 n/a",
        "MCP 2025-11-25 · app.mcpjam.com",
      ]),
    );
  });

  it("leaves the server name off when it is not given", () => {
    expect(svgOf(card({ serverName: null }))).not.toContain("amazon-test");
  });

  it("escapes every string it draws", () => {
    const svg = svgOf(card({ serverName: `<script>alert("x")</script> & co` }));
    expect(svg).not.toContain("<script>");
    expect(svg).toContain(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co",
    );
  });

  it("cuts a long server name short", () => {
    const svg = svgOf(card({ serverName: "x".repeat(80) }));
    expect(texts(svg)).toContain(`${"x".repeat(39)}…`);
  });

  it("keeps a wide server name inside the left column", () => {
    const svg = svgOf(card({ serverName: "W".repeat(40) }));
    expect(svg).toContain(
      '<clipPath id="server-name"><rect x="72" y="128" width="590" height="40" fill="#fff"/></clipPath>' +
        '<g clip-path="url(#server-name)"><text x="72" y="158"',
    );
  });

  it("never cuts an emoji in half", () => {
    const name = `${"x".repeat(38)}🚀🚀🚀`;
    const svg = svgOf(card({ serverName: name }));
    expect(texts(svg)).toContain(`${"x".repeat(38)}🚀…`);
    // A lone surrogate would make the preview's data URL throw.
    expect(() => encodeURIComponent(svg)).not.toThrow();
  });

  it("wraps the checks line before it runs into the footer", () => {
    const busy = card({
      applicable: 120,
      passed: 100,
      failed: 12,
      couldNotRun: 14,
      notApplicable: 9,
      pending: 7,
    });
    const svg = svgOf(busy);
    const lines = [...svg.matchAll(/<text x="72" y="(\d+)"[^>]*>([^<]*)/g)]
      .filter((match) => Number(match[1]) >= 570)
      .map((match) => match[2]!);
    expect(lines.length).toBe(2);
    expect(lines.join(" · ")).toBe(shareCardChecksLine(busy));
    // The first line leaves room for "MCP 2025-11-25 · app.mcpjam.com".
    expect(lines[0]!.length * 9).toBeLessThanOrEqual(1056 - 31 * 9 - 24);
  });

  it("names every face with its own inlined source", () => {
    const css = shareCardFontFaceCss((file) => `data:test,${file}`);
    for (const face of SHARE_CARD_FONT_FACES) {
      expect(css).toContain(
        `font-family:"${face.family}";font-style:normal;font-weight:${face.weight};src:url("data:test,${face.file}")`,
      );
    }
  });

  it("describes itself for screen readers", () => {
    expect(shareCardAltText(card())).toBe(
      "amazon-test scored 85.7/100 on MCP conformance. Incomplete run. 24/28 checks passed · 4 could not run · 2 n/a.",
    );
  });
});
