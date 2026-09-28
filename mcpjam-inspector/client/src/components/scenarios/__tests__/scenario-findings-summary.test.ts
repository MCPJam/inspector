/**
 * `composeScenarioFindingsSummary` — the Findings card's lead lines.
 *
 * The rule worth a test is the one that reads perfectly fine when it is wrong:
 * a fraction whose halves come from different populations. The numerator is
 * tallied from the page the tab scanned (capped), the study total is a separate
 * number, and pairing them produces "12 of 900 sessions ended frustrated" over
 * a 12 counted out of 200. Nothing on screen looks broken.
 */

import { describe, expect, it } from "vitest";
import { deriveScenarioFindingsModel } from "@/components/scenarios/findings/scenario-findings-derivation";
import { composeScenarioFindingsSummary } from "@/components/scenarios/findings/scenario-findings-summary";

function sessions(spec: ReadonlyArray<["frustrated" | "satisfied", string]>) {
  return spec.map(([sentiment, cluster], i) => ({
    _id: `sess-${i}`,
    sentiment,
    themeClusterId: cluster,
    themeClusterLabel: "Export the board",
  }));
}

describe("the lead line's denominator", () => {
  it("is the study total when the whole study was scanned", () => {
    const model = deriveScenarioFindingsModel({
      sessions: sessions([
        ["frustrated", "c1"],
        ["frustrated", "c1"],
        ["frustrated", "c1"],
        ["satisfied", "c1"],
        ["satisfied", "c1"],
      ]),
      sessionCount: 5,
      truncated: false,
    });

    expect(composeScenarioFindingsSummary(model)[0]).toBe(
      "3 of 5 sessions ended frustrated.",
    );
  });

  it("is the SCANNED count when the grid is a subset, not the study total", () => {
    // 900 sessions in the study, 3 of them read. Two of those three were
    // frustrated. "2 of 900" would be a number nobody counted.
    const model = deriveScenarioFindingsModel({
      sessions: sessions([
        ["frustrated", "c1"],
        ["frustrated", "c1"],
        ["satisfied", "c1"],
      ]),
      sessionCount: 900,
      truncated: true,
    });

    const lead = composeScenarioFindingsSummary(model)[0];
    expect(lead).toBe("2 of 3 sessions ended frustrated.");
    expect(lead).not.toContain("900");
  });

  it("still reports the study total on the model, for the card header", () => {
    // The header names the STUDY and the lead names what was read. Moving the
    // denominator must not quietly shrink the study.
    const model = deriveScenarioFindingsModel({
      sessions: sessions([["frustrated", "c1"]]),
      sessionCount: 900,
      truncated: true,
    });

    expect(model.sessionCount).toBe(900);
    expect(model.coverage.scanned).toBe(1);
  });
});
