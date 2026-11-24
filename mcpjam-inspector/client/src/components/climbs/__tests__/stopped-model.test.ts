import { describe, expect, it } from "vitest";
import { differenceText, gainText, intervalText, intervalVerdict, verificationResult } from "../stopped-model";

const row = (over: object = {}) => ({
  environmentId: "e",
  measure: "pass_rate",
  unit: "points",
  cases: 10,
  difference: 27,
  low: 6,
  high: 45,
  includesZero: false,
  better: "higher",
  ...over,
}) as never;

describe("confirmation words", () => {
  it("says the difference in points, or as a percent for another measure", () => {
    expect(differenceText(row())).toBe("+27 points");
    expect(differenceText(row({ difference: 0 }))).toBe("No change");
    expect(differenceText(row({ unit: "percent", difference: -12.5 }))).toBe("-12.5%");
    expect(differenceText(row({ difference: null }))).toBe("No case to compare");
  });
  it("says the interval, or why there is none", () => {
    expect(intervalText(row())).toBe("Between +6 and +45 points");
    expect(intervalText(row({ low: -11, high: 11 }))).toBe("Between -11 and +11 points");
    expect(intervalText(row({ unit: "percent", low: -30.2, high: -4 }))).toBe("Between -30.2 and -4%");
    expect(intervalText(row({ low: null, high: null, note: "One case: no interval." }))).toBe("One case: no interval.");
  });
  it("holds only when the interval is wholly on one side of zero", () => {
    expect(intervalVerdict(row())).toBe("holds");
    expect(intervalVerdict(row({ includesZero: true, low: -3 }))).toBe("within_noise");
    expect(intervalVerdict(row({ low: null, high: null }))).toBe("none");
  });
});

describe("verification words", () => {
  it("says an environment that already passes everything had no room", () => {
    expect(verificationResult({ environmentId: "e", baselineNowBps: 10000 }, true)).toBe("Already passes every case");
    expect(verificationResult({ environmentId: "e", baselineNowBps: 7000 }, true)).toBe("Holds");
    expect(verificationResult({ environmentId: "e", baselineNowBps: 7000 }, false)).toBe("Does not hold");
  });
  it("says a gain in points or that there is none to show", () => {
    expect(gainText(1700)).toBe("+17 points");
    expect(gainText(undefined)).toBe("None");
  });
});
