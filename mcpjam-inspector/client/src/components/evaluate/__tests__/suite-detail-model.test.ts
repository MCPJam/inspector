import { describe, expect, it } from "vitest";
import type { EvalCase, EvalIteration, EvalSuite, EvalSuiteRun } from "../../evals/types";
import {
  SUITE_RUN_HISTORY_PAGE_SIZE,
  buildSuiteRunHistoryAggregates,
  buildSuiteRunHistoryRows,
  buildSuiteTestCaseRows,
  filterSuiteRunHistoryRows,
  formatSuiteIdentitySubline,
  resolveRunHistoryVerdict,
  runHistoryFilterOptions,
  runPlatformLabel,
  suiteIdentityCounts,
  suiteRunBlockedReason,
  summarizeTestCase,
} from "../suite-detail-model";

function makeSuite(
  overrides: Partial<EvalSuite> = {},
): EvalSuite {
  return {
    _id: "suite-1",
    createdBy: "u1",
    name: "checkout-flow",
    description: "",
    configRevision: "1",
    environment: { servers: ["payments", "catalog"] },
    createdAt: 1,
    updatedAt: 1,
    source: "ui",
    ...overrides,
  };
}

function makeRun(
  overrides: Partial<EvalSuiteRun> & { _id: string },
): EvalSuiteRun {
  return {
    suiteId: "suite-1",
    createdBy: "u1",
    runNumber: 1,
    configRevision: "1",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    result: "passed",
    createdAt: 1_000,
    completedAt: 2_000,
    ...overrides,
  };
}

function makeIteration(
  overrides: Partial<EvalIteration> & { _id: string },
): EvalIteration {
  return {
    createdBy: "u1",
    createdAt: 1_000,
    startedAt: 1_000,
    updatedAt: 2_000,
    iterationNumber: 1,
    status: "completed",
    result: "passed",
    actualToolCalls: [],
    tokensUsed: 0,
    ...overrides,
  };
}

function makeCase(overrides: Partial<EvalCase> & { _id: string }): EvalCase {
  return {
    testSuiteId: "suite-1",
    createdBy: "u1",
    title: "Untitled",
    query: "",
    models: [],
    runs: 1,
    expectedToolCalls: [],
    ...overrides,
  };
}

describe("suiteIdentityCounts", () => {
  it("uses case count, distinct run sources, and effective servers", () => {
    const counts = suiteIdentityCounts(
      makeSuite(),
      [{ _id: "c1" }, { _id: "c2" }, { _id: "c3" }],
      [
        makeRun({ _id: "r1", source: "ui" }),
        makeRun({ _id: "r2", source: "sdk" }),
        makeRun({ _id: "r3", source: "ui" }),
        makeRun({ _id: "r4", source: "github_check" }),
      ],
    );

    expect(counts).toEqual({
      caseCount: 3,
      sourceCount: 3,
      serverCount: 2,
    });
    expect(formatSuiteIdentitySubline(counts)).toBe(
      "3 cases · 3 sources · 2 servers",
    );
  });

  it("treats missing run source as ui and singularizes the subline", () => {
    const counts = suiteIdentityCounts(
      makeSuite({ environment: { servers: ["only"] } }),
      [{ _id: "c1" }],
      [makeRun({ _id: "r1" })],
    );
    expect(counts).toEqual({
      caseCount: 1,
      sourceCount: 1,
      serverCount: 1,
    });
    expect(formatSuiteIdentitySubline(counts)).toBe(
      "1 case · 1 source · 1 server",
    );
  });
});

describe("resolveRunHistoryVerdict", () => {
  it("maps pass-rate threshold to ship/hold", () => {
    expect(
      resolveRunHistoryVerdict(
        makeRun({ _id: "r1", result: "passed" }),
        92,
        90,
      ),
    ).toEqual({ verdict: "ship", label: "Ship" });
    expect(
      resolveRunHistoryVerdict(
        makeRun({ _id: "r1", result: "failed" }),
        70,
        90,
      ),
    ).toEqual({ verdict: "hold", label: "Hold" });
  });

  it("falls back to pass/fail when there is no threshold", () => {
    expect(
      resolveRunHistoryVerdict(
        makeRun({ _id: "r1", result: "passed" }),
        100,
        null,
      ),
    ).toEqual({ verdict: "passed", label: "Passed" });
    expect(
      resolveRunHistoryVerdict(
        makeRun({ _id: "r1", result: "failed" }),
        0,
        null,
      ),
    ).toEqual({ verdict: "failed", label: "Failed" });
  });
});

describe("runPlatformLabel", () => {
  it("uses source and a real CI id when present", () => {
    expect(runPlatformLabel(makeRun({ _id: "r1", source: "ui" }))).toBe("UI");
    expect(
      runPlatformLabel(
        makeRun({
          _id: "r2",
          source: "github_check",
          ciMetadata: { pipelineId: "4188" },
        }),
      ),
    ).toBe("GitHub #4188");
  });
});

describe("buildSuiteRunHistoryRows", () => {
  it("builds newest-first rows with real pass rate, platform, and models", () => {
    const rows = buildSuiteRunHistoryRows(
      [
        makeRun({
          _id: "old",
          createdAt: 1_000,
          completedAt: 2_000,
          source: "ui",
          namedHostId: "host-1",
        }),
        makeRun({
          _id: "new",
          createdAt: 5_000,
          completedAt: 6_000,
          source: "sdk",
          passCriteria: { minimumPassRate: 80 },
          summary: { total: 1, passed: 0, failed: 1, passRate: 0 },
        }),
      ],
      [
        makeIteration({
          _id: "i-old",
          suiteRunId: "old",
          result: "passed",
          tokensUsed: 100,
          actualToolCalls: [{ toolName: "pay", arguments: {} }],
          startedAt: 1_000,
          updatedAt: 2_000,
          testCaseSnapshot: {
            title: "ok",
            query: "",
            provider: "openai",
            model: "gpt-5-nano",
            expectedToolCalls: [],
          },
        }),
        makeIteration({
          _id: "i-new",
          suiteRunId: "new",
          result: "failed",
          resultSource: "reported",
          error: "card declined",
          tokensUsed: 50,
          startedAt: 5_000,
          updatedAt: 6_500,
          testCaseSnapshot: {
            title: "checkout",
            query: "",
            provider: "openai",
            model: "claude-haiku",
            expectedToolCalls: [],
          },
        }),
      ],
      makeSuite({ defaultPassCriteria: { minimumPassRate: 80 } }),
      new Map([["host-1", "Claude"]]),
      false,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0].runId).toBe("new");
    expect(rows[0].verdict).toBe("hold");
    expect(rows[0].passRate).toBe(0);
    expect(rows[0].platform).toBe("SDK");
    expect(rows[0].models).toEqual(["claude-haiku"]);
    expect(rows[0].tokens).toBe(50);
    expect(rows[1].verdict).toBe("ship");
    expect(rows[1].client).toBe("Claude");
    expect(rows[1].toolCalls).toBe(1);
  });
});

describe("buildSuiteRunHistoryAggregates", () => {
  it("computes run count, tokens, latency, and per-run averages from real iterations", () => {
    const aggregates = buildSuiteRunHistoryAggregates(
      [
        makeRun({ _id: "r1", createdAt: 1, completedAt: 2 }),
        makeRun({ _id: "r2", createdAt: 3, completedAt: 4 }),
      ],
      [
        makeIteration({
          _id: "i1",
          suiteRunId: "r1",
          tokensUsed: 100,
          actualToolCalls: [{ toolName: "a", arguments: {} }],
          startedAt: 0,
          updatedAt: 1_000,
        }),
        makeIteration({
          _id: "i2",
          suiteRunId: "r2",
          tokensUsed: 300,
          actualToolCalls: [
            { toolName: "a", arguments: {} },
            { toolName: "b", arguments: {} },
          ],
          startedAt: 0,
          updatedAt: 3_000,
        }),
      ],
    );

    expect(aggregates.runCount).toBe(2);
    expect(aggregates.totalTokens).toBe(400);
    expect(aggregates.tokensPerRun).toBe(200);
    expect(aggregates.toolCallsPerRun).toBe(1.5);
    expect(aggregates.latencyP50).toBeGreaterThan(0);
    expect(aggregates.latencyP95).toBeGreaterThanOrEqual(
      aggregates.latencyP50 ?? 0,
    );
  });
});

describe("run history filters", () => {
  it("exposes only clients and models that exist on rows", () => {
    const options = runHistoryFilterOptions([
      {
        runId: "r1",
        date: 1,
        dateLabel: "Jan 1",
        verdict: "ship",
        verdictLabel: "Ship",
        passRate: 100,
        platform: "UI",
        source: "ui",
        client: "Claude",
        models: ["gpt-5"],
        latencyMs: 10,
        tokens: 1,
        toolCalls: 1,
      },
      {
        runId: "r2",
        date: 2,
        dateLabel: "Jan 2",
        verdict: "hold",
        verdictLabel: "Hold",
        passRate: 50,
        platform: "SDK",
        source: "sdk",
        client: null,
        models: [],
        latencyMs: null,
        tokens: null,
        toolCalls: null,
      },
    ]);
    expect(options.clients).toEqual(["Claude"]);
    expect(options.models).toEqual(["gpt-5"]);
    expect(options.verdicts).toEqual(["ship", "hold"]);
  });

  it("filters by verdict, client, and model", () => {
    const rows = [
      {
        runId: "r1",
        date: 1,
        dateLabel: "Jan 1",
        verdict: "ship" as const,
        verdictLabel: "Ship",
        passRate: 100,
        platform: "UI",
        source: "ui" as const,
        client: "Claude",
        models: ["gpt-5"],
        latencyMs: 10,
        tokens: 1,
        toolCalls: 1,
      },
      {
        runId: "r2",
        date: 2,
        dateLabel: "Jan 2",
        verdict: "hold" as const,
        verdictLabel: "Hold",
        passRate: 50,
        platform: "SDK",
        source: "sdk" as const,
        client: "Codex",
        models: ["haiku"],
        latencyMs: null,
        tokens: null,
        toolCalls: null,
      },
    ];
    expect(
      filterSuiteRunHistoryRows(rows, {
        verdict: "ship",
        client: "all",
        model: "all",
      }).map((row) => row.runId),
    ).toEqual(["r1"]);
    expect(
      filterSuiteRunHistoryRows(rows, {
        verdict: "all",
        client: "Codex",
        model: "all",
      }).map((row) => row.runId),
    ).toEqual(["r2"]);
    expect(
      filterSuiteRunHistoryRows(rows, {
        verdict: "all",
        client: "all",
        model: "gpt-5",
      }).map((row) => row.runId),
    ).toEqual(["r1"]);
  });
});

describe("summarizeTestCase", () => {
  it("summarizes assertions and expected tools", () => {
    expect(
      summarizeTestCase(
        makeCase({
          _id: "c1",
          title: "Pay",
          expectedToolCalls: [{ toolName: "checkout", arguments: {} }],
          steps: [
            { id: "s1", kind: "prompt", prompt: "Pay" },
            {
              id: "s2",
              kind: "assert",
              assertion: { type: "responseContains", needle: "paid" },
            },
          ],
        }),
      ),
    ).toBe("1 assertion · checkout");
  });

  it("falls back to query when there is no assertion or tool data", () => {
    expect(
      summarizeTestCase(
        makeCase({
          _id: "c1",
          query: "Complete checkout for the saved cart",
        }),
      ),
    ).toBe("Complete checkout for the saved cart");
  });
});

describe("buildSuiteTestCaseRows", () => {
  it("uses the case title and summary", () => {
    expect(
      buildSuiteTestCaseRows([
        makeCase({
          _id: "c1",
          title: "  pay invoice  ",
          expectedToolCalls: [{ toolName: "pay", arguments: {} }],
        }),
      ]),
    ).toEqual([
      {
        caseId: "c1",
        title: "pay invoice",
        summary: "pay",
      },
    ]);
  });
});

describe("suiteRunBlockedReason", () => {
  it("returns the first real blocker", () => {
    expect(
      suiteRunBlockedReason({
        caseCount: 1,
        hasServersConfigured: true,
        isEnvironmentSuite: false,
        isRerunning: false,
        isReplaying: false,
        runningTestCase: false,
        evalRunsDisabledReason: "quota",
      }),
    ).toBe("quota");
    expect(
      suiteRunBlockedReason({
        caseCount: 0,
        hasServersConfigured: true,
        isEnvironmentSuite: false,
        isRerunning: false,
        isReplaying: false,
        runningTestCase: false,
      }),
    ).toBe("Add a test case first.");
  });

  it("does not require local servers for environment suites", () => {
    expect(
      suiteRunBlockedReason({
        caseCount: 1,
        hasServersConfigured: false,
        isEnvironmentSuite: true,
        isRerunning: false,
        isReplaying: false,
        runningTestCase: false,
      }),
    ).toBeNull();
  });
});

describe("SUITE_RUN_HISTORY_PAGE_SIZE", () => {
  it("caps the default table", () => {
    expect(SUITE_RUN_HISTORY_PAGE_SIZE).toBe(8);
  });
});

describe("resolveRunHistoryVerdict — a run held for its judge", () => {
  it("never reads Ship or Hold off a pre-judge pass rate", () => {
    // Above threshold AND below threshold both land on the same answer: the
    // verdict does not exist yet, whatever the rows say so far.
    expect(
      resolveRunHistoryVerdict(
        makeRun({ _id: "r1", status: "grading", result: "pending" }),
        95,
        90,
      ),
    ).toEqual({ verdict: "running", label: "Grading" });
    expect(
      resolveRunHistoryVerdict(
        makeRun({ _id: "r1", status: "grading", result: "pending" }),
        40,
        90,
      ),
    ).toEqual({ verdict: "running", label: "Grading" });
  });
});
