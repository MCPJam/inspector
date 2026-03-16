import { describe, it, expect } from "vitest";
import {
  classifyFailure,
  getSuiteHistory,
  isFlaky,
  classifyAllFailures,
  buildTriageContext,
  buildOverviewTriageContext,
} from "../ai-insights";
import type { EvalSuiteRun, CommitGroup } from "../types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRun(
  overrides: Partial<EvalSuiteRun> & { suiteId: string },
): EvalSuiteRun {
  return {
    _id: `run-${Math.random().toString(36).slice(2, 8)}`,
    createdBy: "user",
    runNumber: 1,
    configRevision: "rev1",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    result: "failed",
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeCommitGroup(
  overrides: Partial<CommitGroup> & { runs: EvalSuiteRun[] },
): CommitGroup {
  return {
    commitSha: `sha-${Math.random().toString(36).slice(2, 8)}`,
    shortSha: "abc1234",
    branch: "main",
    timestamp: Date.now(),
    status: "failed",
    suiteMap: new Map(),
    summary: { total: 0, passed: 0, failed: 0, running: 0 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getSuiteHistory
// ---------------------------------------------------------------------------

describe("getSuiteHistory", () => {
  it("returns results for a suite across commit groups (newest first)", () => {
    const suiteId = "suite-1";
    const groups: CommitGroup[] = [
      makeCommitGroup({
        runs: [makeRun({ suiteId, result: "failed" })],
      }),
      makeCommitGroup({
        runs: [makeRun({ suiteId, result: "passed" })],
      }),
      makeCommitGroup({
        runs: [makeRun({ suiteId, result: "passed" })],
      }),
    ];

    const history = getSuiteHistory(suiteId, groups);
    expect(history).toEqual(["failed", "passed", "passed"]);
  });

  it("returns empty array when suite has no runs in any group", () => {
    const groups: CommitGroup[] = [
      makeCommitGroup({
        runs: [makeRun({ suiteId: "other-suite", result: "passed" })],
      }),
    ];

    expect(getSuiteHistory("nonexistent", groups)).toEqual([]);
  });

  it("maps non-pass/fail results to 'other'", () => {
    const suiteId = "suite-1";
    const groups: CommitGroup[] = [
      makeCommitGroup({
        runs: [makeRun({ suiteId, result: "cancelled" })],
      }),
      makeCommitGroup({
        runs: [makeRun({ suiteId, result: "pending" })],
      }),
    ];

    const history = getSuiteHistory(suiteId, groups);
    expect(history).toEqual(["other", "other"]);
  });
});

// ---------------------------------------------------------------------------
// isFlaky
// ---------------------------------------------------------------------------

describe("isFlaky", () => {
  it("returns false for fewer than 3 definitive results", () => {
    expect(isFlaky(["passed", "failed"])).toBe(false);
    expect(isFlaky(["passed"])).toBe(false);
    expect(isFlaky([])).toBe(false);
  });

  it("returns false for consistent pass history", () => {
    expect(isFlaky(["passed", "passed", "passed", "passed"])).toBe(false);
  });

  it("returns false for consistent fail history", () => {
    expect(isFlaky(["failed", "failed", "failed", "failed"])).toBe(false);
  });

  it("returns false for single switch (not enough flakiness)", () => {
    // One switch: passed → failed
    expect(isFlaky(["failed", "failed", "passed", "passed"])).toBe(false);
  });

  it("returns true for alternating pass/fail (2+ switches)", () => {
    // failed→passed→failed = 2 switches
    expect(isFlaky(["failed", "passed", "failed", "passed"])).toBe(true);
  });

  it("returns true for frequent alternation", () => {
    expect(isFlaky(["passed", "failed", "passed", "failed", "passed"])).toBe(
      true,
    );
  });

  it("ignores 'other' results when counting switches", () => {
    // After filtering: passed, failed, passed = 2 switches
    expect(isFlaky(["passed", "other", "failed", "other", "passed"])).toBe(
      true,
    );
  });

  it("only looks at first 10 entries", () => {
    // 12 entries, but only first 10 are considered
    const history: Array<"passed" | "failed" | "other"> = [
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "failed",
      "passed", // these are beyond the 10-entry window
    ];
    expect(isFlaky(history)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyFailure
// ---------------------------------------------------------------------------

describe("classifyFailure", () => {
  it("tags as 'new' when there is no prior history", () => {
    const suiteId = "suite-new";
    const run = makeRun({ suiteId, result: "failed" });
    const groups: CommitGroup[] = [makeCommitGroup({ runs: [run] })];

    const result = classifyFailure(run, "New Suite", groups);
    expect(result.tags).toContain("new");
    expect(result.suiteName).toBe("New Suite");
  });

  it("tags as 'regression' when previous run was passing", () => {
    const suiteId = "suite-reg";
    const failedRun = makeRun({ suiteId, result: "failed" });
    const groups: CommitGroup[] = [
      makeCommitGroup({ runs: [failedRun] }), // current (newest)
      makeCommitGroup({
        runs: [makeRun({ suiteId, result: "passed" })],
      }), // previous
    ];

    const result = classifyFailure(failedRun, "Regression Suite", groups);
    expect(result.tags).toContain("regression");
    expect(result.tags).not.toContain("new");
  });

  it("does NOT tag as regression when previous run was also failing", () => {
    const suiteId = "suite-still-fail";
    const failedRun = makeRun({ suiteId, result: "failed" });
    const groups: CommitGroup[] = [
      makeCommitGroup({ runs: [failedRun] }),
      makeCommitGroup({
        runs: [makeRun({ suiteId, result: "failed" })],
      }),
    ];

    const result = classifyFailure(failedRun, "Still Failing", groups);
    expect(result.tags).not.toContain("regression");
    expect(result.tags).not.toContain("new");
  });

  it("tags as both 'regression' and 'flaky' when history shows alternation", () => {
    const suiteId = "suite-flaky-reg";
    const failedRun = makeRun({ suiteId, result: "failed" });
    const groups: CommitGroup[] = [
      makeCommitGroup({ runs: [failedRun] }), // failed (current)
      makeCommitGroup({
        runs: [makeRun({ suiteId, result: "passed" })],
      }),
      makeCommitGroup({
        runs: [makeRun({ suiteId, result: "failed" })],
      }),
      makeCommitGroup({
        runs: [makeRun({ suiteId, result: "passed" })],
      }),
    ];

    const result = classifyFailure(failedRun, "Flaky Regression", groups);
    expect(result.tags).toContain("regression");
    expect(result.tags).toContain("flaky");
  });

  it("tags as 'flaky' without 'regression' when previous was also failing but history alternates", () => {
    const suiteId = "suite-flaky-nreg";
    const failedRun = makeRun({ suiteId, result: "failed" });
    const groups: CommitGroup[] = [
      makeCommitGroup({ runs: [failedRun] }), // failed (current)
      makeCommitGroup({
        runs: [makeRun({ suiteId, result: "failed" })],
      }),
      makeCommitGroup({
        runs: [makeRun({ suiteId, result: "passed" })],
      }),
      makeCommitGroup({
        runs: [makeRun({ suiteId, result: "failed" })],
      }),
      makeCommitGroup({
        runs: [makeRun({ suiteId, result: "passed" })],
      }),
    ];

    const result = classifyFailure(failedRun, "Flaky Only", groups);
    expect(result.tags).not.toContain("regression");
    expect(result.tags).toContain("flaky");
  });
});

// ---------------------------------------------------------------------------
// classifyAllFailures
// ---------------------------------------------------------------------------

describe("classifyAllFailures", () => {
  it("classifies multiple failures with correct suite names", () => {
    const run1 = makeRun({ suiteId: "s1", result: "failed" });
    const run2 = makeRun({ suiteId: "s2", result: "failed" });

    const suiteMap = new Map([
      ["s1", "Suite A"],
      ["s2", "Suite B"],
    ]);

    const groups: CommitGroup[] = [
      makeCommitGroup({ runs: [run1, run2], suiteMap }),
    ];

    const results = classifyAllFailures([run1, run2], suiteMap, groups);
    expect(results).toHaveLength(2);
    expect(results[0].suiteName).toBe("Suite A");
    expect(results[1].suiteName).toBe("Suite B");
    // Both are new (only one commit group)
    expect(results[0].tags).toContain("new");
    expect(results[1].tags).toContain("new");
  });

  it("uses 'Unknown suite' for unmapped suite IDs", () => {
    const run = makeRun({ suiteId: "unknown-id", result: "failed" });
    const groups: CommitGroup[] = [makeCommitGroup({ runs: [run] })];

    const results = classifyAllFailures([run], new Map(), groups);
    expect(results[0].suiteName).toBe("Unknown suite");
  });
});

// ---------------------------------------------------------------------------
// buildTriageContext
// ---------------------------------------------------------------------------

describe("buildTriageContext", () => {
  it("builds context with correct aggregated data", () => {
    const failedRun = makeRun({
      suiteId: "s1",
      result: "failed",
      summary: { total: 10, passed: 7, failed: 3, passRate: 70 },
      configSnapshot: {
        tests: [
          {
            title: "test-a",
            query: "q",
            provider: "p",
            model: "m",
            runs: 1,
            expectedToolCalls: [],
          },
          {
            title: "test-b",
            query: "q",
            provider: "p",
            model: "m",
            runs: 1,
            expectedToolCalls: [],
          },
        ],
        environment: { servers: [] },
      },
    });
    const passedRun = makeRun({
      suiteId: "s2",
      result: "passed",
      summary: { total: 5, passed: 5, failed: 0, passRate: 100 },
    });
    const notRunRun = makeRun({
      suiteId: "s3",
      result: "cancelled",
    });

    const suiteMap = new Map([
      ["s1", "Failed Suite"],
      ["s2", "Passed Suite"],
      ["s3", "Not Run Suite"],
    ]);

    const commitGroup = makeCommitGroup({
      commitSha: "abc123",
      shortSha: "abc1234",
      branch: "main",
      runs: [failedRun, passedRun, notRunRun],
      suiteMap,
    });

    const classified = [
      {
        run: failedRun,
        suiteName: "Failed Suite",
        tags: ["regression" as const],
      },
    ];

    const ctx = buildTriageContext(
      commitGroup,
      classified,
      [passedRun],
      [notRunRun],
    );

    expect(ctx.commitSha).toBe("abc1234");
    expect(ctx.branch).toBe("main");
    expect(ctx.totalSuites).toBe(3);
    expect(ctx.totalCases.total).toBe(15);
    expect(ctx.totalCases.passed).toBe(12);
    expect(ctx.totalCases.failed).toBe(3);
    expect(ctx.failures).toHaveLength(1);
    expect(ctx.failures[0].suiteName).toBe("Failed Suite");
    expect(ctx.failures[0].tags).toEqual(["regression"]);
    expect(ctx.failures[0].testNames).toEqual(["test-a", "test-b"]);
    expect(ctx.passedSuites).toEqual(["Passed Suite"]);
    expect(ctx.notRunSuites).toEqual(["Not Run Suite"]);
  });
});

// ---------------------------------------------------------------------------
// buildOverviewTriageContext
// ---------------------------------------------------------------------------

describe("buildOverviewTriageContext", () => {
  it("categorizes suites correctly", () => {
    const suites = [
      {
        suite: { _id: "s1", name: "Failing Suite" } as any,
        latestRun: makeRun({ suiteId: "s1", result: "failed" }),
        recentRuns: [],
        passRateTrend: [],
        totals: { passed: 3, failed: 2, runs: 5 },
      },
      {
        suite: { _id: "s2", name: "Passing Suite" } as any,
        latestRun: makeRun({ suiteId: "s2", result: "passed" }),
        recentRuns: [],
        passRateTrend: [],
        totals: { passed: 10, failed: 0, runs: 10 },
      },
      {
        suite: { _id: "s3", name: "New Suite" } as any,
        latestRun: null,
        recentRuns: [],
        passRateTrend: [],
        totals: { passed: 0, failed: 0, runs: 0 },
      },
    ];

    const ctx = buildOverviewTriageContext(suites, []);
    expect(ctx.totalSuites).toBe(3);
    expect(ctx.passingSuites).toBe(1);
    expect(ctx.neverRunSuites).toBe(1);
    expect(ctx.failingSuites).toHaveLength(1);
    expect(ctx.failingSuites[0].name).toBe("Failing Suite");
    expect(ctx.failingSuites[0].passRate).toBe("60%");
  });

  it("includes suites that passed overall but have failed cases", () => {
    const suites = [
      {
        suite: { _id: "s1", name: "Mostly Passing Suite" } as any,
        latestRun: makeRun({ suiteId: "s1", result: "passed" }),
        recentRuns: [],
        passRateTrend: [],
        totals: { passed: 14, failed: 2, runs: 16 },
      },
      {
        suite: { _id: "s2", name: "Fully Passing Suite" } as any,
        latestRun: makeRun({ suiteId: "s2", result: "passed" }),
        recentRuns: [],
        passRateTrend: [],
        totals: { passed: 10, failed: 0, runs: 10 },
      },
    ];

    const ctx = buildOverviewTriageContext(suites, []);
    expect(ctx.totalSuites).toBe(2);
    expect(ctx.passingSuites).toBe(1);
    expect(ctx.failingSuites).toHaveLength(1);
    expect(ctx.failingSuites[0].name).toBe("Mostly Passing Suite");
    expect(ctx.failingSuites[0].passRate).toBe("88%");
    expect(ctx.failingSuites[0].failedCases).toBe(2);
  });
});
