import { describe, expect, it } from "vitest";
import { groupRunsByCommit } from "../helpers";
import type { EvalSuiteOverviewEntry, EvalSuiteRun } from "../types";

function entryWith(run: Partial<EvalSuiteRun>): EvalSuiteOverviewEntry {
  return {
    suite: { _id: "suite-1", name: "Checkout" },
    latestRun: null,
    recentRuns: [
      {
        _id: "run-1",
        suiteId: "suite-1",
        runNumber: 1,
        createdAt: 1_000,
        ciMetadata: { commitSha: "abc1234" },
        ...run,
      },
    ],
    passRateTrend: [],
  } as unknown as EvalSuiteOverviewEntry;
}

describe("groupRunsByCommit — a run held for its judge", () => {
  it("counts a grading run as running, so the commit is not painted green", () => {
    // `grading` used to land in no bucket at all: running, passed, failed and
    // inconclusive were all zero, and the fall-through gave the commit a
    // `passed` rail for a run with no verdict.
    const [group] = groupRunsByCommit([
      entryWith({ status: "grading", result: "pending" }),
    ]);
    expect(group.summary.running).toBe(1);
    expect(group.summary.passed).toBe(0);
    expect(group.status).toBe("running");
  });
});
