import { describe, expect, it } from "vitest";
import {
  buildCellMetricStripData,
  formatMetricStripCollapsedSummary,
} from "../metric-strip-data";

describe("buildCellMetricStripData", () => {
  it("aggregates headline latency and pass counts across runs", () => {
    const data = buildCellMetricStripData([
      {
        runLabel: "old",
        result: "passed",
        latencyMs: 8_000,
        latencyP95Ms: 8_000,
        tokens: 1_000,
        toolCalls: 1,
      },
      {
        runLabel: "new",
        result: "failed",
        latencyMs: 10_000,
        latencyP95Ms: 12_000,
        tokens: 2_000,
        toolCalls: 2,
      },
    ]);

    expect(data?.latest.passRate).toBe(50);
    expect(data?.latest.passed).toBe(1);
    expect(data?.latest.total).toBe(2);
    expect(data?.latest.tokens).toBe(2_000);
    expect(data?.latest.toolCalls).toBe(2);
    expect(data?.latest.latencyP50).toBe(9_000);
    expect(data?.latest.latencyP95).toBe(11_800);
    expect(data?.series).toHaveLength(2);
    expect(data?.showTrend).toBe(true);
  });

  it("uses the single run's latency when only one run exists", () => {
    const data = buildCellMetricStripData([
      {
        runLabel: "only",
        result: "passed",
        latencyMs: 17_200,
        latencyP95Ms: 17_200,
        tokens: 5_700,
        toolCalls: 2,
      },
    ]);

    expect(data?.latest.latencyP50).toBe(17_200);
    expect(data?.latest.latencyP95).toBe(17_200);
    expect(data?.showTrend).toBe(false);
  });
});

describe("formatMetricStripCollapsedSummary", () => {
  it("includes pass counts, latency, tokens, and tool calls", () => {
    const summary = formatMetricStripCollapsedSummary({
      latest: {
        passRate: 25,
        passed: 2,
        total: 8,
        failed: 6,
        latencyP50: 19_700,
        latencyP95: 27_100,
        tokens: 24_500,
        toolCalls: 14,
      },
      series: [],
      delta: null,
      showTrend: false,
    });

    expect(summary).toBe(
      "6 failing · 25% · 2/8 passed · P50 19.7s · P95 27.1s · 24.5k tokens · 14 tool calls",
    );
  });

  it("shows an all-passing headline when nothing failed", () => {
    const summary = formatMetricStripCollapsedSummary({
      latest: {
        passRate: 100,
        passed: 8,
        total: 8,
        failed: 0,
        latencyP50: 1_200,
        latencyP95: 2_400,
        tokens: 900,
        toolCalls: 3,
      },
      series: [],
      delta: null,
      showTrend: false,
    });

    expect(summary).toBe(
      "All passing · 100% · 8/8 passed · P50 1.20s · P95 2.40s · 900 tokens · 3 tool calls",
    );
  });
});
