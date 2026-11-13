import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  EvalIteration,
  EvalSuiteRun,
  EvalSuiteRunListItem,
} from "../../../evals/types";
import type { RunResultPageRoute } from "@/lib/eval-route-types";
import { RunResultsMatrix } from "../../run-results-matrix";
import { RunResultPage } from "../run-result-page";
import { useCaseResultLinks } from "../result-page-links";
import { readRunView, rememberRunView } from "../run-view-memory";

const mocks = vi.hoisted(() => ({
  flag: { value: undefined as boolean | undefined },
  navigateApp: vi.fn(),
  track: vi.fn(),
  chainsFor: vi.fn(),
}));

vi.mock("@/hooks/use-run-result-pages-enabled", () => ({
  useRunResultPagesEnabled: () => mocks.flag.value,
}));
vi.mock("@/lib/analytics", () => ({ track: mocks.track }));
vi.mock("@/lib/app-navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-navigation")>()),
  navigateApp: mocks.navigateApp,
}));
vi.mock("@/hooks/use-eval-run-decision-summary", () => ({
  useEvalRunDecisionDetail: () => ({ status: "ready", diagnostics: [] }),
}));
vi.mock("@/hooks/use-eval-run-iteration-chains", () => ({
  useEvalRunIterationChains: (target: { run?: { _id: string } }) => {
    mocks.chainsFor(target.run?._id);
    return {
      status: "ready",
      chains: new Map([["it2", { status: "verified", stages: [] }]]),
    };
  },
}));
// The report itself is covered by the drawer tests; here it shows what the
// page handed it.
vi.mock("../iteration-report", () => ({
  IterationReport: (props: {
    iteration: { _id: string };
    chain?: unknown;
    traceDetailPlacement?: string;
    onTabChange?: (tab: "raw") => void;
  }) => (
    <div data-testid="iteration-report">
      {props.iteration._id} chain:{props.chain ? "yes" : "no"} trace:
      {props.traceDetailPlacement}
      <button type="button" onClick={() => props.onTabChange?.("raw")}>
        Raw tab
      </button>
    </div>
  ),
}));
vi.mock("convex/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("convex/react")>()),
  useConvex: () => ({ query: async () => null }),
  useQueries: () => ({}),
  useQuery: () => undefined,
}));

function run(id: string, overrides: Partial<EvalSuiteRun> = {}): EvalSuiteRun {
  return {
    _id: id,
    suiteId: "suite",
    runGroupId: "launch",
    namedHostId: "claude",
    effectiveModelId: "sonnet",
    runNumber: 3,
    status: "completed",
    configSnapshot: { tests: [], environment: { servers: [] } },
    ...overrides,
  } as EvalSuiteRun;
}

function iteration(
  id: string,
  runId: string,
  overrides: Partial<EvalIteration> = {},
): EvalIteration {
  return {
    _id: id,
    suiteRunId: runId,
    testCaseId: "refund",
    status: "completed",
    result: "passed",
    resultSource: "reported",
    tokensUsed: 500,
    actualToolCalls: [],
    startedAt: 1000,
    updatedAt: 2000,
    testCaseSnapshot: {
      title: "Refund order",
      model: "sonnet",
      provider: "anthropic",
      query: "Refund the order",
      expectedToolCalls: [],
    },
    ...overrides,
  } as EvalIteration;
}

const routeRun = run("one");
const sibling = run("two", {
  namedHostId: "cursor",
  effectiveModelId: "gpt",
  runNumber: 4,
});
const runs: EvalSuiteRunListItem[] = [routeRun, sibling];
const iterations = [
  iteration("it1", "one"),
  iteration("it2", "two", {
    result: "failed",
    testCaseSnapshot: {
      title: "Refund order",
      model: "gpt",
      provider: "openai",
      query: "Refund the order",
      expectedToolCalls: [],
    },
  }),
  iteration("it3", "one", {
    testCaseId: undefined,
    testCaseSnapshot: {
      title: "Ship label",
      model: "sonnet",
      provider: "anthropic",
      query: "Ship it",
      expectedToolCalls: [],
    },
  }),
];
const names = new Map([
  ["claude", "Claude"],
  ["cursor", "Cursor"],
]);

function renderPage(
  resultPage: RunResultPageRoute,
  overrides: Partial<Parameters<typeof RunResultPage>[0]> = {},
) {
  const onEditCase = vi.fn();
  const onCrumbsChange = vi.fn();
  const view = render(
    <RunResultPage
      suiteId="suite"
      runId="one"
      resultPage={resultPage}
      run={routeRun}
      runs={runs}
      allIterations={iterations}
      hostNamesById={names}
      loading={false}
      projectId="project"
      decisionSummaryEnabled
      onEditCase={onEditCase}
      onCrumbsChange={onCrumbsChange}
      {...overrides}
    />,
  );
  return { ...view, onEditCase, onCrumbsChange };
}

function searchParam(href: string | null, key: string) {
  return new URL(href ?? "", "https://app.test").searchParams.get(key);
}

beforeEach(() => {
  mocks.flag.value = true;
  mocks.navigateApp.mockReset();
  mocks.track.mockReset();
  mocks.chainsFor.mockReset();
});

describe("RunResultPage", () => {
  it("shows a skeleton while the flag loads", () => {
    mocks.flag.value = undefined;
    renderPage({ caseKey: "refund" });
    expect(screen.getByTestId("run-result-page-skeleton")).toBeVisible();
    expect(mocks.navigateApp).not.toHaveBeenCalled();
    expect(mocks.track).not.toHaveBeenCalled();
  });

  it("falls back to the legacy run link when the flag is off", () => {
    mocks.flag.value = false;
    renderPage({ caseKey: "refund", iterationId: "it1" });
    expect(mocks.navigateApp).toHaveBeenCalledWith(
      "/evaluate/suite/suite/runs/one?iteration=it1&case=refund",
      { replace: true },
    );
    expect(mocks.navigateApp).toHaveBeenCalledTimes(1);
  });

  it("moves an old `?iteration=` link to its page without counting a view", () => {
    renderPage({ caseKey: "", iterationId: "it2" }, { fromOldLink: true });
    expect(mocks.navigateApp).toHaveBeenCalledWith(
      "/evaluate/suite/suite/runs/one/cases/refund/iterations/it2",
      { replace: true },
    );
    expect(screen.getByTestId("run-result-page-skeleton")).toBeVisible();
    expect(mocks.track).not.toHaveBeenCalled();
  });

  it("pages through this test case's iterations only, keeping the tab", async () => {
    renderPage(
      { caseKey: "refund", iterationId: "it1", tab: "trace" },
      {
        allIterations: [
          ...iterations,
          iteration("it4", "one", { iterationNumber: 2 }),
        ],
      },
    );
    expect(screen.getByText("1 of 2")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Previous iteration" }),
    ).toBeDisabled();
    const next = screen.getByRole("link", { name: "Next iteration" });
    expect(next).toHaveAttribute(
      "href",
      "/evaluate/suite/suite/runs/one/cases/refund/iterations/it4?tab=trace",
    );
    await userEvent.click(next);
    expect(mocks.navigateApp).toHaveBeenCalledWith(
      "/evaluate/suite/suite/runs/one/cases/refund/iterations/it4?tab=trace",
      { state: { runResultVia: "pager" } },
    );
  });

  it("does not page into another test case", () => {
    renderPage({ caseKey: "refund", iterationId: "it1" });
    expect(screen.getByText("1 of 1")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Next iteration" }),
    ).toBeDisabled();
  });

  it("counts a view reached from the pager as such", () => {
    window.history.replaceState({ runResultVia: "pager" }, "");
    renderPage({ caseKey: "title:Ship label", iterationId: "it3" });
    expect(mocks.track).toHaveBeenCalledWith(
      "eval_iteration_viewed",
      expect.objectContaining({ run_id: "one", via: "pager" }),
    );
    window.history.replaceState(null, "");
  });

  it("writes the open tab into the link in place", async () => {
    renderPage({ caseKey: "refund", iterationId: "it1" });
    await userEvent.click(screen.getByRole("button", { name: "Raw tab" }));
    expect(mocks.navigateApp).toHaveBeenCalledWith(
      "/evaluate/suite/suite/runs/one/cases/refund/iterations/it1?tab=raw",
      expect.objectContaining({ replace: true }),
    );
    expect(mocks.track).toHaveBeenCalledTimes(2);
  });

  it("says a launch run failed to load instead of claiming no result", () => {
    renderPage({ caseKey: "missing" }, { failedRunIds: new Set(["one"]) });
    expect(
      screen.getByRole("heading", {
        name: "Couldn't load the results of Run #3. Reload the page to try again.",
      }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Reload page" })).toBeVisible();
  });

  it("renders a test case page with column links and iteration links", async () => {
    const { onEditCase, onCrumbsChange } = renderPage({ caseKey: "refund" });
    expect(screen.getByRole("heading", { name: "Refund order" })).toBeVisible();
    const sonnet = screen.getByRole("link", { name: "Claude · sonnet" });
    const gpt = screen.getByRole("link", { name: "Cursor · gpt" });
    expect(sonnet).toHaveAttribute("aria-current", "page");
    expect(searchParam(gpt.getAttribute("href"), "target")).toBe("two~gpt");
    expect(
      screen
        .getByRole("link", { name: "Open iteration 1 details" })
        .getAttribute("href"),
    ).toBe("/evaluate/suite/suite/runs/one/cases/refund/iterations/it1");
    await userEvent.click(
      screen.getByRole("button", { name: "Edit test case" }),
    );
    expect(onEditCase).toHaveBeenCalledWith("refund");
    expect(onCrumbsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ crumbs: [{ label: "Refund order" }] }),
    );
    expect(mocks.track).toHaveBeenCalledWith(
      "eval_run_viewed",
      expect.objectContaining({ run_id: "one", surface: "case_page" }),
    );
    expect(mocks.track).toHaveBeenCalledWith(
      "eval_case_result_viewed",
      expect.objectContaining({ run_id: "one", surface: "page" }),
    );
  });

  it("opens the column a target names, and clicks navigate in the app", async () => {
    renderPage({ caseKey: "refund", target: "two~gpt" });
    expect(screen.getByRole("link", { name: "Cursor · gpt" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByText("Failed")).toBeVisible();
    await userEvent.click(
      screen.getByRole("link", { name: "Open iteration 1 details" }),
    );
    expect(mocks.navigateApp).toHaveBeenCalledWith(
      "/evaluate/suite/suite/runs/one/cases/refund/iterations/it2",
      { state: { runResultVia: "grid" } },
    );
  });

  it("resolves a sibling run's iteration under this run, with its decision chain", () => {
    const { onCrumbsChange } = renderPage({
      caseKey: "refund",
      iterationId: "it2",
    });
    expect(screen.getByRole("heading", { name: "Iteration #1" })).toBeVisible();
    expect(screen.getByText(/Cursor · gpt/)).toBeVisible();
    expect(screen.getByTestId("iteration-report")).toHaveTextContent(
      "it2 chain:yes trace:auto",
    );
    expect(mocks.chainsFor).toHaveBeenLastCalledWith("two");
    const crumbs = onCrumbsChange.mock.lastCall?.[0];
    expect(
      crumbs.crumbs.map((crumb: { label: string }) => crumb.label),
    ).toEqual(["Refund order", "Iteration #1"]);
    crumbs.crumbs[0].onClick();
    expect(mocks.navigateApp).toHaveBeenLastCalledWith(
      "/evaluate/suite/suite/runs/one/cases/refund?target=two%7Egpt",
      undefined,
    );
    expect(mocks.track).toHaveBeenCalledWith(
      "eval_iteration_viewed",
      // The view names the page's run so it joins this run visit.
      expect.objectContaining({ run_id: "one", surface: "page", via: "link" }),
    );
  });

  it("opens a row that has no saved test case by its title key", () => {
    renderPage({ caseKey: "title:Ship label" });
    expect(screen.getByRole("heading", { name: "Ship label" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Edit test case" })).toBeNull();
  });

  it.each([
    { caseKey: "missing" },
    { caseKey: "refund", iterationId: "missing" },
    { caseKey: "refund", target: "one~nope" },
  ])("shows not found for %j", async (resultPage) => {
    renderPage(resultPage);
    expect(
      screen.getByRole("heading", {
        name: "Run #3 has no result at this link",
      }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Open Run #3" }));
    expect(mocks.navigateApp).toHaveBeenLastCalledWith(
      "/evaluate/suite/suite/runs/one",
      undefined,
    );
  });

  it("hides Edit test case without edit rights", () => {
    renderPage({ caseKey: "refund" }, { onEditCase: undefined });
    expect(screen.queryByRole("button", { name: "Edit test case" })).toBeNull();
  });
});

describe("run grid cells", () => {
  it("are links to the test case page when given an href", async () => {
    const onOpenCaseResult = vi.fn();
    render(
      <RunResultsMatrix
        run={routeRun}
        iterations={[iteration("it1", "one")]}
        hostNamesById={names}
        caseResultHref={(caseKey) => `/cases/${caseKey}`}
        onOpenCaseResult={onOpenCaseResult}
      />,
    );
    const cell = screen.getByRole("link", {
      name: "Open Refund order on Claude · sonnet",
    });
    expect(cell).toHaveAttribute("href", "/cases/refund");
    await userEvent.click(cell);
    expect(onOpenCaseResult).toHaveBeenCalledWith("refund", null);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("name their column when the launch has more than one", async () => {
    const onOpenCaseResult = vi.fn();
    render(
      <RunResultsMatrix
        run={routeRun}
        runs={runs}
        iterations={iterations}
        hostNamesById={names}
        caseResultHref={() => "/cases"}
        onOpenCaseResult={onOpenCaseResult}
      />,
    );
    await userEvent.click(
      screen.getByRole("link", { name: "Open Refund order on Cursor · gpt" }),
    );
    expect(onOpenCaseResult.mock.lastCall?.[1]?.run._id).toBe("two");
  });

  it("restore the filters remembered for their run", () => {
    rememberRunView("seeded", { search: "ship" });
    render(
      <RunResultsMatrix
        run={routeRun}
        iterations={iterations}
        hostNamesById={names}
        viewMemoryRunId="seeded"
      />,
    );
    expect(
      screen.getByRole("textbox", { name: "Find a test case" }),
    ).toHaveValue("ship");
    expect(screen.queryByText("Refund order")).toBeNull();
  });

  it("open the drawer without an href", async () => {
    render(
      <RunResultsMatrix
        run={routeRun}
        iterations={[iteration("it1", "one")]}
        hostNamesById={names}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", {
        name: "Inspect Refund order on Claude · sonnet",
      }),
    );
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it("forget the grid's state unless the user is coming back to it", () => {
    const runRow = { suiteId: "suite", _id: "memory-run" };
    rememberRunView("memory-run", { search: "refund" });
    renderHook(() => useCaseResultLinks(runRow));
    expect(readRunView("memory-run")).toEqual({});

    rememberRunView("memory-run", { search: "refund" });
    window.history.replaceState({ restoreRunView: true }, "");
    renderHook(() => useCaseResultLinks(runRow));
    expect(readRunView("memory-run")).toEqual({ search: "refund" });
    window.history.replaceState(null, "");
  });

  it("get links only while the flag is on", () => {
    mocks.flag.value = true;
    const on = renderHook(() => useCaseResultLinks(routeRun)).result.current;
    expect(on.caseResultHref?.("refund", null)).toBe(
      "/evaluate/suite/suite/runs/one/cases/refund",
    );
    mocks.flag.value = false;
    expect(
      renderHook(() => useCaseResultLinks(routeRun)).result.current,
    ).toEqual({});
    mocks.flag.value = undefined;
    expect(
      renderHook(() => useCaseResultLinks(routeRun)).result.current,
    ).toEqual({});
  });
});
