import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  buildConformanceShareCard,
  canDrawShareCard,
  formatShareCardScore,
  shareCardChecksLine,
  shareCardOutcome,
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

describe("conformance share card", () => {
  it("shows at most one decimal and never a trailing .0", () => {
    expect(formatShareCardScore(85.71)).toBe("85.7");
    expect(formatShareCardScore(84)).toBe("84");
    expect(formatShareCardScore(99.96)).toBe("100");
  });

  it("names the verdict the way ScoreHeadline does", () => {
    expect(
      shareCardOutcome({ outcome: "failed", advisoryCount: 0 }).label,
    ).toBe("Not conformant");
    expect(
      shareCardOutcome({ outcome: "incomplete", advisoryCount: 0 }).label,
    ).toBe("Incomplete run");
    expect(
      shareCardOutcome({ outcome: "passed", advisoryCount: 2 }).label,
    ).toBe("Conformant, with advice");
    expect(
      shareCardOutcome({ outcome: "passed", advisoryCount: 0 }).label,
    ).toBe("Fully conformant");
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

  it("keeps the denominator, the unrun and the not-applicable checks", () => {
    expect(shareCardChecksLine(card())).toBe(
      "24/28 checks passed · 4 could not run · 2 n/a",
    );
  });

  it("draws no card when nothing was applicable", () => {
    expect(canDrawShareCard({ score: 100, applicable: 0 })).toBe(false);
    expect(canDrawShareCard({ score: 85.7, applicable: 28 })).toBe(true);
  });

  it("puts the score, the protocol version and every suite on the card", () => {
    const html = renderToStaticMarkup(buildConformanceShareCard(card()));
    expect(html).toContain("85.7");
    expect(html).toContain("/100");
    expect(html).toContain("amazon-test");
    expect(html).toContain("MCP 2025-11-25 · app.mcpjam.com");
    expect(html).toContain("Incomplete run");
    expect(html).toContain("NOT SCORED");
    expect(html).toContain("1/5");
  });

  it("leaves the server name off when it is not given", () => {
    const html = renderToStaticMarkup(
      buildConformanceShareCard(card({ serverName: null })),
    );
    expect(html).not.toContain("amazon-test");
  });
});
