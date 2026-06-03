import { describe, expect, it } from "vitest";
import {
  buildBaseMetricComparisons,
  formatHostFallback,
  projectComparisonsForHost,
} from "../metric-comparison";
import type { CellData, HostColumn } from "../use-cross-host-data";

function makeCell(overrides: Partial<CellData> = {}): CellData {
  return {
    iterations: [],
    passCount: 0,
    failCount: 0,
    pendingCount: 0,
    totalCount: 0,
    passRate: null,
    p50LatencyMs: null,
    p95LatencyMs: null,
    avgTokensPerIteration: null,
    ...overrides,
  };
}

function makeColumn(
  hostId: string,
  hostName: string | null = hostId,
  isHistorical = false,
): HostColumn {
  return { hostId, hostName, isHistorical };
}

describe("formatHostFallback", () => {
  it("renders the last 6 chars of an opaque id with leading ellipsis", () => {
    expect(formatHostFallback("claude_abcdef123456")).toBe("…123456");
  });
});

describe("buildBaseMetricComparisons", () => {
  const cols = [makeColumn("h1", "Claude"), makeColumn("h2", "GPT")];

  it("returns all-undefined entries when byHost is missing", () => {
    const base = buildBaseMetricComparisons(cols, undefined);
    expect(base.p50).toBeUndefined();
    expect(base.p95).toBeUndefined();
    expect(base.avgTokens).toBeUndefined();
  });

  it("returns undefined per metric when no host has a sample", () => {
    const byHost = new Map<string, CellData>([
      ["h1", makeCell()],
      ["h2", makeCell()],
    ]);
    const base = buildBaseMetricComparisons(cols, byHost);
    expect(base.p50).toBeUndefined();
    expect(base.p95).toBeUndefined();
    expect(base.avgTokens).toBeUndefined();
  });

  it("sorts entries ascending by metric value", () => {
    const byHost = new Map<string, CellData>([
      ["h1", makeCell({ p50LatencyMs: 800 })],
      ["h2", makeCell({ p50LatencyMs: 200 })],
    ]);
    const base = buildBaseMetricComparisons(cols, byHost);
    expect(base.p50?.map((e) => e.hostId)).toEqual(["h2", "h1"]);
  });

  it("tie-breaks equal values alphabetically by hostName", () => {
    const cols3 = [
      makeColumn("h1", "Zed"),
      makeColumn("h2", "Alfred"),
      makeColumn("h3", "Mike"),
    ];
    const byHost = new Map<string, CellData>([
      ["h1", makeCell({ p95LatencyMs: 500 })],
      ["h2", makeCell({ p95LatencyMs: 500 })],
      ["h3", makeCell({ p95LatencyMs: 500 })],
    ]);
    const base = buildBaseMetricComparisons(cols3, byHost);
    expect(base.p95?.map((e) => e.hostName)).toEqual(["Alfred", "Mike", "Zed"]);
  });

  it("uses host id fallback when hostName is null", () => {
    const cols2 = [makeColumn("claude_abcdef123456", null)];
    const byHost = new Map<string, CellData>([
      ["claude_abcdef123456", makeCell({ p50LatencyMs: 100 })],
    ]);
    const base = buildBaseMetricComparisons(cols2, byHost);
    expect(base.p50?.[0]?.hostName).toBe("…123456");
  });

  it("formats latency in ms/s and tokens in k", () => {
    const byHost = new Map<string, CellData>([
      [
        "h1",
        makeCell({
          p50LatencyMs: 250,
          p95LatencyMs: 3400,
          avgTokensPerIteration: 1500,
        }),
      ],
    ]);
    const base = buildBaseMetricComparisons([makeColumn("h1", "Claude")], byHost);
    expect(base.p50?.[0]?.formattedValue).toBe("250ms");
    expect(base.p95?.[0]?.formattedValue).toBe("3.4s");
    expect(base.avgTokens?.[0]?.formattedValue).toBe("1.5k tok");
  });

  it("skips hosts that have no sample for the metric", () => {
    const byHost = new Map<string, CellData>([
      ["h1", makeCell({ p50LatencyMs: 100 })],
      ["h2", makeCell({ p50LatencyMs: null, avgTokensPerIteration: 1000 })],
    ]);
    const base = buildBaseMetricComparisons(cols, byHost);
    expect(base.p50?.map((e) => e.hostId)).toEqual(["h1"]);
    expect(base.avgTokens?.map((e) => e.hostId)).toEqual(["h2"]);
  });
});

describe("projectComparisonsForHost", () => {
  const cols = [makeColumn("h1", "Claude"), makeColumn("h2", "GPT")];
  const byHost = new Map<string, CellData>([
    ["h1", makeCell({ p50LatencyMs: 200 })],
    ["h2", makeCell({ p50LatencyMs: 800 })],
  ]);

  it("marks only the cell's host as current", () => {
    const base = buildBaseMetricComparisons(cols, byHost);
    const forH1 = projectComparisonsForHost(base, "h1");
    expect(forH1.p50?.find((e) => e.isCurrent)?.hostId).toBe("h1");
    expect(forH1.p50?.filter((e) => e.isCurrent)).toHaveLength(1);

    const forH2 = projectComparisonsForHost(base, "h2");
    expect(forH2.p50?.find((e) => e.isCurrent)?.hostId).toBe("h2");
  });

  it("marks no entries current when currentHostId is not in the row", () => {
    const base = buildBaseMetricComparisons(cols, byHost);
    const forUnknown = projectComparisonsForHost(base, "h-other");
    expect(forUnknown.p50?.every((e) => !e.isCurrent)).toBe(true);
  });

  it("preserves order from the base sort", () => {
    const base = buildBaseMetricComparisons(cols, byHost);
    const projected = projectComparisonsForHost(base, "h2");
    expect(projected.p50?.map((e) => e.hostId)).toEqual(["h1", "h2"]);
  });
});
