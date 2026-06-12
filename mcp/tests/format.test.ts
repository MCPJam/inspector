import { describe, expect, it } from "vitest";
import {
  formatDurationMs,
  formatPercent,
  normalizeRate,
} from "../src/ui/shared/format.js";

describe("formatDurationMs", () => {
  it("formats each magnitude", () => {
    expect(formatDurationMs(850)).toBe("850ms");
    expect(formatDurationMs(12_400)).toBe("12.4s");
    expect(formatDurationMs(192_000)).toBe("3m 12s");
    expect(formatDurationMs(3_840_000)).toBe("1h 4m");
  });

  it("never displays a subordinate unit as 60", () => {
    // 59m 59.5s: naive independent rounding would yield "59m 60s".
    expect(formatDurationMs(59 * 60_000 + 59_500)).toBe("1h 0m");
    // 59.5s rounds up across the minute boundary, not to "60.0s".
    expect(formatDurationMs(59_500)).toBe("1m 0s");
    // 2h 59.5m: naive rounding would yield "2h 60m".
    expect(formatDurationMs(2 * 3_600_000 + 59 * 60_000 + 30_000)).toBe(
      "2h 59m"
    );
  });

  it("rejects invalid input", () => {
    expect(formatDurationMs(undefined)).toBeUndefined();
    expect(formatDurationMs(null)).toBeUndefined();
    expect(formatDurationMs(-1)).toBeUndefined();
    expect(formatDurationMs(Number.NaN)).toBeUndefined();
  });
});

describe("normalizeRate / formatPercent", () => {
  it("accepts both fraction and percentage scales", () => {
    expect(normalizeRate(0.25)).toBe(0.25);
    expect(normalizeRate(25)).toBe(0.25);
    expect(normalizeRate(1)).toBe(1);
    expect(normalizeRate(100)).toBe(1);
    expect(formatPercent(0.25)).toBe("25%");
    expect(formatPercent(75)).toBe("75%");
  });

  it("rejects invalid rates", () => {
    expect(normalizeRate(-0.1)).toBeUndefined();
    expect(normalizeRate(null)).toBeUndefined();
    expect(formatPercent(undefined)).toBeUndefined();
  });
});
