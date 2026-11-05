import { describe, expect, it } from "vitest";
import type { EvalRoute } from "@/lib/eval-route-types";
import { buildEvalCrumbs, type EvalNavNames } from "../eval-nav-crumbs";

const names: EvalNavNames = {
  suiteName: "Billing",
  runNumber: 4,
  testCaseTitle: "Refund",
  iterationNumber: 2,
};

const evaluate = { label: "Evaluate", to: { type: "list" } };
const suite = {
  label: "Billing",
  to: { type: "suite-overview", suiteId: "s" },
};
const settings = {
  label: "Suite settings",
  to: { type: "suite-settings", suiteId: "s", tab: "cases" },
};
const run = {
  label: "Run #4",
  to: { type: "run-detail", suiteId: "s", runId: "r" },
};
const testRun = {
  label: "Refund",
  to: { type: "test-run", suiteId: "s", runId: "r", testCaseId: "c" },
};

const TRAILS: Array<[EvalRoute, unknown[]]> = [
  [{ type: "suite-overview", suiteId: "s" }, [evaluate, { label: "Billing" }]],
  [
    { type: "suite-settings", suiteId: "s", tab: "settings" },
    [evaluate, suite, { label: "Suite settings" }],
  ],
  [
    { type: "case-new", suiteId: "s" },
    [evaluate, suite, settings, { label: "New case" }],
  ],
  [
    { type: "case-settings", suiteId: "s", testCaseId: "c" },
    [evaluate, suite, settings, { label: "Refund" }],
  ],
  [
    { type: "case-evaluators", suiteId: "s", testCaseId: "c" },
    [
      evaluate,
      suite,
      settings,
      {
        label: "Refund",
        to: { type: "case-settings", suiteId: "s", testCaseId: "c" },
      },
      { label: "Test Case Evaluators" },
    ],
  ],
  [
    { type: "run-detail", suiteId: "s", runId: "r" },
    [evaluate, suite, { label: "Run #4" }],
  ],
  [
    {
      type: "run-detail",
      suiteId: "s",
      runId: "r",
      testCaseId: "c",
      iteration: "i",
    },
    [evaluate, suite, { label: "Run #4" }],
  ],
  [
    {
      type: "test-run",
      suiteId: "s",
      runId: "r",
      testCaseId: "c",
      target: "m",
    },
    [evaluate, suite, run, { label: "Refund" }],
  ],
  [
    {
      type: "iteration",
      suiteId: "s",
      runId: "r",
      testCaseId: "c",
      iterationId: "i",
    },
    [evaluate, suite, run, testRun, { label: "Iteration #2" }],
  ],
  [
    { type: "test-run-edit", suiteId: "s", runId: "r", testCaseId: "c" },
    [evaluate, suite, run, testRun, { label: "Edit Test Case" }],
  ],
];

describe("buildEvalCrumbs", () => {
  it.each(TRAILS)("builds the trail for %o", (route, expected) => {
    expect(buildEvalCrumbs(route, names)).toEqual(expected);
  });

  it.each(TRAILS)(
    "keeps the crumb count while names load for %o",
    (route, expected) => {
      const loading = buildEvalCrumbs(route, {});
      expect(loading).toHaveLength(expected.length);
      expect(loading?.[0]).toEqual(evaluate);
    },
  );

  it("shows placeholders marked pending while names load", () => {
    expect(
      buildEvalCrumbs(
        {
          type: "iteration",
          suiteId: "s",
          runId: "r",
          testCaseId: "c",
          iterationId: "i",
        },
        {},
      ),
    ).toEqual([
      evaluate,
      { label: "Suite", pending: true, to: suite.to },
      { label: "Run", pending: true, to: run.to },
      { label: "Test case", pending: true, to: testRun.to },
      { label: "Iteration", pending: true },
    ]);
  });

  it("names blank suites and cases", () => {
    const crumbs = buildEvalCrumbs(
      { type: "case-settings", suiteId: "s", testCaseId: "c" },
      { suiteName: "", testCaseTitle: "  " },
    );
    expect(crumbs?.[1]).toEqual({ label: "Untitled suite", to: suite.to });
    expect(crumbs?.[3]).toEqual({ label: "Untitled test case" });
  });

  it("gives every suite settings tab the same trail", () => {
    const trails = (["settings", "cases", "evaluators"] as const).map((tab) =>
      buildEvalCrumbs({ type: "suite-settings", suiteId: "s", tab }, names),
    );
    expect(trails[1]).toEqual(trails[0]);
    expect(trails[2]).toEqual(trails[0]);
  });

  it.each<EvalRoute>([{ type: "list" }, { type: "evaluate-runs" }])(
    "returns no trail on the landing ($type)",
    (route) => {
      expect(buildEvalCrumbs(route, names)).toEqual([]);
    },
  );

  it.each<EvalRoute>([
    { type: "create" },
    { type: "eval-server", serverId: "x" },
    { type: "test-detail", suiteId: "s", testId: "t" },
    { type: "test-edit", suiteId: "s", testId: "t" },
    { type: "suite-edit", suiteId: "s" },
    { type: "commit-detail", commitSha: "abc" },
    { type: "run-detail", suiteId: "s", runId: "r", comparison: true },
  ])("leaves $type to today's header", (route) => {
    expect(buildEvalCrumbs(route, names)).toBeNull();
  });
});
