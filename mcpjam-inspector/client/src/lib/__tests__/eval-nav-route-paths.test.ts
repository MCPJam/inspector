import { describe, expect, it } from "vitest";
import { buildEvalsPath, buildEvaluatePath } from "../app-navigation";
import { APP_ROUTES, matchAppRoute } from "../app-routes";
import { EVALUATE_NAV_ROUTE_PATHS } from "../eval-nav-route-paths";
import { parseEvalRouteFromUrl } from "../eval-route-url";
import type { EvalNavRoute } from "../eval-route-types";

const ROWS: [string, EvalNavRoute][] = [
  ["/evaluate/runs", { type: "evaluate-runs" }],
  [
    "/evaluate/suite/s1/settings",
    { type: "suite-settings", suiteId: "s1", tab: "settings" },
  ],
  [
    "/evaluate/suite/s1/settings/cases",
    { type: "suite-settings", suiteId: "s1", tab: "cases" },
  ],
  [
    "/evaluate/suite/s1/settings/evaluators",
    { type: "suite-settings", suiteId: "s1", tab: "evaluators" },
  ],
  [
    "/evaluate/suite/s1/settings/cases/new",
    { type: "case-new", suiteId: "s1" },
  ],
  [
    "/evaluate/suite/s1/settings/cases/c1",
    { type: "case-settings", suiteId: "s1", testCaseId: "c1" },
  ],
  [
    "/evaluate/suite/s1/settings/cases/c1/evaluators",
    { type: "case-evaluators", suiteId: "s1", testCaseId: "c1" },
  ],
  [
    "/evaluate/suite/s1/runs/r1/cases/c1",
    { type: "test-run", suiteId: "s1", runId: "r1", testCaseId: "c1" },
  ],
  [
    "/evaluate/suite/s1/runs/r1/cases/c1?target=gpt-4.1",
    {
      type: "test-run",
      suiteId: "s1",
      runId: "r1",
      testCaseId: "c1",
      target: "gpt-4.1",
    },
  ],
  [
    "/evaluate/suite/s1/runs/r1/cases/c1/iter/i1",
    {
      type: "iteration",
      suiteId: "s1",
      runId: "r1",
      testCaseId: "c1",
      iterationId: "i1",
    },
  ],
  [
    "/evaluate/suite/s1/runs/r1/cases/c1/edit",
    { type: "test-run-edit", suiteId: "s1", runId: "r1", testCaseId: "c1" },
  ],
  [
    "/evaluate/suite/s1/runs/r1/cases/c1/edit?step=assertion%3Aa1",
    {
      type: "test-run-edit",
      suiteId: "s1",
      runId: "r1",
      testCaseId: "c1",
      step: "assertion:a1",
    },
  ],
];

function parse(url: string) {
  const [path, search = ""] = url.split("?");
  return parseEvalRouteFromUrl("/evaluate", path, search);
}

describe("Evaluate page-per-layer routes", () => {
  it.each(ROWS)("parses and builds %s", (url, route) => {
    expect(parse(url)).toEqual(route);
    expect(buildEvaluatePath(route)).toBe(url);
  });

  it("parses under a project prefix", () => {
    expect(
      parseEvalRouteFromUrl(
        "/evaluate",
        "/p/jd7abc123def4567/evaluate/suite/s1/runs/r1/cases/c1",
      ),
    ).toEqual(ROWS[7][1]);
  });

  it("encodes and decodes ids with reserved characters", () => {
    const route: EvalNavRoute = {
      type: "iteration",
      suiteId: "s 1",
      runId: "r/1",
      testCaseId: "c?1",
      iterationId: "i#1",
    };
    const url = buildEvaluatePath(route);
    expect(url).toBe("/evaluate/suite/s%201/runs/r%2F1/cases/c%3F1/iter/i%231");
    expect(parse(url)).toEqual(route);
    const target = {
      type: "test-run" as const,
      suiteId: "s1",
      runId: "r1",
      testCaseId: "c1",
      target: "a&b=c",
    };
    expect(parse(buildEvaluatePath(target))).toEqual(target);
  });

  it("keeps today's shapes beside the new ones", () => {
    expect(parse("/evaluate/suite/s1/runs/r1")).toMatchObject({
      type: "run-detail",
      runId: "r1",
    });
    expect(parse("/evaluate/suite/s1/runs/r1/compare")).toMatchObject({
      type: "run-detail",
      comparison: true,
    });
    expect(parse("/evaluate/suite/s1/edit")).toEqual({
      type: "suite-edit",
      suiteId: "s1",
    });
  });

  it.each([
    "/evaluate/suite/s1/settings/other",
    "/evaluate/suite/s1/settings/cases/c1/other",
    "/evaluate/suite/s1/runs/r1/cases",
    "/evaluate/suite/s1/runs/r1/cases/c1/iter",
    "/evaluate/suite/s1/runs/r1/cases/c1/other",
    "/evaluate/runs/extra",
  ])("falls back to the list for the unknown shape %s", (url) => {
    expect(parse(url)).toEqual({ type: "list" });
  });

  it("does not parse page-per-layer routes under /evals", () => {
    expect(parseEvalRouteFromUrl("/evals", "/evals/suite/s1/settings")).toEqual(
      { type: "list" },
    );
    expect(
      parseEvalRouteFromUrl("/evals", "/evals/suite/s1/runs/r1/cases/c1"),
    ).toEqual({ type: "list" });
    expect(
      buildEvalsPath({ type: "suite-settings", suiteId: "s1", tab: "cases" }),
    ).toBe("/evals");
  });

  it("registers every path in the route table", () => {
    const tablePaths = new Set(APP_ROUTES.map((route) => route.path));
    for (const path of EVALUATE_NAV_ROUTE_PATHS)
      expect(tablePaths).toContain(path);
    for (const [url] of ROWS) {
      expect(matchAppRoute(url.split("?")[0])).toMatchObject({
        surfaceId: "evaluate",
        scope: "project",
      });
    }
  });
});
