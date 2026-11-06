import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type {
  EvalCase,
  EvalIteration,
  EvalSuiteRun,
} from "../../../evals/types";
import { useTestRunData } from "../use-test-run-data";
import {
  CASE_ID,
  ITERATIONS,
  RUN_A,
  RUN_B,
  SUITE,
  TEST_CASE,
  fixtureIteration,
  fixtureRun,
} from "./test-run-fixtures";

type Args = Record<string, unknown>;
const mocks = vi.hoisted(() => ({
  answer: (_name: string, _args: Args): unknown => undefined,
  calls: [] as [string, Args][],
}));

vi.mock("convex/react", async () =>
  (await import("@/test/mocks/convex-use-queries")).withUseQueries({
    useQuery: (name: string, args: Args) => {
      mocks.calls.push([name, args]);
      return mocks.answer(name, args);
    },
  }),
);

const OTHER_LAUNCH = fixtureRun("run-z", {
  runGroupId: "launch-9",
  runNumber: 9,
});
let runs: Record<string, EvalSuiteRun>;
let testCase: EvalCase | null;
let perCase: Record<string, unknown>;
let details: Record<string, EvalIteration[]>;

const byRun = (runId: string) =>
  ITERATIONS.filter((item) => item.suiteRunId === runId);
const page = <T>(items: T[], isDone = true) => ({
  page: items,
  isDone,
  continueCursor: "",
});

beforeEach(() => {
  runs = { "run-a": RUN_A, "run-b": RUN_B, "run-z": OTHER_LAUNCH };
  testCase = TEST_CASE;
  perCase = { "run-a": page(byRun("run-a")), "run-b": page(byRun("run-b")) };
  details = {};
  mocks.calls = [];
  mocks.answer = (name, args) => {
    switch (name) {
      case "testSuites:getTestSuiteRun":
        return runs[args.runId as string] ?? null;
      case "testSuites:listTestSuiteRunSummaries":
        return page(Object.values(runs));
      case "testSuites:getTestSuite":
        return SUITE;
      case "testSuites:getTestCase":
        return testCase;
      case "testSuites:listTestRunIterations":
        return perCase[args.suiteRunId as string];
      case "testSuites:getTestSuiteRunDetails":
        return {
          run: runs[args.runId as string],
          iterations: details[args.runId as string] ?? [],
        };
    }
    return undefined;
  };
});

const ids = {
  suiteId: "suite-excalidraw",
  runId: "run-a",
  testCaseId: CASE_ID,
};
const read = () => renderHook(() => useTestRunData(ids)).result.current;
const requested = (name: string) =>
  [
    ...new Set(
      mocks.calls.filter(([n]) => n === name).map(([, a]) => JSON.stringify(a)),
    ),
  ].map((a) => JSON.parse(a) as Args);

describe("useTestRunData", () => {
  it("reads this case once per launch run, siblings found by run group", () => {
    const data = read();
    expect(data.status).toBe("ready");
    expect(data.launchRuns.map((run) => run._id)).toEqual(["run-a", "run-b"]);
    expect(requested("testSuites:listTestRunIterations")).toEqual([
      {
        suiteRunId: "run-a",
        testCaseId: CASE_ID,
        paginationOpts: { numItems: 200, cursor: null },
      },
      {
        suiteRunId: "run-b",
        testCaseId: CASE_ID,
        paginationOpts: { numItems: 200, cursor: null },
      },
    ]);
    expect(requested("testSuites:listTestSuiteRunSummaries")[0]).toMatchObject({
      runGroupId: "launch-4",
    });
    expect(data.iterations).toHaveLength(8);
    expect(data.source).toBe("case");
    expect(data.truncated).toBe(false);
    expect(data.matrix?.targets).toHaveLength(2);
    expect(requested("testSuites:getTestSuiteRunDetails")).toEqual([]);
  });

  it("says the list was cut when a run has more to read", () => {
    perCase["run-b"] = page(byRun("run-b"), false);
    expect(read().truncated).toBe(true);
  });

  it("falls back to the run-wide read, filtered to the case key, when the per-case read fails", () => {
    perCase["run-b"] = new Error("not a case id");
    details["run-b"] = [
      ...byRun("run-b"),
      fixtureIteration("other", "run-b", { testCaseId: "case-other" }),
    ];
    const data = read();
    expect(data.source).toBe("runWide");
    expect(data.iterations.map((item) => item._id)).toEqual([
      "a1",
      "a2",
      "a3",
      "a4",
      "b1",
      "b2",
      "b3",
      "b4",
    ]);
  });

  it("falls back on an empty page from a finished run, not from a running one", () => {
    perCase["run-b"] = page([]);
    details["run-b"] = byRun("run-b");
    expect(read().source).toBe("runWide");

    mocks.calls = [];
    runs["run-b"] = { ...RUN_B, status: "running" };
    const data = read();
    expect(data.source).toBe("case");
    expect(requested("testSuites:getTestSuiteRunDetails")).toEqual([]);
  });

  it("keeps going when the case was deleted, titled from the snapshot", () => {
    testCase = null;
    const data = read();
    expect(data.testCase).toBeNull();
    expect(data.title).toBe("Sketch a two-node flow");
  });

  it("does not show a run of another suite", () => {
    runs["run-a"] = { ...RUN_A, suiteId: "suite-other" };
    expect(read().status).toBe("runNotFound");
  });

  it("says the case did not run when no run planned or recorded it", () => {
    perCase = { "run-a": page([]), "run-b": page([]) };
    runs["run-a"] = {
      ...RUN_A,
      configSnapshot: { ...RUN_A.configSnapshot, tests: [] },
    };
    runs["run-b"] = {
      ...RUN_B,
      configSnapshot: { ...RUN_B.configSnapshot, tests: [] },
    };
    expect(read().status).toBe("caseNotInRun");
  });

  it("is loading until every read answers", () => {
    perCase["run-b"] = undefined;
    expect(read().status).toBe("loading");
  });
});
