import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CombinedRunContent } from "../../combined-run-content";
import { SingleRunContent } from "../../evaluate-run-content";
import { EvaluateRunPage } from "../../evaluate-run-page";
import { RunTestRunRows } from "../../run-case-rows";
import { EvalHeaderActionsSlot } from "../../nav/eval-header-actions";
import { buildRunResultsMatrix } from "../../run-results-matrix-model";
import type { EvalIteration, EvalSuiteRun } from "../../../evals/types";
import type { ProjectRunHistoryDetail } from "../../../evals/use-project-run-history";

const mocks = vi.hoisted(() => ({
  history: {
    details: new Map<string, ProjectRunHistoryDetail>(),
    loading: false,
    errorCount: 0,
    retry: () => undefined,
  },
  open: vi.fn(),
  track: vi.fn(),
}));
vi.mock("../../nav/use-evaluate-nav-enabled", () => ({
  useEvaluateNavEnabled: () => true,
}));
vi.mock("../../nav/eval-nav-link", async (original) => ({
  ...(await original<object>()),
  openEvalNavPage: mocks.open,
}));
vi.mock("@/lib/analytics", () => ({ track: mocks.track }));
vi.mock("../../run-error-breakdown", () => ({
  useRunErrorBreakdownToast: () => undefined,
}));
vi.mock("../../unified-findings-section", () => ({
  UnifiedFindingsSection: ({ suiteRunId }: { suiteRunId: string }) => (
    <section data-testid="findings-section" data-run-id={suiteRunId} />
  ),
}));
vi.mock("../../../evals/use-server-quality", () => ({
  useServerQuality: () => ({
    pending: false,
    failedGeneration: false,
    error: null,
    unavailable: false,
    canRequest: false,
    requestServerQuality: () => undefined,
  }),
}));
vi.mock("../../../evals/use-project-run-history", () => ({
  useProjectRunHistory: () => mocks.history,
}));
vi.mock("@/hooks/use-eval-run-decision-summary", () => ({
  useEvalRunDecisionDetail: () => ({
    status: "ready",
    summary: null,
    diagnostics: [],
  }),
}));
vi.mock("@/hooks/use-eval-run-iteration-chains", () => ({
  useEvalRunIterationChains: () => ({ chains: new Map(), status: "ready" }),
}));
vi.mock("../../use-eval-run-compare", () => ({
  useEvalRunCompare: () => ({ dto: null }),
}));

function run(id: string, client: string, model: string): EvalSuiteRun {
  return {
    _id: id,
    suiteId: "suite",
    runGroupId: "launch",
    namedHostId: client,
    effectiveModelId: model,
    runNumber: 4,
    createdAt: Number(id) * 1000,
    status: "completed",
    result: "passed",
    configSnapshot: { tests: [], environment: { servers: [] } },
  } as unknown as EvalSuiteRun;
}
function iteration(
  id: string,
  runId: string,
  testCaseId: string,
  title: string,
  result: string,
): EvalIteration {
  return {
    _id: id,
    suiteRunId: runId,
    testCaseId,
    status: "completed",
    result,
    resultSource: "reported",
    startedAt: 1000,
    updatedAt: 3000,
    actualToolCalls: [],
    testCaseSnapshot: { title, model: "m", query: "q", expectedToolCalls: [] },
  } as unknown as EvalIteration;
}

const runs = [run("1", "mcpjam", "gpt-5-mini"), run("2", "mcpjam", "haiku")];
const iterations = [
  iteration("a", "1", "flow", "Sketch a two-node flow", "failed"),
  iteration("b", "1", "rect", "Draw a rectangle", "passed"),
  iteration("c", "2", "flow", "Sketch a two-node flow", "passed"),
  iteration("d", "2", "rect", "Draw a rectangle", "passed"),
];
const names = new Map([["mcpjam", "MCPJam"]]);

function renderPage({ editable = true } = {}) {
  return render(
    <EvaluateRunPage
      run={runs[0]}
      otherRuns={runs}
      relatedRuns={runs}
      suiteName="Excalidraw quickstart"
      hostNamesById={names}
      defaultCompareRunId={null}
      onCompareWithRun={vi.fn()}
      launchReview={{
        projectId: "project",
        suite: { _id: "suite", name: "Excalidraw quickstart" } as never,
        cases: [],
        hostNamesById: names,
        onStart: vi.fn(),
        ...(editable ? { onEditSettings: vi.fn() } : {}),
      }}
    >
      <CombinedRunContent
        projectId="project"
        run={runs[0]}
        runs={runs}
        siblingRuns={runs}
        iterations={iterations.filter((row) => row.suiteRunId === "1")}
        hostNamesById={names}
        decisionSummaryEnabled
        onEditCase={vi.fn()}
      />
    </EvaluateRunPage>,
  );
}

// The pages put their buttons in the breadcrumb bar's slot.
beforeEach(() => {
  render(<EvalHeaderActionsSlot />);
});

beforeEach(() => {
  mocks.history.details = new Map(
    runs.map((item) => [
      item._id,
      {
        run: item,
        iterations: iterations.filter((row) => row.suiteRunId === item._id),
        metrics: null,
      },
    ]),
  );
  mocks.open.mockClear();
  mocks.track.mockClear();
});

describe("Suite run page with the flag on", () => {
  it("titles the page Suite Run with its suite in a pill and no overflow menu", () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "Suite Run #4" })).toBeVisible();
    expect(screen.getByTestId("suite-run-suite-pill")).toHaveTextContent(
      "Excalidraw quickstart",
    );
    expect(screen.queryByRole("button", { name: "Run actions" })).toBeNull();
    // Findings sit in the same gutter as the header, stats and Test runs.
    expect(screen.getByTestId("combined-run-findings")).toHaveClass("px-5");
    expect(screen.getByRole("button", { name: "Back to suite" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Run again" })).toBeVisible();
    expect(mocks.track).toHaveBeenCalledWith("eval_nav_page_viewed", {
      page: "suite-run",
      arrived_via: "direct",
      location: "evaluate",
    });
  });

  it("opens Suite settings beside Run, and hides it from read-only readers", async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage();
    await user.click(screen.getByRole("button", { name: "Suite settings" }));
    expect(mocks.open).toHaveBeenCalledWith(
      { type: "suite-settings", suiteId: "suite", tab: "settings" },
      "run #4",
    );
    unmount();
    renderPage({ editable: false });
    expect(screen.queryByRole("button", { name: "Suite settings" })).toBeNull();
  });

  it("replaces the case grid with a Test runs list whose rows open pages", async () => {
    const user = userEvent.setup();
    renderPage();
    expect(screen.queryByTestId("run-results-matrix")).toBeNull();
    const list = screen.getByTestId("run-test-runs");
    expect(within(list).getByText("gpt-5-mini")).toBeVisible();
    expect(within(list).getByText("haiku")).toBeVisible();
    const failing = screen.getByTestId("run-test-run-row-flow");
    expect(within(failing).getByText("Fail")).toBeVisible();

    await user.click(
      screen.getByRole("button", {
        name: "Open test run: Sketch a two-node flow",
      }),
    );
    expect(mocks.open).toHaveBeenLastCalledWith(
      { type: "test-run", suiteId: "suite", runId: "1", testCaseId: "flow" },
      "run #4",
    );

    await user.click(
      screen.getByRole("button", { name: "Edit test case: Draw a rectangle" }),
    );
    expect(mocks.open).toHaveBeenLastCalledWith(
      {
        type: "test-run-edit",
        suiteId: "suite",
        runId: "1",
        testCaseId: "rect",
      },
      "run #4",
    );
    expect(mocks.track).toHaveBeenCalledWith("eval_edit_from_test_run", {
      surface: "list",
      location: "evaluate",
    });
  });

  it("filters stats and test runs with one model filter", async () => {
    const user = userEvent.setup();
    renderPage();
    const filter = screen.getByRole("group", { name: "Showing" });
    expect(
      within(filter).getByRole("button", { name: /All models\s*3\/4/ }),
    ).toHaveAttribute("aria-pressed", "true");
    await user.click(
      within(filter).getByRole("button", { name: /MCPJam · haiku\s*2\/2/ }),
    );
    const list = screen.getByTestId("run-test-runs");
    expect(within(list).queryByText("gpt-5-mini")).toBeNull();
    expect(within(list).getByText("haiku")).toBeVisible();
    expect(
      within(filter).getByRole("button", { name: /MCPJam · haiku/ }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});

describe("Single-model Suite run page", () => {
  it("shows the Test runs list and the run it compares against", () => {
    const current = { ...runs[1], runGroupId: undefined } as EvalSuiteRun;
    const previous = {
      ...current,
      _id: "0",
      runNumber: 3,
      createdAt: 0,
    } as EvalSuiteRun;
    render(
      <SingleRunContent
        projectId="project"
        run={current}
        siblingRuns={[current, previous]}
        iterations={iterations.filter((row) => row.suiteRunId === "2")}
        hostNamesById={names}
        decisionSummaryEnabled
      />,
    );
    expect(screen.getByTestId("suite-run-comparison")).toHaveTextContent(
      "vs run #3",
    );
    expect(screen.queryByRole("group", { name: "Showing" })).toBeNull();
    expect(screen.getByTestId("run-test-runs")).toBeVisible();
    // No case editor wired: rows open, but offer no edit.
    expect(screen.queryByRole("button", { name: /Edit test case/ })).toBeNull();
  });
});

describe("RunTestRunRows", () => {
  const data = buildRunResultsMatrix({
    run: runs[0],
    runs,
    iterations,
    hostNamesById: names,
  });

  it("finds test runs by title and by result", async () => {
    const user = userEvent.setup();
    render(<RunTestRunRows data={data} onOpen={vi.fn()} />);
    expect(screen.getAllByRole("row")).toHaveLength(3);
    await user.type(
      screen.getByRole("textbox", { name: "Find a test run" }),
      "rect",
    );
    expect(screen.getAllByRole("row")).toHaveLength(2);
    await user.clear(screen.getByRole("textbox", { name: "Find a test run" }));
    await user.click(
      screen.getByRole("combobox", { name: "Filter by status" }),
    );
    await user.click(screen.getByRole("option", { name: "Failed" }));
    expect(screen.getByTestId("run-test-run-row-flow")).toBeVisible();
    expect(screen.queryByTestId("run-test-run-row-rect")).toBeNull();
  });

  it("opens a test run from anywhere on its row", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<RunTestRunRows data={data} onOpen={onOpen} />);
    await user.click(screen.getByText("Draw a rectangle"));
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ testCaseId: "rect" }),
    );
  });
});
