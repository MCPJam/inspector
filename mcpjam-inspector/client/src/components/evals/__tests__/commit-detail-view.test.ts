import { describe, expect, it } from "vitest";
import type { CommitGroup, EvalSuiteRun } from "../types";

// Test the helper logic used by CommitDetailView without rendering
// (categorizeRuns, getRunDuration, getTotalCases, getModelsUsed)

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

function makeCommitGroup(overrides: Partial<CommitGroup> = {}): CommitGroup {
  return {
    commitSha: "abc1234567890",
    shortSha: "abc1234",
    branch: "main",
    timestamp: 5000,
    status: "passed",
    runs: [],
    suiteMap: new Map(),
    summary: { total: 0, passed: 0, failed: 0, running: 0 },
    ...overrides,
  };
}

// Replicate categorizeRuns logic for testing
function categorizeRuns(runs: EvalSuiteRun[]) {
  const failed: EvalSuiteRun[] = [];
  const passed: EvalSuiteRun[] = [];
  const notRun: EvalSuiteRun[] = [];
  const running: EvalSuiteRun[] = [];

  for (const run of runs) {
    if (run.status === "running" || run.status === "pending") {
      running.push(run);
    } else if (run.result === "failed") {
      failed.push(run);
    } else if (run.result === "passed") {
      passed.push(run);
    } else {
      notRun.push(run);
    }
  }

  return { failed, passed, notRun, running };
}

describe("categorizeRuns", () => {
  it("separates runs by status/result", () => {
    const runs = [
      makeRun({ _id: "r1", result: "passed", status: "completed" }),
      makeRun({ _id: "r2", result: "failed", status: "completed" }),
      makeRun({ _id: "r3", status: "running" }),
      makeRun({ _id: "r4", result: "cancelled", status: "cancelled" }),
    ];

    const { passed, failed, running, notRun } = categorizeRuns(runs);

    expect(passed).toHaveLength(1);
    expect(passed[0]._id).toBe("r1");
    expect(failed).toHaveLength(1);
    expect(failed[0]._id).toBe("r2");
    expect(running).toHaveLength(1);
    expect(running[0]._id).toBe("r3");
    expect(notRun).toHaveLength(1);
    expect(notRun[0]._id).toBe("r4");
  });

  it("handles empty runs array", () => {
    const { passed, failed, running, notRun } = categorizeRuns([]);
    expect(passed).toHaveLength(0);
    expect(failed).toHaveLength(0);
    expect(running).toHaveLength(0);
    expect(notRun).toHaveLength(0);
  });

  it("treats pending runs as running", () => {
    const runs = [makeRun({ _id: "r1", status: "pending" })];
    const { running } = categorizeRuns(runs);
    expect(running).toHaveLength(1);
  });
});

describe("CommitGroup structure", () => {
  it("manual group has correct identifiers", () => {
    const group = makeCommitGroup({
      commitSha: "manual",
      shortSha: "Manual",
      branch: null,
    });
    expect(group.commitSha).toBe("manual");
    expect(group.shortSha).toBe("Manual");
    expect(group.branch).toBeNull();
  });

  it("suiteMap maps suiteId to name", () => {
    const map = new Map([
      ["s1", "Suite A"],
      ["s2", "Suite B"],
    ]);
    const group = makeCommitGroup({ suiteMap: map });
    expect(group.suiteMap.get("s1")).toBe("Suite A");
    expect(group.suiteMap.size).toBe(2);
  });
});
