import { describe, it, expect } from "vitest";
import { computeVisibleHostIconCount } from "../HostCompatStrip";

describe("computeVisibleHostIconCount", () => {
  it("shows every host up to the cap when there is ample width", () => {
    expect(computeVisibleHostIconCount(1000, 5, 8)).toBe(5);
    expect(computeVisibleHostIconCount(1000, 8, 8)).toBe(8);
  });

  it("caps at the max even with unlimited width", () => {
    expect(computeVisibleHostIconCount(1000, 20, 8)).toBe(8);
  });

  it("never reports more visible icons than fit alongside the +N badge", () => {
    // 9 hosts, but only enough room for a handful of icons plus the badge.
    const visible = computeVisibleHostIconCount(120, 9, 8);
    expect(visible).toBeLessThan(8);
    expect(visible).toBeGreaterThanOrEqual(0);
  });

  it("never returns the full cap when a badge is required", () => {
    // Regression guard: undercounting hiddenReports (e.g. always showing 8)
    // is exactly the bug a narrow card exposed — the badge must shrink the
    // visible count whenever not everything fits.
    for (const width of [40, 60, 80, 100, 130, 150]) {
      const visible = computeVisibleHostIconCount(width, 9, 8);
      expect(visible).toBeLessThan(9);
    }
  });

  it("returns 0 when there is no room even for the badge", () => {
    expect(computeVisibleHostIconCount(10, 9, 8)).toBe(0);
  });

  it("returns 0 for an empty report list regardless of width", () => {
    expect(computeVisibleHostIconCount(1000, 0, 8)).toBe(0);
  });

  it("clamps negative/zero width to no visible icons when a badge is needed", () => {
    expect(computeVisibleHostIconCount(0, 9, 8)).toBe(0);
  });
});
