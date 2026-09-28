import { describe, expect, it } from "vitest";
import {
  formatCompactRelativeTime,
  sessionCountLabel,
} from "../session-list-format";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");

describe("formatCompactRelativeTime", () => {
  it("uses short units without ago", () => {
    expect(formatCompactRelativeTime(NOW - 20_000, NOW)).toBe("now");
    expect(formatCompactRelativeTime(NOW - 3 * 60_000, NOW)).toBe("3m");
    expect(formatCompactRelativeTime(NOW - 2 * 60 * 60_000, NOW)).toBe("2h");
    expect(formatCompactRelativeTime(NOW - 9 * 24 * 60 * 60_000, NOW)).toBe(
      "9d",
    );
  });
});

describe("sessionCountLabel", () => {
  it("names the total the way the list chrome does", () => {
    expect(sessionCountLabel(1)).toBe("1 total session");
    expect(sessionCountLabel(5)).toBe("5 total sessions");
    expect(sessionCountLabel(5, { canLoadMore: true })).toBe(
      "5+ total sessions",
    );
    expect(sessionCountLabel(0, { loading: true })).toBe("Loading sessions…");
  });
});
