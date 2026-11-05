import { describe, expect, it } from "vitest";
import type { EvalNavRoute, EvalRoute } from "@/lib/eval-route-types";
import { legacyEvalRouteFor } from "@/lib/eval-nav-routes";
import {
  EVAL_NAV_PAGES,
  resolveEvalNavPage,
  type EvalNavPages,
} from "../eval-nav-pages";

function StubPage() {
  return null;
}

/** The map with a stub page on the kinds these tests open. */
const withPages = (Page: typeof StubPage): EvalNavPages => ({
  ...EVAL_NAV_PAGES,
  "test-run": { ...EVAL_NAV_PAGES["test-run"], Page },
  "suite-overview": { ...EVAL_NAV_PAGES["suite-overview"], Page },
  "run-detail": { ...EVAL_NAV_PAGES["run-detail"], Page },
});

describe("EVAL_NAV_PAGES", () => {
  it("has one entry per page kind, none with a page yet", () => {
    expect(EVAL_NAV_PAGES).toEqual({
      list: { analyticsPage: "suites", Page: null },
      "evaluate-runs": { analyticsPage: "runs", Page: null },
      "suite-overview": { analyticsPage: "suite", Page: null },
      "suite-settings": { analyticsPage: "suite_settings", Page: null },
      "case-new": { analyticsPage: "new_test_case", Page: null },
      "case-settings": { analyticsPage: "test_case", Page: null },
      "case-evaluators": { analyticsPage: "test_case_evaluators", Page: null },
      "run-detail": { analyticsPage: "suite_run", Page: null },
      "test-run": { analyticsPage: "test_run", Page: null },
      iteration: { analyticsPage: "iteration", Page: null },
      "test-run-edit": { analyticsPage: "test_run_edit", Page: null },
    });
  });
});

describe("resolveEvalNavPage", () => {
  const newKind: EvalNavRoute = {
    type: "test-run",
    suiteId: "s",
    runId: "r",
    testCaseId: "c",
  };
  const legacyKind: EvalRoute = { type: "suite-overview", suiteId: "s" };

  it.each([true, false, undefined])(
    "renders today's page with no Page (flag %s)",
    (flag) => {
      expect(resolveEvalNavPage(newKind, flag)).toEqual({
        kind: "legacy",
        route: legacyEvalRouteFor(newKind),
      });
      expect(resolveEvalNavPage(legacyKind, flag)).toEqual({
        kind: "legacy",
        route: legacyKind,
      });
    },
  );

  it.each([newKind, legacyKind])(
    "follows the flag once a page exists (%o)",
    (route) => {
      const pages = withPages(StubPage);
      expect(resolveEvalNavPage(route, true, pages)).toEqual({
        kind: "page",
        Page: StubPage,
        route,
      });
      expect(resolveEvalNavPage(route, undefined, pages)).toEqual({
        kind: "pending",
      });
      expect(resolveEvalNavPage(route, false, pages)).toEqual({
        kind: "legacy",
        route: route === newKind ? legacyEvalRouteFor(newKind) : route,
      });
    },
  );

  it("keeps the comparison run on today's page", () => {
    const route: EvalRoute = {
      type: "run-detail",
      suiteId: "s",
      runId: "r",
      comparison: true,
    };
    expect(resolveEvalNavPage(route, true, withPages(StubPage))).toEqual({
      kind: "legacy",
      route,
    });
  });

  it("leaves kinds without an entry on today's page", () => {
    const route: EvalRoute = { type: "create" };
    expect(resolveEvalNavPage(route, true, withPages(StubPage))).toEqual({
      kind: "legacy",
      route,
    });
  });
});
