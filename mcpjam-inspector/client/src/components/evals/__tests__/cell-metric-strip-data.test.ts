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
    // Headline counts are cumulative across the series.
    expect(data?.latest.passed).toBe(1);
    expect(data?.latest.failed).toBe(1);
    expect(data?.latest.total).toBe(2);
    expect(data?.latest.passRate).toBe(50);
    expect(data?.latest.latencyP50).toBe(9000);
    expect(data?.latest.latencyP95).toBe(10_900);
    expect(data?.latest.tokens).toBe(1900);
    expect(data?.latest.toolCalls).toBe(1);
    expect(data?.runLabels).toEqual(["Run abc1", "Run abc2"]);
    expect(data?.showTrend).toBe(true);
  });

  it("accumulates iteration counts across runs when counts are provided", () => {
    const data = buildCellMetricStripData([
      {
        runLabel: "abc1",
        result: "partial",
        passed: 3,
        failed: 2,
        total: 5,
        latencyMs: 8000,
        latencyP95Ms: 9000,
        tokens: 1500,
        toolCalls: 2,
      },
      {
        runLabel: "abc2",
        result: "partial",
        passed: 4,
        failed: 1,
        total: 5,
        latencyMs: 10_000,
        latencyP95Ms: 11_000,
        tokens: 1900,
        toolCalls: 1,
      },
    ]);

    expect(data?.latest.passed).toBe(7);
    expect(data?.latest.failed).toBe(3);
    expect(data?.latest.total).toBe(10);
    expect(data?.latest.passRate).toBe(70);
    // Per-run series points keep their own pass rates for the sparkline.
    expect(data?.series.map((point) => point.passRate)).toEqual([60, 80]);
    expect(data?.series.map((point) => point.total)).toEqual([5, 5]);
    expect(data?.delta).toBe(20);
  });

  it("treats a single multi-iteration run cumulatively", () => {
    const data = buildCellMetricStripData([
      {
        runLabel: "only",
        result: "partial",
        passed: 2,
        failed: 3,
        total: 5,
        latencyMs: 1000,
        latencyP95Ms: 1000,
        tokens: 500,
        toolCalls: 1,
      },
    ]);
    expect(data?.latest.passed).toBe(2);
    expect(data?.latest.total).toBe(5);
    expect(data?.latest.passRate).toBe(40);
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
