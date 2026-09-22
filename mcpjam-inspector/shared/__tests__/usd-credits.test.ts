import { describe, expect, it } from "vitest";
import {
  creditsToUsdString,
  usdNumberToCredits,
  usdStringToCredits,
} from "../usd-credits";

/**
 * One conversion, two callers: the console has the string an admin typed, the
 * v1 route has a JSON number. A cap saved from the UI and the same cap set
 * through the API must land on the same credit.
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

  it("decides the half-cent on the digit", () => {
    expect(usdStringToCredits("1.005")).toBe(101);
    expect(usdStringToCredits("1.004")).toBe(100);
    expect(usdStringToCredits("10.075")).toBe(1008);
  });

  it("converts ordinary amounts", () => {
    expect(usdStringToCredits("10")).toBe(1000);
    expect(usdStringToCredits("125.5")).toBe(12550);
    expect(usdStringToCredits("0.01")).toBe(1);
    expect(usdStringToCredits(".5")).toBe(50);
  });
});

describe("usdNumberToCredits", () => {
  it("agrees with the string path at every magnitude", () => {
    // THE POINT OF THIS FUNCTION. `Math.round(usd * 100)` fails at 1.005, and
    // nudging by `Number.EPSILON` fails at 10.075 — epsilon is the gap at
    // 1.0, so a fixed correction is already too small one order up. `String`
    // gives the shortest decimal that round-trips, recovering the digits the
    // sender wrote, and the digit rule then applies unchanged.
    for (const usd of [1.005, 10.075, 100.005, 1.0049, 125.5, 12.345, 0]) {
      expect(usdNumberToCredits(usd)).toBe(usdStringToCredits(String(usd)));
    }
    expect(usdNumberToCredits(1.005)).toBe(101);
    expect(usdNumberToCredits(10.075)).toBe(1008);
    expect(usdNumberToCredits(1.0049)).toBe(100);
  });

  it("refuses a negative or non-finite cap", () => {
    expect(usdNumberToCredits(-1)).toBeNull();
    expect(usdNumberToCredits(Number.NaN)).toBeNull();
    expect(usdNumberToCredits(Number.POSITIVE_INFINITY)).toBeNull();
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
