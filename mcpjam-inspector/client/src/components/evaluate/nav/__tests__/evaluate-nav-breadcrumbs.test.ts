import { describe, expect, it } from "vitest";
import type { EvalRoute } from "@/lib/eval-route-types";
import { buildEvaluatePath } from "@/lib/app-navigation";
import {
  buildEvaluateNavCrumbs,
  type EvaluateNavCrumbNames,
} from "../evaluate-nav-breadcrumbs";

const names: EvaluateNavCrumbNames = {
  suiteName: "Excalidraw quickstart",
  caseName: "Draw a rectangle",
  runNumber: 6,
  iterationNumber: 2,
};

const suite = "/evaluate/suite/s_1";
const testRun = `${suite}/runs/r_1/cases/c_1`;

/** Each row: route, then each crumb as `label → path`. */
const rows: Array<[EvalRoute, string[]]> = [
  [{ type: "list" }, ["Evaluate → /evaluate"]],
  [{ type: "evaluate-runs" }, ["Evaluate → /evaluate"]],
  [
    { type: "suite-overview", suiteId: "s_1" },
    ["Evaluate → /evaluate", `Excalidraw quickstart → ${suite}`],
  ],
  [
    { type: "suite-settings", suiteId: "s_1", tab: "evaluators" },
    [
      "Evaluate → /evaluate",
      `Excalidraw quickstart → ${suite}`,
      `Suite settings → ${suite}/settings/evaluators`,
    ],
  ],
  [
    { type: "case-new", suiteId: "s_1" },
    [
      "Evaluate → /evaluate",
      `Excalidraw quickstart → ${suite}`,
      `Suite settings → ${suite}/settings/cases`,
      `New test case → ${suite}/settings/cases/new`,
    ],
  ],
  [
    { type: "case-evaluators", suiteId: "s_1", caseId: "c_1" },
    [
      "Evaluate → /evaluate",
      `Excalidraw quickstart → ${suite}`,
      `Suite settings → ${suite}/settings/cases`,
      `Draw a rectangle → ${suite}/settings/cases/c_1`,
      `Test Case Evaluators → ${suite}/settings/cases/c_1/evaluators`,
    ],
  ],
  [
    { type: "run-detail", suiteId: "s_1", runId: "r_1" },
    [
      "Evaluate → /evaluate",
      `Excalidraw quickstart → ${suite}`,
      `Run #6 → ${suite}/runs/r_1`,
    ],
  ],
  [
    {
      type: "test-run",
      suiteId: "s_1",
      runId: "r_1",
      caseId: "c_1",
      target: "model-b",
    },
    [
      "Evaluate → /evaluate",
      `Excalidraw quickstart → ${suite}`,
      `Run #6 → ${suite}/runs/r_1`,
      `Draw a rectangle → ${testRun}?target=model-b`,
    ],
  ],
  [
    { type: "test-run-edit", suiteId: "s_1", runId: "r_1", caseId: "c_1" },
    [
      "Evaluate → /evaluate",
      `Excalidraw quickstart → ${suite}`,
      `Run #6 → ${suite}/runs/r_1`,
      `Draw a rectangle → ${testRun}`,
      `Edit Test Case → ${testRun}/edit`,
    ],
  ],
  [
    {
      type: "iteration",
      suiteId: "s_1",
      runId: "r_1",
      caseId: "c_1",
      iterationId: "i_1",
    },
    [
      "Evaluate → /evaluate",
      `Excalidraw quickstart → ${suite}`,
      `Run #6 → ${suite}/runs/r_1`,
      `Draw a rectangle → ${testRun}`,
      `Iteration #2 → ${testRun}/iter/i_1`,
    ],
  ],
];

describe("buildEvaluateNavCrumbs", () => {
  it.each(rows)("builds the trail for %o", (route, expected) => {
    expect(
      buildEvaluateNavCrumbs(route, names).map(
        (crumb) => `${crumb.label} → ${buildEvaluatePath(crumb.route)}`,
      ),
    ).toEqual(expected);
  });

  it("ends on the current route", () => {
    for (const [route] of rows) {
      if (route.type === "evaluate-runs") continue;
      expect(buildEvaluateNavCrumbs(route, names).at(-1)?.route).toEqual(route);
    }
  });

  it("names levels generically until their names load", () => {
    expect(
      buildEvaluateNavCrumbs({
        type: "iteration",
        suiteId: "s_1",
        runId: "r_1",
        caseId: "c_1",
        iterationId: "i_1",
      }).map((crumb) => crumb.label),
    ).toEqual(["Evaluate", "Suite", "Run", "Test run", "Iteration"]);
  });
});
