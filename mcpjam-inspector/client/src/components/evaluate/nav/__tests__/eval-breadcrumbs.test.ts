import { describe, expect, it, vi } from "vitest";
import type { EvalRoute } from "@/lib/eval-route-types";
import {
  buildEvalBreadcrumbs,
  evalRouteTestCaseId,
  evalsHeaderTrailProps,
} from "../eval-breadcrumbs";

const NAMES = {
  suite: "Excalidraw quickstart",
  runNumber: 4,
  testCase: "Draw a rectangle",
  iterationNumber: 2,
  server: "Excalidraw",
};

const labels = (route: EvalRoute, names = NAMES) =>
  buildEvalBreadcrumbs(route, names).map((crumb) => crumb.label);

const S = "s1";
const RUN = { suiteId: S, runId: "r1", testCaseId: "c1" };

describe("buildEvalBreadcrumbs", () => {
  it.each<[EvalRoute, string[]]>([
    [{ type: "list" }, ["Evaluate"]],
    [{ type: "evaluate-runs" }, ["Evaluate"]],
    [{ type: "eval-server", serverId: "srv" }, ["Evaluate", "Excalidraw"]],
    [
      { type: "suite-overview", suiteId: S },
      ["Evaluate", "Excalidraw quickstart"],
    ],
    [
      { type: "suite-settings", suiteId: S, tab: "evaluators" },
      ["Evaluate", "Excalidraw quickstart", "Suite settings"],
    ],
    [
      { type: "case-new", suiteId: S },
      ["Evaluate", "Excalidraw quickstart", "Suite settings", "New case"],
    ],
    [
      { type: "case-settings", suiteId: S, testCaseId: "c1" },
      [
        "Evaluate",
        "Excalidraw quickstart",
        "Suite settings",
        "Draw a rectangle",
      ],
    ],
    [
      { type: "case-evaluators", suiteId: S, testCaseId: "c1" },
      [
        "Evaluate",
        "Excalidraw quickstart",
        "Suite settings",
        "Draw a rectangle",
        "Test Case Evaluators",
      ],
    ],
    [
      { type: "run-detail", suiteId: S, runId: "r1" },
      ["Evaluate", "Excalidraw quickstart", "Run #4"],
    ],
    [
      { type: "test-run", ...RUN },
      ["Evaluate", "Excalidraw quickstart", "Run #4", "Draw a rectangle"],
    ],
    [
      { type: "iteration", ...RUN, iterationId: "i1" },
      [
        "Evaluate",
        "Excalidraw quickstart",
        "Run #4",
        "Draw a rectangle",
        "Iteration #2",
      ],
    ],
    [
      { type: "test-run-edit", ...RUN },
      [
        "Evaluate",
        "Excalidraw quickstart",
        "Run #4",
        "Draw a rectangle",
        "Edit Test Case",
      ],
    ],
  ])("trail for %o", (route, expected) => {
    expect(labels(route)).toEqual(expected);
  });

  it("gives today's routes the trail of the page they become", () => {
    expect(
      labels({ type: "suite-edit", suiteId: S, fromCaseChecks: "c1" }),
    ).toEqual(labels({ type: "suite-settings", suiteId: S, tab: "settings" }));
    expect(
      labels({ type: "test-edit", suiteId: S, testId: "c1", checks: true }),
    ).toEqual(
      labels({ type: "case-evaluators", suiteId: S, testCaseId: "c1" }),
    );
    expect(
      labels({ type: "run-detail", suiteId: S, runId: "r1", testCaseId: "c1" }),
    ).toEqual(labels({ type: "test-run", ...RUN }));
    expect(
      labels({
        type: "test-edit",
        suiteId: S,
        testId: "c1",
        fromEvalServer: "srv",
      }),
    ).toEqual(["Evaluate", "Excalidraw", "Draw a rectangle"]);
  });

  it("labels levels whose names have not loaded", () => {
    expect(
      labels({ type: "iteration", ...RUN, iterationId: "i1" }, {}),
    ).toEqual(["Evaluate", "Suite", "Run", "Test case", "Iteration"]);
    expect(
      labels({ type: "test-edit", suiteId: S, testId: "draft:describe" }, {}),
    ).toEqual(["Evaluate", "Suite", "Suite settings", "New case"]);
  });

  it("links every crumb but the current one to its level", () => {
    const crumbs = buildEvalBreadcrumbs(
      { type: "test-run-edit", ...RUN },
      NAMES,
    );
    expect(crumbs.map((crumb) => crumb.to)).toEqual([
      { type: "list" },
      { type: "suite-overview", suiteId: S },
      { type: "run-detail", suiteId: S, runId: "r1" },
      { type: "test-run", ...RUN },
      undefined,
    ]);
    const settings = buildEvalBreadcrumbs(
      { type: "case-new", suiteId: S },
      NAMES,
    );
    expect(settings[2].to).toEqual({
      type: "suite-settings",
      suiteId: S,
      tab: "cases",
    });
  });
});

describe("evalRouteTestCaseId", () => {
  it("reads the case from every route that names one", () => {
    expect(
      evalRouteTestCaseId({ type: "iteration", ...RUN, iterationId: "i1" }),
    ).toBe("c1");
    expect(
      evalRouteTestCaseId({ type: "test-edit", suiteId: S, testId: "c2" }),
    ).toBe("c2");
    expect(
      evalRouteTestCaseId({ type: "run-detail", suiteId: S, runId: "r1" }),
    ).toBeNull();
    expect(
      evalRouteTestCaseId({ type: "suite-overview", suiteId: S }),
    ).toBeNull();
  });
});

describe("evalsHeaderTrailProps", () => {
  it("shows the landing header when there is no trail", () => {
    expect(
      evalsHeaderTrailProps(buildEvalBreadcrumbs({ type: "list" }), vi.fn()),
    ).toEqual({ isDetail: false });
  });

  it("puts a single level in the current crumb", () => {
    expect(
      evalsHeaderTrailProps(
        buildEvalBreadcrumbs({ type: "suite-overview", suiteId: S }, NAMES),
        vi.fn(),
      ),
    ).toEqual({ isDetail: true, children: "Excalidraw quickstart" });
  });

  it("spreads a deep trail over parent, middle and detail crumbs", () => {
    const navigate = vi.fn();
    const props = evalsHeaderTrailProps(
      buildEvalBreadcrumbs(
        { type: "iteration", ...RUN, iterationId: "i1" },
        NAMES,
      ),
      navigate,
    );
    expect(props.parentCrumb?.label).toBe("Excalidraw quickstart");
    expect(props.children).toBe("Run #4");
    expect(props.detailCrumb?.map((crumb) => crumb.label)).toEqual([
      "Draw a rectangle",
      "Iteration #2",
    ]);
    expect(props.detailCrumb?.[1].onClick).toBeUndefined();

    props.parentCrumb?.onClick();
    props.onCurrentCrumbClick?.();
    props.detailCrumb?.[0].onClick?.();
    expect(navigate.mock.calls.map(([route]) => route.type)).toEqual([
      "suite-overview",
      "run-detail",
      "test-run",
    ]);
  });

  it("leaves the middle crumb unclickable when it is the current page", () => {
    const props = evalsHeaderTrailProps(
      buildEvalBreadcrumbs(
        { type: "run-detail", suiteId: S, runId: "r1" },
        NAMES,
      ),
      vi.fn(),
    );
    expect(props.children).toBe("Run #4");
    expect(props.onCurrentCrumbClick).toBeUndefined();
    expect(props.detailCrumb).toEqual([]);
  });
});
