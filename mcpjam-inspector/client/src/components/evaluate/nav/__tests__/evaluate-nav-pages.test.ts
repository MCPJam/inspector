import { describe, expect, it } from "vitest";
import type { EvalRoute, EvaluateNavRoute } from "@/lib/eval-route-types";
import { buildEvaluatePath } from "@/lib/app-navigation";
import {
  EVALUATE_NAV_PAGES,
  resolveEvaluateNavPage,
  toCurrentEvalRoute,
} from "../evaluate-nav-pages";

/** Each new route and the URL of today's page that shows the same thing. */
const rows: Array<[EvaluateNavRoute, string]> = [
  [{ type: "evaluate-runs" }, "/evaluate"],
  [
    { type: "suite-settings", suiteId: "s_1", tab: "settings" },
    "/evaluate/suite/s_1/edit",
  ],
  [
    { type: "suite-settings", suiteId: "s_1", tab: "cases" },
    "/evaluate/suite/s_1?view=test-cases",
  ],
  [
    { type: "suite-settings", suiteId: "s_1", tab: "evaluators" },
    "/evaluate/suite/s_1/edit",
  ],
  [
    { type: "case-new", suiteId: "s_1" },
    "/evaluate/suite/s_1/test/draft%3Adescribe/edit",
  ],
  [
    { type: "case-settings", suiteId: "s_1", caseId: "c_1" },
    "/evaluate/suite/s_1/test/c_1/edit",
  ],
  [
    { type: "case-evaluators", suiteId: "s_1", caseId: "c_1" },
    "/evaluate/suite/s_1/test/c_1/edit?checks=1",
  ],
  [
    {
      type: "test-run",
      suiteId: "s_1",
      runId: "r_1",
      caseId: "c_1",
      target: "m",
    },
    "/evaluate/suite/s_1/runs/r_1?case=c_1",
  ],
  [
    { type: "test-run-edit", suiteId: "s_1", runId: "r_1", caseId: "c_1" },
    "/evaluate/suite/s_1/test/c_1/edit",
  ],
  [
    {
      type: "iteration",
      suiteId: "s_1",
      runId: "r_1",
      caseId: "c_1",
      iterationId: "i_1",
    },
    "/evaluate/suite/s_1/runs/r_1?iteration=i_1&case=c_1",
  ],
];

describe("Evaluate nav page map", () => {
  it.each(rows)("opens today's page for %o", (route, currentUrl) => {
    const resolved = resolveEvaluateNavPage(route);
    expect(buildEvaluatePath(resolved.currentRoute)).toBe(currentUrl);
    expect(resolved.page).toBe(EVALUATE_NAV_PAGES[route.type].page);
  });

  it("has no new page yet, so nothing waits for the flag", () => {
    for (const [route] of rows) {
      expect(resolveEvaluateNavPage(route).element).toBeUndefined();
    }
  });

  it("covers every new route kind", () => {
    expect(new Set(rows.map(([route]) => route.type))).toEqual(
      new Set(Object.keys(EVALUATE_NAV_PAGES)),
    );
  });

  it("passes today's routes through unchanged", () => {
    const route: EvalRoute = {
      type: "run-detail",
      suiteId: "s_1",
      runId: "r_1",
    };
    expect(toCurrentEvalRoute(route)).toBe(route);
  });
});
