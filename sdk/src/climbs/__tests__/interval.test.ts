import { describe, expect, it } from "vitest";
import { confirmationInterval, type ConfirmationCaseRow } from "../interval.js";

const row = (caseKey: string, arm: "baseline" | "best", passed: number, tokens = 0, over: Partial<ConfirmationCaseRow> = {}): ConfirmationCaseRow => ({
  environmentId: "env-a",
  caseKey,
  arm,
  counted: 3,
  passed,
  lost: 0,
  m: {
    tokens: { sum: tokens * passed, n: passed, missing: 0 },
    cost: { sum: 0, n: 0, missing: 3 },
    tool_calls: { sum: 0, n: 0, missing: 3 },
  },
  ...over,
});

/** Ten cases: the best arm passes `gain` more cases fully than the baseline's. */
const cases = (gain: number) =>
  Array.from({ length: 10 }, (_, index) => [row(`c${index}`, "baseline", index < 5 ? 3 : 0), row(`c${index}`, "best", index < 5 + gain ? 3 : 0)]).flat();

describe("confirmationInterval", () => {
  it("is the same every time it is computed from the same measurements", () => {
    const first = confirmationInterval(cases(2), "env-a", "pass_rate");
    expect(confirmationInterval(cases(2), "env-a", "pass_rate")).toEqual(first);
    expect(first).toMatchObject({ unit: "points", better: "higher", cases: 10, difference: 20 });
    expect(first.low!).toBeLessThanOrEqual(20);
    expect(first.high!).toBeGreaterThanOrEqual(20);
  });

  it("changes with the seed and not otherwise", () => {
    const a = confirmationInterval(cases(2), "env-a", "pass_rate", 1);
    const b = confirmationInterval(cases(2), "env-a", "pass_rate", 2);
    expect(a.difference).toBe(b.difference);
    expect([a.low, a.high]).not.toEqual([a.high, a.low]);
  });

  it("says the interval includes zero when two cases of ten moved, and excludes it when every case moved", () => {
    expect(confirmationInterval(cases(1), "env-a", "pass_rate").includesZero).toBe(true);
    const all = Array.from({ length: 8 }, (_, index) => [row(`c${index}`, "baseline", 0), row(`c${index}`, "best", 3)]).flat();
    const interval = confirmationInterval(all, "env-a", "pass_rate");
    expect(interval).toMatchObject({ difference: 100, includesZero: false });
  });

  it("resamples cases, so one lopsided case widens the interval a pooled count would hide", () => {
    const lopsided = [row("a", "baseline", 0), row("a", "best", 3), ...Array.from({ length: 5 }, (_, i) => [row(`b${i}`, "baseline", 3), row(`b${i}`, "best", 3)]).flat()];
    const interval = confirmationInterval(lopsided, "env-a", "pass_rate");
    expect(interval.difference).toBeGreaterThan(0);
    expect(interval.low).toBe(0);
    expect(interval.includesZero).toBe(true);
  });

  it("compares tokens as the change in percent of one total over the other, on cases both arms passed, with pass rate beside it", () => {
    const rows = Array.from({ length: 6 }, (_, index) => [row(`c${index}`, "baseline", 3, 1000), row(`c${index}`, "best", 3, 700)]).flat();
    const interval = confirmationInterval(rows, "env-a", "tokens");
    expect(interval).toMatchObject({ unit: "percent", better: "lower", difference: -30, low: -30, high: -30, includesZero: false });
    expect(interval.passRate).toEqual({ baselineBps: 10000, bestBps: 10000 });
  });

  it("leaves out a case a arm never passed when comparing a measure, and reports no difference when none remain", () => {
    const rows = [row("a", "baseline", 0, 0), row("a", "best", 3, 900), row("b", "baseline", 0, 0), row("b", "best", 3, 900)];
    const interval = confirmationInterval(rows, "env-a", "tokens");
    expect(interval).toMatchObject({ difference: null, low: null, includesZero: true });
    expect(interval.note).toContain("No case could be compared");
  });

  it("gives a difference and no interval for one case, and says why", () => {
    const interval = confirmationInterval([row("a", "baseline", 0), row("a", "best", 3)], "env-a", "pass_rate");
    expect(interval).toMatchObject({ difference: 100, low: null, high: null });
    expect(interval.note).toContain("an interval cannot be found");
  });

  it("only reads the environment it is asked about", () => {
    const rows = [...cases(2), ...cases(0).map((r) => ({ ...r, environmentId: "env-b" }))];
    expect(confirmationInterval(rows, "env-b", "pass_rate").difference).toBe(0);
    expect(confirmationInterval(rows, "env-a", "pass_rate").difference).toBe(20);
  });
});
