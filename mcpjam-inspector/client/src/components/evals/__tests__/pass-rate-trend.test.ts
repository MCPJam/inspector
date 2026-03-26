import { describe, expect, it } from "vitest";
import {
  SUITE_PASS_RATE_TREND_BADGE_THRESHOLD,
  formatSuitePassRateTrendForDisplay,
} from "../helpers";

describe("formatSuitePassRateTrendForDisplay", () => {
  it("returns null for empty trend", () => {
    expect(formatSuitePassRateTrendForDisplay([])).toBeNull();
    expect(formatSuitePassRateTrendForDisplay(null)).toBeNull();
  });

  it("summarizes visible segments and normalizes 0–1 to percent", () => {
    const raw = [0.9, 0.4, 0.85, 1, 0.2]; // 5 points, 3 >= 80% when rounded
    const d = formatSuitePassRateTrendForDisplay(raw)!;
    expect(d.percents).toEqual([90, 40, 85, 100, 20]);
    expect(d.summaryLabel).toContain("≥80%");
    expect(d.showOlderRunsBadge).toBe(false);
  });

  it("shows overflow badge when history exceeds threshold", () => {
    const raw = Array.from(
      { length: SUITE_PASS_RATE_TREND_BADGE_THRESHOLD + 1 },
      (_, i) => (i % 2 === 0 ? 0.8 : 0.6),
    );
    const d = formatSuitePassRateTrendForDisplay(raw)!;
    expect(d.showOlderRunsBadge).toBe(true);
    expect(d.olderHiddenCount).toBeGreaterThan(0);
    expect(d.olderPercentsTooltip).toContain("Earlier");
  });
});
