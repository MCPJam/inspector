import { describe, expect, it, vi } from "vitest";
import type { EvalRoute } from "@/lib/eval-route-types";
import { resolveEvalNavPage } from "../eval-nav-pages";

const trackMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics", () => ({ track: trackMock }));

const RUN = { suiteId: "s1", runId: "r1", testCaseId: "c1" };

describe("resolveEvalNavPage", () => {
  it.each<[EvalRoute, string, EvalRoute]>([
    [{ type: "evaluate-runs" }, "runs", { type: "list" }],
    [
      { type: "suite-settings", suiteId: "s1", tab: "settings" },
      "suite-settings",
      { type: "suite-edit", suiteId: "s1" },
    ],
    [
      { type: "suite-settings", suiteId: "s1", tab: "evaluators" },
      "suite-settings",
      { type: "suite-edit", suiteId: "s1" },
    ],
    [
      { type: "suite-settings", suiteId: "s1", tab: "cases" },
      "suite-settings",
      { type: "suite-overview", suiteId: "s1", view: "test-cases" },
    ],
    [
      { type: "case-new", suiteId: "s1" },
      "case-new",
      { type: "test-edit", suiteId: "s1", testId: "draft:describe" },
    ],
    [
      { type: "case-settings", suiteId: "s1", testCaseId: "c1" },
      "case",
      { type: "test-edit", suiteId: "s1", testId: "c1" },
    ],
    [
      { type: "case-evaluators", suiteId: "s1", testCaseId: "c1" },
      "case-evaluators",
      { type: "test-edit", suiteId: "s1", testId: "c1", checks: true },
    ],
    [
      { type: "test-run", ...RUN, target: "m" },
      "test-run",
      { type: "run-detail", suiteId: "s1", runId: "r1", testCaseId: "c1" },
    ],
    [
      { type: "iteration", ...RUN, iterationId: "i1" },
      "iteration",
      {
        type: "run-detail",
        suiteId: "s1",
        runId: "r1",
        testCaseId: "c1",
        iteration: "i1",
      },
    ],
    [
      { type: "test-run-edit", ...RUN },
      "test-run-edit",
      { type: "test-edit", suiteId: "s1", testId: "c1" },
    ],
  ])("renders today's page for %o", (route, page, pageRoute) => {
    expect(resolveEvalNavPage(route)).toEqual({ route, page, pageRoute });
  });

  it("passes today's routes through unchanged", () => {
    const run: EvalRoute = {
      type: "run-detail",
      suiteId: "s1",
      runId: "r1",
      iteration: "i1",
    };
    expect(resolveEvalNavPage(run)).toEqual({
      route: run,
      pageRoute: run,
      page: "suite-run",
    });
    expect(resolveEvalNavPage({ type: "list" }).page).toBe("suites");
    expect(resolveEvalNavPage({ type: "create" })).toEqual({
      route: { type: "create" },
      pageRoute: { type: "create" },
      page: null,
    });
  });
});

describe("trackEvalNav", () => {
  it("sends the event with Evaluate as its location", async () => {
    const { trackEvalNav } = await import("../eval-nav-events");
    trackEvalNav("eval_nav_page_viewed", {
      page: "test-run",
      arrived_via: "crumb",
    });
    expect(trackMock).toHaveBeenCalledWith("eval_nav_page_viewed", {
      page: "test-run",
      arrived_via: "crumb",
      location: "evaluate",
    });
  });
});
