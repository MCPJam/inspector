import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { getFunctionName } from "convex/server";
import type { EvalIteration, EvalSuiteRun } from "../../../evals/types";
import { IterationPage } from "../iteration-page";
import { TestRunPage } from "../test-run-page";

const track = vi.hoisted(() => vi.fn());
const fixtures = vi.hoisted(() => ({
  run: null as unknown,
  iterations: [] as unknown[],
  cases: [] as unknown[],
}));

vi.mock("@/lib/analytics", () => ({ track }));
vi.mock("convex/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("convex/react")>()),
  useQueries: () => ({ selectedRun: fixtures.run }),
  useQuery: (query: Parameters<typeof getFunctionName>[0], args: unknown) => {
    if (args === "skip") return undefined;
    const name = getFunctionName(query);
    if (name === "testSuites:getTestSuite")
      return { _id: "s_1", name: "Excalidraw quickstart" };
    if (name === "testSuites:listTestCases") return fixtures.cases;
    return undefined;
  },
  usePaginatedQuery: (query: Parameters<typeof getFunctionName>[0]) => {
    expect(getFunctionName(query)).toBe(
      "testRunIterations:listTestRunIterations",
    );
    return {
      results: fixtures.iterations,
      status: "Exhausted",
      loadMore: vi.fn(),
    };
  },
}));
vi.mock("@/hooks/use-eval-run-decision-summary", () => ({
  useEvalRunDecisionDetail: () => ({ diagnostics: [] }),
}));
vi.mock("../../case-scorecard/iteration-report-subscriber", () => ({
  IterationReportScorecard: () => <p>scorecard</p>,
}));
vi.mock("../../../evals/iteration-details", () => ({
  IterationDetails: ({ iteration }: { iteration: EvalIteration }) => (
    <p>details {iteration._id}</p>
  ),
}));

function iteration(id: string, model: string, result = "passed") {
  return {
    _id: id,
    suiteRunId: "r_1",
    testCaseId: "c_1",
    iterationNumber: Number(id.slice(-1)),
    status: "completed",
    result,
    resultSource: "reported",
    startedAt: 1,
    updatedAt: 2,
    testCaseSnapshot: {
      title: "Sketch a two-node flow",
      model,
      provider: "openai",
      query: "Sketch",
      expectedToolCalls: [],
    },
  } as EvalIteration;
}

let location: { pathname: string; search: string; state: unknown } | null =
  null;
function LocationProbe() {
  location = useLocation();
  return null;
}

function renderPage(node: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={["/evaluate/suite/s_1/runs/r_1/cases/c_1"]}>
      {node}
      <LocationProbe />
    </MemoryRouter>,
  );
}

const testRunRoute = {
  type: "test-run",
  suiteId: "s_1",
  runId: "r_1",
  caseId: "c_1",
} as const;

describe("Test run and Iteration pages", () => {
  fixtures.run = {
    _id: "r_1",
    suiteId: "s_1",
    runNumber: 4,
    status: "completed",
    configSnapshot: { tests: [], environment: { servers: [] } },
  } as unknown as EvalSuiteRun;
  afterEach(() => {
    track.mockClear();
    location = null;
  });

  it("shows the verdict, crumbs and one model's iterations", () => {
    fixtures.iterations = [
      iteration("i_1", "gpt-5-mini", "failed"),
      iteration("i_2", "gpt-5-mini"),
      iteration("i_3", "claude-haiku-4.5"),
    ];
    renderPage(<TestRunPage route={testRunRoute} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Sketch a two-node flow",
    );
    expect(screen.getAllByText("Failed").length).toBeGreaterThan(0);
    expect(screen.getByText("· 2/3 iterations passed")).toBeTruthy();
    expect(screen.getByText("Excalidraw quickstart")).toBeTruthy();
    expect(screen.getByText("Run #4")).toBeTruthy();
    expect(screen.getByLabelText("Model")).toBeTruthy();
    expect(screen.getByText("scorecard")).toBeTruthy();
  });

  it("keeps the picked model in the address", async () => {
    renderPage(<TestRunPage route={testRunRoute} />);
    await userEvent.click(screen.getByRole("radio", { name: /claude-haiku/ }));
    expect(location?.search).toBe("?target=claude-haiku-4.5");
  });

  it("opens on the model a combined run's link names, and on the first without one", () => {
    // A combined run's Test runs list links to the member run that ran the
    // filtered model, plus `?target=`; a single run links without a target.
    fixtures.iterations = [
      iteration("i_1", "gpt-5-mini", "failed"),
      iteration("i_3", "claude-haiku-4.5"),
    ];
    const picked = () =>
      screen
        .getAllByRole("radio")
        .filter((radio) => radio.getAttribute("aria-checked") === "true")
        .map((radio) => radio.textContent);
    const { unmount } = renderPage(
      <TestRunPage route={{ ...testRunRoute, target: "claude-haiku-4.5" }} />,
    );
    expect(picked()).toEqual(["claude-haiku-4.5 1/1"]);
    unmount();
    renderPage(<TestRunPage route={testRunRoute} />);
    expect(picked()).toEqual(["gpt-5-mini 0/1"]);
  });

  it("opens the editor from the page and from a preview step", async () => {
    fixtures.cases = [
      {
        _id: "c_1",
        testSuiteId: "s_1",
        title: "Sketch a two-node flow",
        steps: [{ id: "p1", kind: "prompt", prompt: "Draw two nodes" }],
      },
    ];
    renderPage(<TestRunPage route={testRunRoute} />);
    await userEvent.click(
      screen.getByRole("button", { name: "Show execution preview" }),
    );
    expect(track).toHaveBeenCalledWith("eval_execution_preview_opened", {
      location: "evaluate_nav",
      surface: "test_run",
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Open step 1 in the test case" }),
    );
    expect(track).toHaveBeenCalledWith("eval_edit_from_test_run", {
      location: "evaluate_nav",
      surface: "preview_step",
    });
    expect(location?.pathname).toBe(
      "/evaluate/suite/s_1/runs/r_1/cases/c_1/edit",
    );
    expect(location?.state).toEqual({
      evalNavArrival: "link",
      evalNavFocusStep: 0,
    });
  });

  it("fires the page surface for Edit Test Case", async () => {
    renderPage(<TestRunPage route={testRunRoute} />);
    await userEvent.click(
      screen.getByRole("button", { name: /Edit Test Case/ }),
    );
    expect(track).toHaveBeenCalledWith("eval_edit_from_test_run", {
      location: "evaluate_nav",
      surface: "page",
    });
  });

  it("shows one iteration and goes back to its test run on its model", async () => {
    renderPage(
      <IterationPage
        route={{ ...testRunRoute, type: "iteration", iterationId: "i_3" }}
      />,
    );
    expect(screen.getByText("details i_3")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Iteration #3",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Back to test run/ }),
    );
    expect(location?.pathname).toBe("/evaluate/suite/s_1/runs/r_1/cases/c_1");
    expect(location?.search).toBe("?target=claude-haiku-4.5");
    expect(location?.state).toEqual({ evalNavArrival: "back" });
  });
});
