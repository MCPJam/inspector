/** The steps editor page: numbered steps, Save, Run and the preview. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import type { EvalCase, EvalSuite } from "@/components/evals/types";

const mutations = {
  "testSuites:createTestCase": vi.fn(async () => "case-new-id"),
  "testSuites:updateTestCase": vi.fn(async () => null),
};
vi.mock("convex/react", () => ({
  useMutation: (ref: Parameters<typeof getFunctionName>[0]) =>
    mutations[getFunctionName(ref) as keyof typeof mutations],
}));
const track = vi.fn();
vi.mock("@/lib/analytics", () => ({
  track: (...args: unknown[]) => track(...args),
}));
const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: vi.fn(),
  },
}));
vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: () => false }));
vi.mock("@/hooks/use-suite-capabilities", () => ({
  useSuiteCapabilities: () => ({ state: "unavailable", capabilities: null }),
}));
vi.mock("../use-case-tools", () => ({
  useCaseTools: () => ({ tools: [], status: undefined }),
}));
const navigate = vi.fn();
vi.mock("../../create-suite-navigation", () => ({
  navigatePlaygroundEvalsRoute: (...args: unknown[]) => navigate(...args),
}));

import { CaseStepsPage } from "../case-steps-page";
import { CaseStepsNavPage, caseBackTarget } from "../case-steps-nav-page";

const suite = {
  _id: "suite-1",
  name: "Excalidraw quickstart",
  judgeConfig: undefined,
} as unknown as EvalSuite;

const testCase: EvalCase = {
  _id: "case-1",
  testSuiteId: "suite-1",
  createdBy: "u",
  title: "Sketch a two-node flow",
  query: "",
  models: [{ model: "openai/gpt-5-mini", provider: "openai" }],
  runs: 3,
  expectedToolCalls: [],
  expectedOutput: "Two boxes and an arrow.",
  steps: [
    { id: "p", kind: "prompt", prompt: "Sketch a tiny flow." },
    {
      id: "t1",
      kind: "assert",
      assertion: {
        type: "toolCalledWith",
        toolName: "read_me",
        args: { args: {} },
      },
    },
  ],
};

function renderPage(
  overrides: Partial<Parameters<typeof CaseStepsPage>[0]> = {},
) {
  const props = {
    suite,
    testCase,
    suiteCases: [testCase],
    readOnly: false,
    back: { label: "Back to suite settings", onClick: vi.fn() },
    onCreated: vi.fn(),
    onOpenEvaluators: vi.fn(),
    onOpenSuiteSettings: vi.fn(),
    onRunCase: vi.fn(async () => ({ suiteRunId: "run-9" })),
    onOpenTestRun: vi.fn(),
    ...overrides,
  };
  render(<CaseStepsPage {...props} />);
  return props;
}

beforeEach(() => {
  track.mockClear();
  toastSuccess.mockClear();
  navigate.mockClear();
  mutations["testSuites:createTestCase"].mockClear();
  mutations["testSuites:updateTestCase"].mockClear();
});
afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("CaseStepsPage", () => {
  it("numbers the prompt, the outcome and the after-run step", () => {
    renderPage();
    const numbers = screen
      .getAllByTestId("case-steps-step")
      .map((step) => step.getAttribute("data-step-number"));
    expect(numbers).toEqual(["1", "2", "3"]);
    expect(screen.getByText("Assertions at this point")).toBeInTheDocument();
    expect(screen.getByText("Expected outcome")).toBeInTheDocument();
    expect(screen.getByText("After-run assertions")).toBeInTheDocument();
    expect(screen.getByLabelText("Expected outcome")).toHaveValue(
      "Two boxes and an arrow.",
    );
  });

  it("saves the outcome through updateTestCase and fires the edit event", async () => {
    renderPage();
    expect(screen.queryByText("Save changes")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Expected outcome"), {
      target: { value: "One box." },
    });
    fireEvent.click(screen.getByText("Save changes"));
    await waitFor(() =>
      expect(mutations["testSuites:updateTestCase"]).toHaveBeenCalledWith(
        expect.objectContaining({
          testCaseId: "case-1",
          expectedOutput: "One box.",
        }),
      ),
    );
    expect(track).toHaveBeenCalledWith(
      "eval_test_case_edited",
      expect.objectContaining({ test_case_id: "case-1" }),
    );
  });

  it("creates a new case through createTestCase", async () => {
    const props = renderPage({ testCase: null });
    fireEvent.change(screen.getByLabelText("User prompt, step 1"), {
      target: { value: "Draw a box" },
    });
    fireEvent.click(screen.getByText("Create test case"));
    await waitFor(() =>
      expect(props.onCreated).toHaveBeenCalledWith("case-new-id"),
    );
    expect(mutations["testSuites:createTestCase"]).toHaveBeenCalledWith(
      expect.objectContaining({ suiteId: "suite-1", query: "Draw a box" }),
    );
    expect(track).toHaveBeenCalledWith(
      "eval_test_case_created",
      expect.objectContaining({ test_case_id: "case-new-id" }),
    );
  });

  it("opens the preview, fires its event and lists the case in run order", () => {
    renderPage();
    fireEvent.click(screen.getByLabelText("Execution preview"));
    expect(track).toHaveBeenCalledWith(
      "eval_execution_preview_opened",
      expect.objectContaining({ surface: "editor" }),
    );
    const preview = screen.getByTestId("execution-preview");
    expect(preview).toHaveTextContent("Step 1 · User prompt");
    expect(preview).toHaveTextContent("Tool was called with “read_me”");
    expect(preview).toHaveTextContent("End-of-run evaluation");
  });

  it("opens at the step ?step= names and expands that assertion", () => {
    window.history.replaceState(null, "", "/?step=assertion:t1");
    renderPage();
    expect(screen.getByLabelText("Close assertion")).toBeInTheDocument();
  });

  it("opens at the top when ?step= names nothing it knows", () => {
    window.history.replaceState(null, "", "/?step=bogus");
    renderPage();
    expect(screen.queryByLabelText("Close assertion")).not.toBeInTheDocument();
  });

  it("runs the saved case, stays here and links to the test run", async () => {
    const props = renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(props.onRunCase).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: "case-1",
        expectedOutput: "Two boxes and an arrow.",
      }),
    );
    const options = toastSuccess.mock.calls[0]![1] as {
      action: { label: string; onClick: () => void };
    };
    expect(options.action.label).toBe("Open test run");
    options.action.onClick();
    expect(props.onOpenTestRun).toHaveBeenCalledWith("run-9", "case-1");
  });
});

describe("CaseStepsNavPage", () => {
  it("says where Back leads from each case page", () => {
    const ids = { suiteId: "s", testCaseId: "c" };
    expect(caseBackTarget({ type: "case-settings", ...ids }).to).toEqual({
      type: "suite-settings",
      suiteId: "s",
      tab: "cases",
    });
    expect(caseBackTarget({ type: "case-evaluators", ...ids }).label).toBe(
      "Back to test case",
    );
    expect(
      caseBackTarget({ type: "test-run-edit", runId: "r", ...ids }),
    ).toEqual({
      label: "Back to test run",
      to: { type: "test-run", suiteId: "s", runId: "r", testCaseId: "c" },
    });
  });

  it("fires the page view and waits for a case that has not loaded", () => {
    render(
      <CaseStepsNavPage
        route={{ type: "case-settings", suiteId: "suite-1", testCaseId: "x" }}
        suite={suite}
        cases={[]}
        readOnly={false}
        onRunCase={vi.fn()}
      />,
    );
    expect(screen.getByText("Loading test case…")).toBeInTheDocument();
    expect(track).toHaveBeenCalledWith(
      "eval_nav_page_viewed",
      expect.objectContaining({ page: "case" }),
    );
  });

  it("goes back to the test run from the editor opened there", () => {
    render(
      <CaseStepsNavPage
        route={{
          type: "test-run-edit",
          suiteId: "suite-1",
          runId: "run-4",
          testCaseId: "case-1",
        }}
        suite={suite}
        cases={[testCase]}
        readOnly={false}
        onRunCase={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Back to test run"));
    expect(navigate).toHaveBeenCalledWith({
      type: "test-run",
      suiteId: "suite-1",
      runId: "run-4",
      testCaseId: "case-1",
    });
  });
});
