import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ANALYTICS_EVENTS } from "@/shared/analytics-events";
import type { EvalRoute } from "@/lib/eval-route-types";
import { track } from "@/lib/analytics";
import {
  EVAL_NAV_EVENTS,
  evalNavPageName,
  trackEvalNav,
  useEvalNavDrawerView,
  useEvalNavPageView,
} from "../eval-nav-analytics";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const trackMock = vi.mocked(track);
const PROJECT = "k57aaaaaaaaaaaaaaaaaaaaaaaaa";

beforeEach(() => trackMock.mockClear());

describe("event registry", () => {
  it.each(Object.values(EVAL_NAV_EVENTS))(
    "registers %s as a client event",
    (name) => {
      expect(ANALYTICS_EVENTS[name]).toEqual({ source: "client" });
    },
  );
});

describe("trackEvalNav", () => {
  it("adds the Evaluate tab location and nothing else", () => {
    trackEvalNav("eval_edit_from_test_run", {
      surface: "page",
      project_id: "p1",
    });
    expect(trackMock).toHaveBeenCalledWith("eval_edit_from_test_run", {
      surface: "page",
      project_id: "p1",
      location: "evaluate_tab",
    });
  });
});

describe("evalNavPageName", () => {
  it.each<[EvalRoute, string | null]>([
    [{ type: "list" }, "suites"],
    [{ type: "evaluate-runs" }, "runs"],
    [{ type: "suite-overview", suiteId: "s" }, "suite"],
    [{ type: "suite-settings", suiteId: "s", tab: "cases" }, "suite_settings"],
    [{ type: "suite-edit", suiteId: "s" }, "suite_settings"],
    [{ type: "case-new", suiteId: "s" }, "new_test_case"],
    [{ type: "case-settings", suiteId: "s", testCaseId: "c" }, "test_case"],
    [
      { type: "case-evaluators", suiteId: "s", testCaseId: "c" },
      "test_case_evaluators",
    ],
    [{ type: "test-edit", suiteId: "s", testId: "c" }, "test_case"],
    [
      { type: "test-edit", suiteId: "s", testId: "c", checks: true },
      "test_case_evaluators",
    ],
    [
      { type: "test-edit", suiteId: "s", testId: "draft:describe" },
      "new_test_case",
    ],
    [{ type: "test-detail", suiteId: "s", testId: "c" }, "test_case"],
    [{ type: "run-detail", suiteId: "s", runId: "r" }, "suite_run"],
    [
      { type: "run-detail", suiteId: "s", runId: "r", testCaseId: "c" },
      "test_run",
    ],
    [
      {
        type: "run-detail",
        suiteId: "s",
        runId: "r",
        testCaseId: "c",
        iteration: "i",
      },
      "iteration",
    ],
    [
      { type: "test-run", suiteId: "s", runId: "r", testCaseId: "c" },
      "test_run",
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
      "test_run_edit",
    ],
    [{ type: "create" }, null],
    [{ type: "eval-server", serverId: "x" }, null],
    [{ type: "commit-detail", commitSha: "abc" }, null],
  ])("names %o", (route, page) => {
    expect(evalNavPageName(route)).toBe(page);
  });
});

describe("useEvalNavPageView", () => {
  const suite: EvalRoute = { type: "suite-overview", suiteId: "s" };
  const settings: EvalRoute = {
    type: "suite-settings",
    suiteId: "s",
    tab: "evaluators",
  };

  function renderView(state?: unknown) {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        MemoryRouter,
        { initialEntries: [{ pathname: `/p/${PROJECT}/evaluate`, state }] },
        children,
      );
    return renderHook(
      ({ route, enabled }: { route: EvalRoute; enabled: boolean }) =>
        useEvalNavPageView(route, {
          projectId: PROJECT,
          ui: "legacy",
          enabled,
        }),
      { wrapper, initialProps: { route: suite, enabled: true } },
    );
  }

  it("fires once per path and again on a new one", () => {
    const { rerender } = renderView();
    rerender({ route: { ...suite }, enabled: true });
    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenLastCalledWith("eval_nav_page_viewed", {
      page: "suite",
      tab: null,
      arrived_via: "direct",
      ui: "legacy",
      project_id: PROJECT,
      location: "evaluate_tab",
    });
    rerender({ route: settings, enabled: true });
    expect(trackMock).toHaveBeenCalledTimes(2);
    expect(trackMock).toHaveBeenLastCalledWith(
      "eval_nav_page_viewed",
      expect.objectContaining({ page: "suite_settings", tab: "evaluators" }),
    );
  });

  it("waits while disabled", () => {
    const { rerender } = renderView();
    trackMock.mockClear();
    rerender({ route: settings, enabled: false });
    expect(trackMock).not.toHaveBeenCalled();
    rerender({ route: settings, enabled: true });
    expect(trackMock).toHaveBeenCalledTimes(1);
  });

  it("reads arrived_via from router state", () => {
    renderView({ evalNav: { via: "crumb" } });
    expect(trackMock).toHaveBeenCalledWith(
      "eval_nav_page_viewed",
      expect.objectContaining({ arrived_via: "crumb" }),
    );
  });

  it("skips routes that are not a nav page", () => {
    const { rerender } = renderView();
    trackMock.mockClear();
    rerender({ route: { type: "create" }, enabled: true });
    expect(trackMock).not.toHaveBeenCalled();
  });
});

describe("useEvalNavDrawerView", () => {
  it("records a legacy drawer view with the current project", () => {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        MemoryRouter,
        { initialEntries: [`/p/${PROJECT}/evaluate/suite/s/runs/r`] },
        children,
      );
    const { result } = renderHook(() => useEvalNavDrawerView(), { wrapper });
    result.current("iteration");
    expect(trackMock).toHaveBeenCalledWith("eval_nav_page_viewed", {
      page: "iteration",
      tab: null,
      arrived_via: "link",
      ui: "legacy",
      project_id: PROJECT,
      location: "evaluate_tab",
    });
  });
});
