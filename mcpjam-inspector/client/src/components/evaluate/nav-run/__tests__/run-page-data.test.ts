import { describe, expect, it } from "vitest";
import type { EvalSuiteRun } from "../../../evals/types";
import {
  compareCandidates,
  compareTease,
  previousRunForRunPage,
} from "../run-page-data";

function run(
  id: string,
  runNumber: number,
  overrides: Partial<EvalSuiteRun> = {},
): EvalSuiteRun {
  return {
    _id: id,
    suiteId: "suite-1",
    createdBy: "u1",
    runNumber,
    configRevision: "1",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    result: "passed",
    createdAt: runNumber * 1000,
    namedHostId: "host-1",
    effectiveModelId: "gpt-5-mini",
    ...overrides,
  };
}

const selected = run("r4", 4, { runGroupId: "launch-4" });

describe("previousRunForRunPage", () => {
  it.each<[string, EvalSuiteRun[], string | null]>([
    [
      "the latest earlier run of the same host and target",
      [run("r2", 2), run("r3", 3)],
      "r3",
    ],
    [
      "skips a subset rerun",
      [run("r2", 2), run("r3", 3, { rerunScope: "failed_cases" })],
      "r2",
    ],
    [
      "skips a run of the same launch",
      [run("r2", 2), run("r3", 3, { runGroupId: "launch-4" })],
      "r2",
    ],
    ["skips later runs", [run("r5", 5)], null],
    [
      "skips runs that did not complete",
      [run("r3", 3, { status: "cancelled" })],
      null,
    ],
    ["skips another host", [run("r3", 3, { namedHostId: "host-2" })], null],
    [
      "skips another model",
      [run("r3", 3, { effectiveModelId: "claude-haiku-4.5" })],
      null,
    ],
  ])("%s", (_, earlier, expected) => {
    expect(
      previousRunForRunPage(selected, [selected, ...earlier])?._id ?? null,
    ).toBe(expected);
  });

  it("has no baseline for a run that has not completed", () => {
    expect(
      previousRunForRunPage(run("r4", 4, { status: "running" }), [
        run("r3", 3),
      ]),
    ).toBeNull();
    expect(previousRunForRunPage(null, [run("r3", 3)])).toBeNull();
  });
});

describe("compareCandidates", () => {
  it("leaves out this launch and inconclusive runs", () => {
    const runs = [
      selected,
      run("sibling", 4, { runGroupId: "launch-4" }),
      run("r3", 3),
      run("r2", 2, { result: "inconclusive" }),
    ];
    expect(compareCandidates(selected, runs).map((item) => item._id)).toEqual([
      "r3",
    ]);
  });
});

describe("compareTease", () => {
  const summary = {
    baseRunNumber: 3,
    regressed: 1,
    fixed: 0,
    stillFailing: 0,
    passing: 2,
    added: 0,
    removed: 0,
    changed: 0,
  };
  it("joins what changed, or says nothing changed state", () => {
    expect(compareTease(summary)).toBe("vs run #3 · 1 regressed · 2 passing");
    expect(compareTease({ ...summary, regressed: 0, passing: 0 })).toBe(
      "vs run #3 · no case changed state",
    );
    expect(compareTease(null)).toBeNull();
  });
});
