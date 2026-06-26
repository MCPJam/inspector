import { describe, expect, it } from "vitest";
import {
  buildCellMetricStripData,
  MIN_TREND_POINTS,
} from "../metric-strip-data";

describe("buildCellMetricStripData", () => {
  it("maps cell run history into metric strip points with run labels", () => {
    const data = buildCellMetricStripData([
      {
        runLabel: "abc1",
        result: "passed",
        latencyMs: 8000,
        latencyP95Ms: 9000,
        tokens: 1500,
        toolCalls: 2,
      },
      {
        runLabel: "abc2",
        result: "failed",
        latencyMs: 10_000,
        latencyP95Ms: 11_000,
        tokens: 1900,
        toolCalls: 1,
      },
    ]);

    expect(data).not.toBeNull();
    expect(data?.series).toHaveLength(2);
    expect(data?.latest.passRate).toBe(0);
    expect(data?.latest.failed).toBe(1);
    expect(data?.latest.latencyP50).toBe(9000);
    expect(data?.latest.latencyP95).toBe(10_900);
    expect(data?.latest.tokens).toBe(1900);
    expect(data?.latest.toolCalls).toBe(1);
    expect(data?.runLabels).toEqual(["Run abc1", "Run abc2"]);
    expect(data?.showTrend).toBe(true);
  });

  it("returns null for empty input", () => {
    expect(buildCellMetricStripData([])).toBeNull();
  });

  it("hides trend sparklines below minimum points", () => {
    const data = buildCellMetricStripData([
      {
        runLabel: "only",
        result: "passed",
        latencyMs: 1000,
        latencyP95Ms: 1000,
        tokens: 500,
        toolCalls: 1,
      },
    ]);
    expect(data?.showTrend).toBe(false);
    expect(MIN_TREND_POINTS).toBe(2);
  });
});
