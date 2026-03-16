import { describe, expect, it } from "vitest";
import { groupRunsByCommit } from "../helpers";
import type { EvalSuiteOverviewEntry, EvalSuiteRun } from "../types";

function makeRun(overrides: Partial<EvalSuiteRun> = {}): EvalSuiteRun {
  return {
    _id: "run_1",
    suiteId: "suite_1",
    createdBy: "user_1",
    runNumber: 1,
    configRevision: "rev1",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    result: "passed",
    createdAt: 1000,
    ...overrides,
  };
}

function makeEntry(
  suiteId: string,
  suiteName: string,
  runs: EvalSuiteRun[],
): EvalSuiteOverviewEntry {
  return {
    suite: {
      _id: suiteId,
      createdBy: "user_1",
      name: suiteName,
      description: "",
      configRevision: "rev1",
      environment: { servers: [] },
      createdAt: 0,
      updatedAt: 0,
    },
    latestRun: runs[0] ?? null,
    recentRuns: runs,
    passRateTrend: [],
    totals: { passed: 0, failed: 0, runs: runs.length },
  };
}

describe("groupRunsByCommit", () => {
  it("groups runs by commitSha", () => {
    const runs = [
      makeRun({
        _id: "r1",
        suiteId: "s1",
        ciMetadata: { commitSha: "abc1234567890" },
        createdAt: 2000,
      }),
      makeRun({
        _id: "r2",
        suiteId: "s1",
        ciMetadata: { commitSha: "abc1234567890" },
        createdAt: 3000,
      }),
      makeRun({
        _id: "r3",
        suiteId: "s1",
        ciMetadata: { commitSha: "def4567890123" },
        createdAt: 1000,
      }),
    ];

    const result = groupRunsByCommit([makeEntry("s1", "Suite 1", runs)]);

    expect(result).toHaveLength(2);
    expect(result[0].shortSha).toBe("abc1234");
    expect(result[0].runs).toHaveLength(2);
    expect(result[1].shortSha).toBe("def4567");
    expect(result[1].runs).toHaveLength(1);
  });

  it("puts manual runs (no commitSha) last", () => {
    const runs = [
      makeRun({ _id: "r1", createdAt: 5000 }), // no ciMetadata
      makeRun({
        _id: "r2",
        ciMetadata: { commitSha: "abc1234567890" },
        createdAt: 1000,
      }),
    ];

    const result = groupRunsByCommit([makeEntry("s1", "Suite 1", runs)]);

    expect(result).toHaveLength(2);
    expect(result[0].commitSha).toBe("abc1234567890");
    expect(result[1].commitSha).toBe("manual-r1");
    expect(result[1].shortSha).toBe("Manual");
  });

  it("sorts by most recent timestamp first", () => {
    const runs = [
      makeRun({
        _id: "r1",
        ciMetadata: { commitSha: "old1234567890" },
        createdAt: 1000,
      }),
      makeRun({
        _id: "r2",
        ciMetadata: { commitSha: "new1234567890" },
        createdAt: 5000,
      }),
    ];

    const result = groupRunsByCommit([makeEntry("s1", "Suite 1", runs)]);

    expect(result[0].shortSha).toBe("new1234");
    expect(result[1].shortSha).toBe("old1234");
  });

  it("computes aggregate status correctly", () => {
    const runs = [
      makeRun({
        _id: "r1",
        ciMetadata: { commitSha: "mix1234567890" },
        result: "passed",
        status: "completed",
        createdAt: 1000,
      }),
      makeRun({
        _id: "r2",
        ciMetadata: { commitSha: "mix1234567890" },
        result: "failed",
        status: "completed",
        createdAt: 2000,
      }),
    ];

    const result = groupRunsByCommit([makeEntry("s1", "Suite 1", runs)]);

    expect(result[0].status).toBe("mixed");
    expect(result[0].summary.passed).toBe(1);
    expect(result[0].summary.failed).toBe(1);
  });

  it("picks up branch from ciMetadata", () => {
    const runs = [
      makeRun({
        _id: "r1",
        ciMetadata: { commitSha: "abc1234567890", branch: "feature/test" },
        createdAt: 1000,
      }),
    ];

    const result = groupRunsByCommit([makeEntry("s1", "Suite 1", runs)]);
    expect(result[0].branch).toBe("feature/test");
  });

  it("builds suiteMap from multiple overview entries", () => {
    const entry1 = makeEntry("s1", "Suite A", [
      makeRun({
        _id: "r1",
        suiteId: "s1",
        ciMetadata: { commitSha: "abc1234567890" },
        createdAt: 1000,
      }),
    ]);
    const entry2 = makeEntry("s2", "Suite B", [
      makeRun({
        _id: "r2",
        suiteId: "s2",
        ciMetadata: { commitSha: "abc1234567890" },
        createdAt: 2000,
      }),
    ]);

    const result = groupRunsByCommit([entry1, entry2]);

    expect(result).toHaveLength(1);
    expect(result[0].suiteMap.get("s1")).toBe("Suite A");
    expect(result[0].suiteMap.get("s2")).toBe("Suite B");
    expect(result[0].runs).toHaveLength(2);
  });

  it("returns empty array for empty input", () => {
    expect(groupRunsByCommit([])).toEqual([]);
  });
});
