import { describe, expect, it } from "vitest";
import type { EvalRoute } from "@/lib/eval-route-types";
import {
  buildEvalBack,
  evalNavPlace,
  type EvalNavNames,
} from "../eval-nav-crumbs";
import { readEvalNavState } from "../eval-nav-state";

const names: EvalNavNames = {
  suiteName: "Billing",
  runNumber: 4,
  testCaseTitle: "Refund",
};
const from = { path: "/evaluate/runs", place: "Runs" };

const DEFAULTS: Array<[EvalRoute, { label: string; path: string } | null]> = [
  [{ type: "list" }, null],
  [{ type: "evaluate-runs" }, null],
  [{ type: "suite-overview", suiteId: "s" }, null],
  [
    { type: "suite-settings", suiteId: "s", tab: "evaluators" },
    { label: "Back to suite", path: "/evaluate/suite/s" },
  ],
  [{ type: "case-new", suiteId: "s" }, null],
  [
    { type: "case-settings", suiteId: "s", testCaseId: "c" },
    {
      label: "Back to suite settings",
      path: "/evaluate/suite/s/settings/cases",
    },
  ],
  [{ type: "case-evaluators", suiteId: "s", testCaseId: "c" }, null],
  [
    { type: "run-detail", suiteId: "s", runId: "r" },
    { label: "Back to suite", path: "/evaluate/suite/s" },
  ],
  [
    { type: "test-run", suiteId: "s", runId: "r", testCaseId: "c" },
    { label: "Back to Run #4", path: "/evaluate/suite/s/runs/r" },
  ],
  [
    {
      type: "iteration",
      suiteId: "s",
      runId: "r",
      testCaseId: "c",
      iterationId: "i",
    },
    { label: "Back to test run", path: "/evaluate/suite/s/runs/r/cases/c" },
  ],
  [
    { type: "test-run-edit", suiteId: "s", runId: "r", testCaseId: "c" },
    { label: "Back to test run", path: "/evaluate/suite/s/runs/r/cases/c" },
  ],
  [{ type: "run-detail", suiteId: "s", runId: "r", comparison: true }, null],
  [{ type: "suite-edit", suiteId: "s" }, null],
];

describe("buildEvalBack", () => {
  it.each(DEFAULTS)("defaults for %o", (route, expected) => {
    expect(buildEvalBack(route, names, null)).toEqual(expected);
  });

  it.each<EvalRoute>([
    { type: "suite-settings", suiteId: "s", tab: "settings" },
    { type: "run-detail", suiteId: "s", runId: "r" },
    { type: "test-run", suiteId: "s", runId: "r", testCaseId: "c" },
    {
      type: "iteration",
      suiteId: "s",
      runId: "r",
      testCaseId: "c",
      iterationId: "i",
    },
  ])("returns to the page you came from on $type", (route) => {
    expect(buildEvalBack(route, names, from)).toEqual({
      label: "Back to Runs",
      path: "/evaluate/runs",
    });
  });

  it("ignores a from that points at this page", () => {
    const route: EvalRoute = { type: "run-detail", suiteId: "s", runId: "r" };
    expect(
      buildEvalBack(route, names, {
        path: "/evaluate/suite/s/runs/r",
        place: "Run #4",
      }),
    ).toEqual({ label: "Back to suite", path: "/evaluate/suite/s" });
  });

  it.each<EvalRoute>([
    { type: "case-settings", suiteId: "s", testCaseId: "c" },
    { type: "test-run-edit", suiteId: "s", runId: "r", testCaseId: "c" },
  ])("keeps the address's own Back on $type", (route) => {
    expect(buildEvalBack(route, names, from)).toEqual(
      buildEvalBack(route, names, null),
    );
  });

  it("names the run while its number loads", () => {
    expect(
      buildEvalBack(
        { type: "test-run", suiteId: "s", runId: "r", testCaseId: "c" },
        {},
        null,
      ),
    ).toEqual({ label: "Back to run", path: "/evaluate/suite/s/runs/r" });
  });
});

describe("evalNavPlace", () => {
  it.each<[EvalRoute, string]>([
    [{ type: "list" }, "Suites"],
    [{ type: "evaluate-runs" }, "Runs"],
    [{ type: "suite-overview", suiteId: "s" }, "suite"],
    [{ type: "suite-settings", suiteId: "s", tab: "cases" }, "suite settings"],
    [{ type: "case-new", suiteId: "s" }, "new case"],
    [{ type: "case-settings", suiteId: "s", testCaseId: "c" }, "test case"],
    [
      { type: "case-evaluators", suiteId: "s", testCaseId: "c" },
      "test case evaluators",
    ],
    [{ type: "run-detail", suiteId: "s", runId: "r" }, "Run #4"],
    [
      { type: "test-run", suiteId: "s", runId: "r", testCaseId: "c" },
      "test run",
    ],
    [
      {
        type: "iteration",
        suiteId: "s",
        runId: "r",
        testCaseId: "c",
        iterationId: "i",
      },
      "iteration",
    ],
    [
      { type: "test-run-edit", suiteId: "s", runId: "r", testCaseId: "c" },
      "test case",
    ],
  ])("names %o", (route, place) => {
    expect(evalNavPlace(route, names)).toBe(place);
  });

  it("calls a loading run 'run'", () => {
    expect(
      evalNavPlace({ type: "run-detail", suiteId: "s", runId: "r" }, {}),
    ).toBe("run");
  });
});

describe("readEvalNavState", () => {
  it("reads the documented shape", () => {
    expect(readEvalNavState({ evalNav: { via: "link", from } })).toEqual({
      via: "link",
      from,
    });
    expect(readEvalNavState({ evalNav: { via: "crumb" } })).toEqual({
      via: "crumb",
    });
  });

  it.each([
    null,
    undefined,
    "state",
    {},
    { evalNav: null },
    { evalNav: { via: "teleport" } },
    { evalNav: { via: "link", from: { place: "Runs" } } },
    { evalNav: { via: "link", from: { path: 4, place: "Runs" } } },
    { evalNav: { via: "link", from: "x" } },
  ])("rejects %o", (state) => {
    expect(readEvalNavState(state)).toBeNull();
  });
});
