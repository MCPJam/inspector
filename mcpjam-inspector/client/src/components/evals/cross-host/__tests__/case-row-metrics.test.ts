import { describe, expect, it } from "vitest";
import type { EvalIteration } from "../../types";
import {
  aggregateCaseRowMetrics,
  caseRowFailureRank,
  cellAvgToolCalls,
  cellsForCaseRow,
  formatCaseRowSummary,
  sortCaseRows,
} from "../case-row-metrics";
import type { CellData, HostColumn } from "../use-cross-host-data";

function makeIteration(
  id: string,
  opts: { toolCalls?: number; tokens?: number } = {},
): EvalIteration {
  return {
    _id: id,
    createdBy: "u1",
    createdAt: 1,
    updatedAt: 2,
    iterationNumber: 1,
    status: "completed",
    result: "passed",
    resultSource: "reported",
    actualToolCalls: Array.from({ length: opts.toolCalls ?? 0 }, (_, i) => ({
      toolName: `tool-${i}`,
      arguments: {},
    })),
    tokensUsed: opts.tokens ?? 1000,
    startedAt: 1,
  } as EvalIteration;
}

function makeCell(overrides: Partial<CellData> = {}): CellData {
  const iterations = overrides.iterations ?? [makeIteration("i1")];
  return {
    iterations,
    passCount: 1,
    failCount: 0,
    pendingCount: 0,
    totalCount: 1,
    passRate: 100,
    p50LatencyMs: 10_000,
    p95LatencyMs: 10_000,
    avgTokensPerIteration: 1900,
    ...overrides,
  };
}

const liveCol: HostColumn = {
  hostId: "h1",
  hostName: "MCPJam",
  isHistorical: false,
};
const histCol: HostColumn = {
  hostId: "h-old",
  hostName: "Old",
  isHistorical: true,
};

describe("cellAvgToolCalls", () => {
  it("returns mean tool calls per iteration", () => {
    expect(
      cellAvgToolCalls(
        makeCell({
          iterations: [
            makeIteration("i1", { toolCalls: 2 }),
            makeIteration("i2", { toolCalls: 4 }),
          ],
        }),
      ),
    ).toBe(3);
  });

  it("returns null when there are no iterations", () => {
    expect(cellAvgToolCalls(makeCell({ iterations: [] }))).toBeNull();
  });
});

describe("aggregateCaseRowMetrics", () => {
  it("reads p50 and tokens from CellData and maxes across cells", () => {
    const metrics = aggregateCaseRowMetrics([
      makeCell({ p50LatencyMs: 8000, avgTokensPerIteration: 1500 }),
      makeCell({ p50LatencyMs: 12_000, avgTokensPerIteration: 2200 }),
    ]);
    expect(metrics).toEqual({
      p50Ms: 12_000,
      tokens: 2200,
      toolCalls: 0,
    });
  });

  it("excludes cells with totalCount 0", () => {
    expect(
      aggregateCaseRowMetrics([
        makeCell({ totalCount: 0, passCount: 0, p50LatencyMs: 99_000 }),
      ]),
    ).toBeNull();
  });
});

describe("cellsForCaseRow", () => {
  it("excludes historical host columns", () => {
    const matrix = new Map([
      [
        "c1",
        new Map([
          ["h1", makeCell({ p50LatencyMs: 5000 })],
          ["h-old", makeCell({ p50LatencyMs: 99_000 })],
        ]),
      ],
    ]);

    const cells = cellsForCaseRow("c1", matrix, [liveCol, histCol]);
    expect(cells).toHaveLength(1);
    expect(cells[0].p50LatencyMs).toBe(5000);
  });
});

describe("caseRowFailureRank", () => {
  it("ranks all-fail before diverge before all-pass", () => {
    const fail = makeCell({ passCount: 0, failCount: 1, totalCount: 1 });
    const pass = makeCell();
    expect(caseRowFailureRank([fail, fail])).toBeLessThan(
      caseRowFailureRank([fail, pass]),
    );
    expect(caseRowFailureRank([fail, pass])).toBeLessThan(
      caseRowFailureRank([pass, pass]),
    );
  });

  it("ranks partial between diverge and all-pass for single host", () => {
    const part = makeCell({ passCount: 1, failCount: 1, totalCount: 2 });
    expect(caseRowFailureRank([part])).toBe(2);
  });

  it("returns no-data rank for empty cells", () => {
    expect(caseRowFailureRank([])).toBe(5);
  });
});

describe("sortCaseRows", () => {
  const rows = [
    { caseId: "c-fast", caseTitle: "Fast case" },
    { caseId: "c-slow", caseTitle: "Slow case" },
    { caseId: "c-empty", caseTitle: "Empty case" },
  ];

  const matrix = new Map<string, Map<string, CellData>>([
    ["c-fast", new Map([["h1", makeCell({ p50LatencyMs: 5000 })]])],
    ["c-slow", new Map([["h1", makeCell({ p50LatencyMs: 20_000 })]])],
    ["c-empty", new Map()],
  ]);

  it("preserves suite order as a stable no-op", () => {
    expect(sortCaseRows(rows, matrix, [liveCol], "suite-order")).toEqual(rows);
  });

  it("sorts by latency descending with empty rows last", () => {
    const sorted = sortCaseRows(rows, matrix, [liveCol], "latency");
    expect(sorted.map((r) => r.caseId)).toEqual([
      "c-slow",
      "c-fast",
      "c-empty",
    ]);
  });

  it("sorts by tokens descending", () => {
    const byTokens = new Map<string, Map<string, CellData>>([
      [
        "c-a",
        new Map([["h1", makeCell({ avgTokensPerIteration: 500 })]]),
      ],
      [
        "c-b",
        new Map([["h1", makeCell({ avgTokensPerIteration: 5000 })]]),
      ],
    ]);
    const tokenRows = [
      { caseId: "c-a", caseTitle: "A" },
      { caseId: "c-b", caseTitle: "B" },
    ];
    expect(
      sortCaseRows(tokenRows, byTokens, [liveCol], "tokens").map(
        (r) => r.caseId,
      ),
    ).toEqual(["c-b", "c-a"]);
  });
});

describe("formatCaseRowSummary", () => {
  it("formats latency, tokens, and rounded tool calls", () => {
    expect(
      formatCaseRowSummary({
        p50Ms: 10_400,
        tokens: 1900,
        toolCalls: 2.3,
      }),
    ).toBe("10s · 1.9k tok · 2 calls");
  });

  it("omits null segments", () => {
    expect(
      formatCaseRowSummary({ p50Ms: 8000, tokens: 1500, toolCalls: null }),
    ).toBe("8.0s · 1.5k tok");
  });

  it("uses singular call for 1", () => {
    expect(
      formatCaseRowSummary({ p50Ms: null, tokens: null, toolCalls: 1 }),
    ).toBe("1 call");
  });
});
