import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  EvalCase,
  EvalIteration,
  EvalSuite,
  EvalSuiteRun,
} from "../../../evals/types";

const { track, navigate, pages, iterationById } = vi.hoisted(() => ({
  track: vi.fn(),
  navigate: vi.fn(),
  pages: {} as Record<string, unknown>,
  iterationById: {} as Record<string, unknown>,
}));

vi.mock("@/lib/analytics", () => ({ track }));
vi.mock("../../create-suite-navigation", () => ({
  navigatePlaygroundEvalsRoute: navigate,
}));
vi.mock("convex/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("convex/react")>()),
  useQueries: (queries: Record<string, unknown>) =>
    Object.fromEntries(Object.keys(queries).map((key) => [key, pages[key]])),
  useQuery: (_query: unknown, args: { iterationId?: string } | "skip") =>
    args === "skip" ? undefined : iterationById[args.iterationId ?? ""],
  useMutation: () => vi.fn(),
  useAction: () => vi.fn(),
  useConvex: () => ({ query: async () => null }),
}));
vi.mock("@/hooks/use-eval-run-decision-summary", () => ({
  useEvalRunDecisionDetail: () => ({ status: "ready", diagnostics: [] }),
}));
vi.mock("@/hooks/use-eval-run-iteration-chains", () => ({
  useEvalRunIterationChains: () => ({ status: "ready", chains: new Map() }),
}));
vi.mock("../../../evals/use-server-quality", () => ({
  useServerQuality: () => ({
    pending: false,
    failedGeneration: false,
    error: null,
    unavailable: false,
    canRequest: false,
    requestServerQuality: vi.fn(),
  }),
}));
vi.mock("../../unified-findings-section", () => ({
  UnifiedFindingsSection: () => <div data-testid="findings-stub" />,
}));
vi.mock("../../../evals/use-selected-run", () => ({
  useSelectedRun: (_suiteId: string, runId: string | null) => ({
    run: runId ? runA : null,
    isLoading: false,
    isUnavailable: false,
  }),
}));
vi.mock("../iteration-report", () => ({
  IterationOutcomeBadge: () => <span>FAILED</span>,
  IterationReport: () => <div data-testid="iteration-report" />,
}));

import { TestRunPage } from "../test-run-page";
import { IterationPage } from "../iteration-page";
import { EvalHeaderActionsSlot } from "../../nav/eval-header-actions";

function run(id: string, model: string): EvalSuiteRun {
  return {
    _id: id,
    suiteId: "suite",
    runGroupId: "launch",
    namedHostId: "claude",
    effectiveModelId: model,
    runNumber: 4,
    status: "completed",
    configSnapshot: { tests: [], environment: { servers: [] } },
  } as unknown as EvalSuiteRun;
}
const runA = run("run-a", "gpt-5-mini");
const runB = run("run-b", "claude-haiku-4.5");

function iteration(
  id: string,
  runId: string,
  result: "passed" | "failed",
  number: number,
): EvalIteration {
  return {
    _id: id,
    suiteRunId: runId,
    testCaseId: "case",
    iterationNumber: number,
    status: "completed",
    result,
    resultSource: "reported",
    actualToolCalls: [],
    startedAt: 1000,
    updatedAt: 2000,
    testCaseSnapshot: {
      title: "Sketch a two-node flow",
      model: runId === "run-a" ? "gpt-5-mini" : "claude-haiku-4.5",
      provider: "openai",
      query: "Draw it",
      expectedToolCalls: [],
    },
  } as unknown as EvalIteration;
}

const suite = { _id: "suite", name: "Excalidraw quickstart" } as EvalSuite;
const testCase = {
  _id: "case",
  testSuiteId: "suite",
  title: "Sketch a two-node flow",
  steps: [
    { id: "p1", kind: "prompt", prompt: "Draw a two-node flow" },
    {
      id: "a1",
      kind: "assert",
      assertion: {
        type: "toolCalledWith",
        toolName: "read_me",
        args: { args: {} },
      },
    },
  ],
} as unknown as EvalCase;

const route = {
  type: "test-run" as const,
  suiteId: "suite",
  runId: "run-a",
  testCaseId: "case",
};

// The pages put their buttons in the breadcrumb bar's slot.
beforeEach(() => {
  render(<EvalHeaderActionsSlot />);
});

beforeEach(() => {
  track.mockClear();
  navigate.mockClear();
  for (const key of Object.keys(pages)) delete pages[key];
  pages["run-a"] = {
    page: [
      iteration("a1", "run-a", "passed", 1),
      iteration("a2", "run-a", "failed", 2),
    ],
    isDone: true,
    continueCursor: "",
  };
  pages["run-b"] = {
    page: [iteration("b1", "run-b", "passed", 1)],
    isDone: true,
    continueCursor: "",
  };
});

describe("TestRunPage", () => {
  it("shows the verdict and fires a page view", () => {
    render(
      <TestRunPage
        route={route}
        projectId="p"
        suite={suite}
        testCase={testCase}
        run={runA}
        runs={[]}
      />,
    );
    expect(screen.getByText("Test run · Run #4")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Sketch a two-node flow" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/iterations passed/).textContent).toBe(
      "Failed · 1/2 iterations passed",
    );
    expect(screen.queryByTestId("test-run-model-picker")).toBeNull();
    expect(track).toHaveBeenCalledWith(
      "eval_nav_page_viewed",
      expect.objectContaining({ page: "test-run", location: "evaluate" }),
    );
  });

  it("offers a model picker when the run used several models, kept in the address", async () => {
    render(
      <TestRunPage
        route={{ ...route, target: "claude-haiku-4.5" }}
        projectId="p"
        suite={suite}
        testCase={testCase}
        run={runA}
        runs={[runB]}
      />,
    );
    const picker = screen.getByTestId("test-run-model-picker");
    const selected = within(picker).getByRole("radio", { checked: true });
    expect(selected).toHaveTextContent("claude-haiku-4.5");
    expect(screen.getByText(/2\/3 iterations passed/)).toBeInTheDocument();
    await userEvent.click(within(picker).getByText("gpt-5-mini"));
    expect(navigate).toHaveBeenCalledWith(
      { ...route, target: "gpt-5-mini" },
      { replace: true },
    );
  });

  it("opens an iteration as its own page", async () => {
    render(
      <TestRunPage
        route={route}
        projectId="p"
        suite={suite}
        testCase={testCase}
        run={runA}
        runs={[]}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Open iteration 2 details" }),
    );
    expect(navigate).toHaveBeenCalledWith({
      type: "iteration",
      suiteId: "suite",
      runId: "run-a",
      testCaseId: "case",
      iterationId: "a2",
    });
  });

  it("edits the case under the test run", async () => {
    render(
      <TestRunPage
        route={route}
        projectId="p"
        suite={suite}
        testCase={testCase}
        run={runA}
        runs={[]}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Edit Test Case/ }),
    );
    expect(track).toHaveBeenCalledWith(
      "eval_edit_from_test_run",
      expect.objectContaining({ surface: "page" }),
    );
    expect(navigate).toHaveBeenCalledWith({
      type: "test-run-edit",
      suiteId: "suite",
      runId: "run-a",
      testCaseId: "case",
    });
  });

  it("docks the execution preview, and a step opens the editor at it", async () => {
    render(
      <TestRunPage
        route={route}
        projectId="p"
        suite={suite}
        testCase={testCase}
        run={runA}
        runs={[]}
      />,
    );
    expect(screen.queryByTestId("execution-preview")).toBeNull();
    await userEvent.click(screen.getByTestId("test-run-preview-toggle"));
    expect(track).toHaveBeenCalledWith(
      "eval_execution_preview_opened",
      expect.objectContaining({ surface: "test_run" }),
    );
    const steps = screen.getAllByTestId("execution-preview-step");
    expect(steps.map((step) => step.textContent)).toEqual([
      expect.stringContaining("Step 1 · User prompt"),
      expect.stringContaining("Tool was called with “read_me”"),
      expect.stringContaining("Expected outcome"),
      expect.stringContaining("End-of-run evaluation"),
    ]);
    await userEvent.click(steps[1]!);
    expect(track).toHaveBeenCalledWith(
      "eval_edit_from_test_run",
      expect.objectContaining({ surface: "preview_step" }),
    );
    expect(navigate).toHaveBeenCalledWith({
      type: "test-run-edit",
      suiteId: "suite",
      runId: "run-a",
      testCaseId: "case",
      step: "assertion:a1",
    });
  });

  it("has no preview and no edit for a deleted case", () => {
    render(
      <TestRunPage
        route={route}
        projectId="p"
        suite={suite}
        testCase={null}
        run={runA}
        runs={[]}
      />,
    );
    expect(screen.getByTestId("test-run-preview-toggle")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Edit Test Case/ })).toBeNull();
  });
});

describe("IterationPage", () => {
  const iterationRoute = {
    type: "iteration" as const,
    suiteId: "suite",
    runId: "run-a",
    testCaseId: "case",
    iterationId: "a2",
  };

  it("shows the iteration and goes back to its test run", async () => {
    iterationById.a2 = iteration("a2", "run-a", "failed", 2);
    render(
      <IterationPage
        route={iterationRoute}
        projectId="p"
        suiteName="Excalidraw quickstart"
        runs={[]}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "#2 Excalidraw quickstart" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("iteration-report")).toBeInTheDocument();
    expect(track).toHaveBeenCalledWith(
      "eval_nav_page_viewed",
      expect.objectContaining({ page: "iteration" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Back to test run/ }),
    );
    expect(navigate).toHaveBeenCalledWith({
      type: "test-run",
      suiteId: "suite",
      runId: "run-a",
      testCaseId: "case",
    });
  });

  it("says so when the iteration belongs to another case", () => {
    iterationById.a2 = {
      ...iteration("a2", "run-a", "failed", 2),
      testCaseId: "other",
    };
    render(
      <IterationPage
        route={iterationRoute}
        projectId="p"
        suiteName="Excalidraw quickstart"
        runs={[]}
      />,
    );
    expect(screen.getByText(/isn't part of this test run/)).toBeInTheDocument();
  });
});
