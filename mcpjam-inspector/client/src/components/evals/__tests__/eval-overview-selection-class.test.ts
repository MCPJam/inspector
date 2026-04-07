import { describe, expect, it } from "vitest";
import { evalOverviewEntrySelectedRowClass } from "../helpers";
import type { EvalSuiteOverviewEntry } from "../types";

function entryWithRun(
  run: NonNullable<EvalSuiteOverviewEntry["latestRun"]>,
): EvalSuiteOverviewEntry {
  return {
    suite: { _id: "s", name: "n", createdBy: "u", workspaceId: "w" } as any,
    latestRun: run,
    recentRuns: [],
    passRateTrend: [],
    totals: { passed: 0, failed: 0, runs: 0 },
  };
}

describe("evalOverviewEntrySelectedRowClass", () => {
  it("uses inset ring instead of right border for selection emphasis", () => {
    const cls = evalOverviewEntrySelectedRowClass(
      entryWithRun({
        _id: "r",
        status: "completed",
        result: "failed",
        createdAt: 1,
      } as any),
    );
    expect(cls).toContain("ring-inset");
    expect(cls).not.toContain("border-r-");
  });
});
