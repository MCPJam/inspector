import { describe, expect, it } from "vitest";
import { buildCellMetricStripData } from "../metric-strip-data";

describe("buildCellMetricStripData", () => {
  it("aggregates headline latency across runs while keeping latest pass rate", () => {
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

    expect(data?.latest.passRate).toBe(0);
    expect(data?.latest.passed).toBe(0);
    expect(data?.latest.total).toBe(1);
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
