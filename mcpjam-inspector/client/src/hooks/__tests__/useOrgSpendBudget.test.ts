import { describe, expect, it } from "vitest";
import { creditsToUsdString, usdStringToCredits } from "../useOrgSpendBudget";

/**
 * The dollars-in, credits-stored conversion, which is the only arithmetic
 * between what an admin types and what the ledger enforces.
 *
 * Two ways it can quietly do the wrong thing, both covered here: reading a
 * cleared field as a zero cap, and losing a half-cent to binary float.
 */

describe("usdStringToCredits", () => {
  it("refuses a blank field instead of reading it as zero", () => {
    // `Number("")` is 0. Coercing it would set the cap to $0 and lock the
    // organization out of its own credits the moment someone cleared the box.
    expect(usdStringToCredits("")).toBeNull();
    expect(usdStringToCredits("   ")).toBeNull();
  });

  it("refuses what is not a usable amount", () => {
    expect(usdStringToCredits("abc")).toBeNull();
    expect(usdStringToCredits("-3")).toBeNull();
  });

  it("rounds the half-cent on the digit, not on the float", () => {
    // float64 holds 1.00499999999999989 for `1.005`, so `1.005 * 100` is
    // 100.49999999999999 and `Math.round` gives 100 — a cap one cent below
    // what was typed. The typed string is where the intended decimal lives.
    expect(usdStringToCredits("1.005")).toBe(101);
    expect(usdStringToCredits("1.004")).toBe(100);
    expect(usdStringToCredits("1.995")).toBe(200);
  });

  it("converts ordinary amounts", () => {
    expect(usdStringToCredits("10")).toBe(1000);
    expect(usdStringToCredits("10.5")).toBe(1050);
    expect(usdStringToCredits("50.00")).toBe(5000);
    expect(usdStringToCredits("0.01")).toBe(1);
    expect(usdStringToCredits(".5")).toBe(50);
  });

  it("still accepts an exponent form, which has no cent digit to read", () => {
    expect(usdStringToCredits("1e2")).toBe(10000);
  });
});

describe("creditsToUsdString", () => {
  it("round-trips a typed amount", () => {
    for (const typed of ["10", "10.50", "0.01", "1234.56"]) {
      const credits = usdStringToCredits(typed);
      expect(credits).not.toBeNull();
      expect(usdStringToCredits(creditsToUsdString(credits!))).toBe(credits);
    }
  });
});
