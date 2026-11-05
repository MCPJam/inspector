import { describe, expect, it } from "vitest";
import { APP_ROUTES } from "../app-routes";
import { buildEvaluatePath, scopeNavigationTarget } from "../app-navigation";
import {
  EVAL_NAV_ROUTE_TYPES,
  buildEvalNavPath,
  isEvalNavRoute,
  legacyEvalRouteFor,
} from "../eval-nav-routes";
import type {
  EvalNavRoute,
  EvalRoute,
  LegacyEvalRoute,
} from "../eval-route-types";

const ids = {
  suiteId: ":suiteId",
  runId: ":runId",
  testCaseId: ":testCaseId",
  iterationId: ":iterationId",
};

const NAV_ROUTES: EvalNavRoute[] = [
  { type: "evaluate-runs" },
  { type: "suite-settings", suiteId: ids.suiteId, tab: "settings" },
  { type: "suite-settings", suiteId: ids.suiteId, tab: "cases" },
  { type: "suite-settings", suiteId: ids.suiteId, tab: "evaluators" },
  { type: "case-new", suiteId: ids.suiteId },
  { type: "case-settings", suiteId: ids.suiteId, testCaseId: ids.testCaseId },
  { type: "case-evaluators", suiteId: ids.suiteId, testCaseId: ids.testCaseId },
  {
    type: "test-run",
    suiteId: ids.suiteId,
    runId: ids.runId,
    testCaseId: ids.testCaseId,
  },
  {
    type: "test-run-edit",
    suiteId: ids.suiteId,
    runId: ids.runId,
    testCaseId: ids.testCaseId,
  },
  {
    type: "iteration",
    suiteId: ids.suiteId,
    runId: ids.runId,
    testCaseId: ids.testCaseId,
    iterationId: ids.iterationId,
  },
];

const LEGACY_ROUTES: LegacyEvalRoute[] = [
  { type: "list" },
  { type: "create" },
  { type: "eval-server", serverId: "srv" },
  { type: "suite-overview", suiteId: "s" },
  { type: "run-detail", suiteId: "s", runId: "r" },
  { type: "test-detail", suiteId: "s", testId: "t" },
  { type: "test-edit", suiteId: "s", testId: "t" },
  { type: "suite-edit", suiteId: "s" },
  { type: "commit-detail", commitSha: "abc" },
];

describe("legacyEvalRouteFor", () => {
  it.each<[EvalNavRoute, EvalRoute]>([
    [{ type: "evaluate-runs" }, { type: "list" }],
    [
      { type: "suite-settings", suiteId: "s", tab: "settings" },
      { type: "suite-edit", suiteId: "s" },
    ],
    [
      { type: "suite-settings", suiteId: "s", tab: "evaluators" },
      { type: "suite-edit", suiteId: "s" },
    ],
    [
      { type: "suite-settings", suiteId: "s", tab: "cases" },
      { type: "suite-overview", suiteId: "s", view: "test-cases" },
    ],
    [
      { type: "case-new", suiteId: "s" },
      { type: "test-edit", suiteId: "s", testId: "draft:describe" },
    ],
    [
      { type: "case-settings", suiteId: "s", testCaseId: "c" },
      { type: "test-edit", suiteId: "s", testId: "c" },
    ],
    [
      { type: "case-evaluators", suiteId: "s", testCaseId: "c" },
      { type: "test-edit", suiteId: "s", testId: "c", checks: true },
    ],
    [
      {
        type: "test-run",
        suiteId: "s",
        runId: "r",
        testCaseId: "c",
        target: "m",
      },
      { type: "run-detail", suiteId: "s", runId: "r", testCaseId: "c" },
    ],
    [
      {
        type: "iteration",
        suiteId: "s",
        runId: "r",
        testCaseId: "c",
        iterationId: "i",
      },
      {
        type: "run-detail",
        suiteId: "s",
        runId: "r",
        testCaseId: "c",
        iteration: "i",
      },
    ],
    [
      { type: "test-run-edit", suiteId: "s", runId: "r", testCaseId: "c" },
      { type: "test-edit", suiteId: "s", testId: "c" },
    ],
  ])("maps %o to today's page", (route, expected) => {
    expect(legacyEvalRouteFor(route)).toEqual(expected);
  });
});

describe("isEvalNavRoute", () => {
  it("is true for every per-layer kind", () => {
    expect(new Set(NAV_ROUTES.map((route) => route.type))).toEqual(
      new Set(EVAL_NAV_ROUTE_TYPES),
    );
    for (const route of NAV_ROUTES) expect(isEvalNavRoute(route)).toBe(true);
  });

  it.each(LEGACY_ROUTES)("is false for $type", (route) => {
    expect(isEvalNavRoute(route)).toBe(false);
  });
});

describe("registration", () => {
  const evaluateScreens = new Set(
    APP_ROUTES.filter(
      (entry) => entry.kind === "screen" && entry.surfaceId === "evaluate",
    ).map((entry) => `/${entry.path}`),
  );

  it.each(NAV_ROUTES)("registers the built path of $type", (route) => {
    const path = buildEvalNavPath(route);
    // Ids are encoded, so the `:param` placeholders come back as `%3Aparam`.
    expect(evaluateScreens.has(decodeURIComponent(path))).toBe(true);
    expect(buildEvaluatePath(route)).toBe(path);
  });

  it.each(NAV_ROUTES)(
    "scopes the built path of $type to the project",
    (route) => {
      const project = "k57aaaaaaaaaaaaaaaaaaaaaaaaa";
      const path = buildEvalNavPath(route);
      expect(scopeNavigationTarget(path, `/p/${project}/evaluate`)).toBe(
        `/p/${project}${path}`,
      );
    },
  );
});
