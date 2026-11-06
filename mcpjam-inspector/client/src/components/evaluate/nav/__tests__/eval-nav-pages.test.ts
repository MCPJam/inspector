import { describe, expect, it } from "vitest";
import type { EvalNavRoute, EvalRoute } from "@/lib/eval-route-types";
import { legacyEvalRouteFor } from "@/lib/eval-nav-routes";
import { IterationPage } from "../../test-run/iteration-page";
import { TestRunPage } from "../../test-run/test-run-page";
import {
  EVAL_NAV_PAGES,
  resolveEvalNavPage,
  type EvalNavPages,
} from "../eval-nav-pages";
import { SuiteNavPage } from "../../nav-suite/suite-nav-page";
import { SuiteRunNavPage } from "../../nav-run/suite-run-nav-page";
import { SuiteSettingsPage } from "../../suite-settings/suite-settings-page";

function StubPage() {
  return null;
}

/** The map with `Page` on the kinds these tests open. */
const withPages = (Page: typeof StubPage | null): EvalNavPages => ({
  ...EVAL_NAV_PAGES,
  "test-run": { ...EVAL_NAV_PAGES["test-run"], Page },
  "suite-overview": { ...EVAL_NAV_PAGES["suite-overview"], Page },
  "run-detail": { ...EVAL_NAV_PAGES["run-detail"], Page },
});

describe("EVAL_NAV_PAGES", () => {
  it("has one entry per page kind", () => {
    expect(EVAL_NAV_PAGES).toEqual({
      list: { analyticsPage: "suites", Page: expect.any(Function) },
      "evaluate-runs": { analyticsPage: "runs", Page: expect.any(Function) },
      "suite-overview": { analyticsPage: "suite", Page: SuiteNavPage },
      "suite-settings": {
        analyticsPage: "suite_settings",
        Page: SuiteSettingsPage,
      },
      "case-new": { analyticsPage: "new_test_case", Page: null },
      "case-settings": { analyticsPage: "test_case", Page: null },
      "case-evaluators": { analyticsPage: "test_case_evaluators", Page: null },
      "run-detail": { analyticsPage: "suite_run", Page: SuiteRunNavPage },
      "test-run": { analyticsPage: "test_run", Page: TestRunPage },
      iteration: { analyticsPage: "iteration", Page: IterationPage },
      "test-run-edit": { analyticsPage: "test_run_edit", Page: null },
    });
  });
});

describe("the Test run and Iteration pages", () => {
  const testRun: EvalNavRoute = { type: "test-run", suiteId: "s", runId: "r", testCaseId: "c" };
  const iteration: EvalNavRoute = { ...testRun, type: "iteration", iterationId: "i" };
  it.each([
    [testRun, TestRunPage],
    [iteration, IterationPage],
  ])("resolve to their page with the flag on, today's page off, pending unknown (%o)", (route, Page) => {
    expect(resolveEvalNavPage(route, true)).toEqual({ kind: "page", Page, route });
    expect(resolveEvalNavPage(route, false)).toEqual({ kind: "legacy", route: legacyEvalRouteFor(route) });
    expect(resolveEvalNavPage(route, undefined)).toEqual({ kind: "pending" });
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
      const pages = withPages(null);
      expect(resolveEvalNavPage(newKind, flag, pages)).toEqual({
        kind: "legacy",
        route: legacyEvalRouteFor(newKind),
      });
      expect(resolveEvalNavPage(legacyKind, flag, pages)).toEqual({
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

  const run = { type: "run-detail", suiteId: "s", runId: "r" } as const;
  const suite = { type: "suite-overview", suiteId: "s" } as const;

  it.each<[string, EvalRoute]>([
    ["comparison", { ...run, comparison: true }],
    ["compareToRunId", { ...run, compareToRunId: "base" }],
    ["testCaseId", { ...run, testCaseId: "c" }],
    ["iteration", { ...run, iteration: "i" }],
    ["view test-cases", { ...suite, view: "test-cases" }],
    ["view executions", { ...suite, view: "executions" }],
    ["view cross-host", { ...suite, view: "cross-host" }],
  ])("keeps %s on today's page for every flag value", (_, route) => {
    for (const flag of [true, false, undefined]) {
      expect(resolveEvalNavPage(route, flag, withPages(StubPage))).toEqual({
        kind: "legacy",
        route,
      });
    }
  });

  it.each<[string, EvalRoute]>([
    ["the run", run],
    ["the run with insightsFocus", { ...run, insightsFocus: true }],
    ["the suite", suite],
    ["the suite's runs view", { ...suite, view: "runs" }],
    ["the suite with fromCommit", { ...suite, fromCommit: "abc" }],
    ["the suite with importJob", { ...suite, importJob: "job" }],
  ])("gives %s the new page", (_, route) => {
    expect(resolveEvalNavPage(route, true, withPages(StubPage))).toEqual({
      kind: "page",
      Page: StubPage,
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

describe("suite-settings page (T-1, T-2)", () => {
  const settings: EvalNavRoute = {
    type: "suite-settings",
    suiteId: "s",
    tab: "settings",
  };
  const cases: EvalNavRoute = { ...settings, tab: "cases", importJob: "j1" };

  it("opens SuiteSettingsPage when the flag is on", () => {
    expect(resolveEvalNavPage(settings, true)).toEqual({
      kind: "page",
      Page: SuiteSettingsPage,
      route: settings,
    });
  });

  it("waits while the flag loads", () => {
    expect(resolveEvalNavPage(settings, undefined)).toEqual({
      kind: "pending",
    });
  });

  it("renders today's pages with the flag off", () => {
    expect(resolveEvalNavPage(settings, false)).toEqual({
      kind: "legacy",
      route: { type: "suite-edit", suiteId: "s" },
    });
    expect(resolveEvalNavPage(cases, false)).toEqual({
      kind: "legacy",
      route: {
        type: "suite-overview",
        suiteId: "s",
        view: "test-cases",
        importJob: "j1",
      },
    });
  });
});
