import { describe, expect, it } from "vitest";
import type { EvalSuiteOverviewEntry } from "../../../evals/types";
import { buildSuiteRows } from "../suite-list-model";

function entry(
  name: string,
  passRate: number | null,
  completedAt: number,
): EvalSuiteOverviewEntry {
  const run =
    passRate === null
      ? null
      : {
          _id: `run_${name}`,
          runNumber: 1,
          status: "completed",
          result: "passed",
          summary: { total: 1, passed: 1, failed: 0, passRate },
          createdAt: completedAt,
          completedAt,
        };
  return {
    suite: { _id: name, name },
    latestRun: run,
    recentRuns: run ? [run] : [],
    passRateTrend: [],
    totals: { passed: 0, failed: 0, runs: 0 },
  } as unknown as EvalSuiteOverviewEntry;
}

const suites = [
  entry("beta", 0.9, 300),
  entry("alpha", 0.4, 100),
  entry("gamma", null, 0),
];
const names = (rows: ReturnType<typeof buildSuiteRows>) =>
  rows.map((row) => row.entry.suite.name);

describe("buildSuiteRows", () => {
  it.each([
    ["recent", ["beta", "alpha", "gamma"]],
    ["name", ["alpha", "beta", "gamma"]],
    ["passRate", ["alpha", "beta", "gamma"]],
  ] as const)("sorts by %s", (sort, expected) => {
    expect(names(buildSuiteRows(suites, sort, ""))).toEqual(expected);
  });

  it("filters by name, ignoring case and spaces around the query", () => {
    expect(names(buildSuiteRows(suites, "recent", "  ALP "))).toEqual([
      "alpha",
    ]);
  });
});
