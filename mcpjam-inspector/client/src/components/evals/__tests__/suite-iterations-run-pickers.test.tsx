/**
 * Which run the settings sheet reaches for.
 *
 * `compareRunsBySequence` sorts ASCENDING, so a bare sort hands back run #1 —
 * and the sheet once backtested a draft rubric against a suite's very first
 * run, and opened "Compare with run" on it too. These pin the newest run.
 */

import { describe, expect, it, vi } from "vitest";

// The helpers are pure, but they live in the view module, which reads
// per-suite capabilities through Convex. Same isolation as the master-detail
// suite: nothing here ever renders, so nothing here ever needs the real hook.
vi.mock("@/hooks/use-suite-capabilities", () => ({
  useSuiteCapabilities: () => ({ state: "unavailable", capabilities: null }),
}));

import {
  pickBacktestableRun,
  sortRunsNewestFirst,
} from "../suite-iterations-view";
import type { EvalSuiteRun } from "../types";

function run(
  runNumber: number,
  overrides: Partial<EvalSuiteRun> = {},
): EvalSuiteRun {
  return {
    _id: `run-${runNumber}`,
    suiteId: "suite-1",
    createdBy: "u",
    runNumber,
    configRevision: "r",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    result: "passed",
    createdAt: runNumber,
    completedAt: runNumber + 1,
    source: "ui",
    goalCompletion: {
      summary: "",
      generatedAt: runNumber + 1,
      modelUsed: "m",
      threshold: 0.7,
      cases: [],
    },
    ...overrides,
  } as EvalSuiteRun;
}

describe("sortRunsNewestFirst", () => {
  it("puts the newest run first, whatever order the list arrived in", () => {
    expect(
      sortRunsNewestFirst([run(1), run(3), run(2)]).map((r) => r._id),
    ).toEqual(["run-3", "run-2", "run-1"]);
    expect(sortRunsNewestFirst([])).toEqual([]);
  });
});

describe("pickBacktestableRun", () => {
  it("backtests against run #3, not run #1, when both were judged", () => {
    expect(pickBacktestableRun([run(1), run(3)])?.runNumber).toBe(3);
  });

  it("skips runs still going and runs never judged, including a null verdict", () => {
    expect(
      pickBacktestableRun([
        run(1),
        run(2, { goalCompletion: undefined }),
        // A `null` verdict is stored on runs the judge never graded; it is no
        // more comparable than an absent one.
        run(3, { goalCompletion: null as unknown as undefined }),
        run(4, { status: "running", completedAt: undefined }),
      ])?.runNumber,
    ).toBe(1);
    expect(pickBacktestableRun([run(5, { status: "running" })])).toBeNull();
  });
});
