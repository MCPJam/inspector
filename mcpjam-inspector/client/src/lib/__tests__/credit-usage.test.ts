import { describe, expect, it } from "vitest";
import {
  formatCreditResetText,
  formatMonthlyResetText,
} from "@/lib/credit-usage";

const DAY = 24 * 60 * 60 * 1000;

describe("formatMonthlyResetText", () => {
  it("counts in days and appends the reset date", () => {
    const text = formatMonthlyResetText(Date.now() + 12 * DAY);
    expect(text).toMatch(/^resets in 12 days \(.+\)$/);
  });

  it("uses the singular day form", () => {
    const text = formatMonthlyResetText(Date.now() + 12 * 60 * 60 * 1000);
    expect(text).toMatch(/^resets in 1 day \(.+\)$/);
  });

  it("handles missing and past reset times", () => {
    expect(formatMonthlyResetText(null)).toBe("resets monthly");
    expect(formatMonthlyResetText(undefined)).toBe("resets monthly");
    expect(formatMonthlyResetText(Date.now() - DAY)).toBe("resets shortly");
  });

  it("does not collapse a multi-week cycle to 'resets tomorrow'", () => {
    // The daily formatter caps at "resets tomorrow" past 24h — the monthly one
    // must not.
    expect(formatCreditResetText(Date.now() + 12 * DAY)).toBe("resets tomorrow");
    expect(formatMonthlyResetText(Date.now() + 12 * DAY)).toMatch(/12 days/);
  });
});
