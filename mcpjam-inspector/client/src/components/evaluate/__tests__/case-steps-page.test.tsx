import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent, waitFor } from "@/test";
import type { EvalCase, EvalSuite } from "@/components/evals/types";
import type { TestStep } from "@/shared/steps";
import {
  CaseStepsPage,
  opensInStepsEditor,
} from "../case-steps/case-steps-page";
import type { SuiteRunReviewProps } from "../suite-run-review";

const state = vi.hoisted(() => ({
  suite: undefined as unknown,
  cases: undefined as unknown,
  update: vi.fn(),
  ciOwned: false,
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock("convex/react", () => ({
  useQuery: (name: string) =>
    name === "testSuites:getTestSuite" ? state.suite : state.cases,
  useMutation: (name: string) =>
    name === "testSuites:updateTestCase" ? state.update : vi.fn(),
}));
vi.mock("@/hooks/use-actor-can-query", () => ({
  useActorCanQuery: () => true,
}));
vi.mock("@/hooks/use-suite-capabilities", () => ({
  useSuiteCapabilities: () => ({
    capabilities: { ownership: { ciOwned: state.ciOwned } },
  }),
}));
vi.mock("../case-steps/use-case-tools", () => ({ useCaseTools: () => [] }));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: () => false }));
// The run setup sheet has its own tests; here it only hands back a launch.
vi.mock("../suite-run-review", () => ({
  SuiteRunReview: ({
    onStart,
    suite,
    caseTitle,
    saveBeforeRun,
  }: SuiteRunReviewProps) => (
    <div role="dialog" aria-label={`Run ${caseTitle}`}>
      <button onClick={() => onStart(suite, { iterationOverride: 2 })}>
        Start
      </button>
      {saveBeforeRun ? (
        <button onClick={() => void saveBeforeRun()}>Save first</button>
      ) : null}
    </div>
  ),
}));

const steps: TestStep[] = [
  { id: "p1", kind: "prompt", prompt: "List my workspaces" },
];
const suite = {
  _id: "suite-1",
  name: "Asana basics",
  defaultPredicates: [],
  environment: { servers: ["asana"] },
} as unknown as EvalSuite;
const storedCase: EvalCase = {
  _id: "case-1",
  testSuiteId: "suite-1",
  createdBy: "u1",
  title: "List workspaces",
  query: "List my workspaces",
  models: [{ model: "gpt-5-nano", provider: "openai" }],
  runs: 2,
  expectedToolCalls: [],
  steps,
};

function renderPage(over: Partial<Parameters<typeof CaseStepsPage>[0]> = {}) {
  const props = {
    suiteId: "suite-1",
    testCaseId: "case-1",
    projectId: "project-1",
    readOnly: false,
    launchReview: { suite, hostNamesById: new Map() },
    onRunCase: vi.fn(),
    onDeleteTestCasesBatch: vi.fn().mockResolvedValue(undefined),
    navigation: {
      toSuiteOverview: vi.fn(),
      toTestEdit: vi.fn(),
      toSuiteEdit: vi.fn(),
    },
    ...over,
  };
  renderWithProviders(<CaseStepsPage {...props} />);
  return props;
}

beforeEach(() => {
  state.suite = suite;
  state.cases = [storedCase];
  state.update = vi.fn().mockResolvedValue(null);
  state.ciOwned = false;
  toast.error.mockClear();
  toast.success.mockClear();
});

describe("CaseStepsPage", () => {
  it("shows the title row and the steps at full width, with no results pane", async () => {
    renderPage();
    await screen.findByTestId("case-steps-editor");
    expect(
      screen.getByRole("heading", { name: "List workspaces" }),
    ).toBeInTheDocument();
    for (const name of ["Delete test case", "Test Case Evaluators", "Run"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(
      screen.getByRole("button", {
        name: "List workspaces",
        description: "Rename test case",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByText(/past results/i)).toBeNull();
  });

  it("offers Save after an edit and saves the case", async () => {
    renderPage();
    const prompt = await screen.findByRole("textbox", {
      name: "What does the user ask?",
    });
    const user = userEvent.setup();
    await user.type(prompt, " now");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({ testCaseId: "case-1" }),
    );
    expect(state.update.mock.lastCall![0].steps[0].prompt).toBe(
      "List my workspaces now",
    );
  });

  it("saves pending edits before opening Test Case Evaluators", async () => {
    const props = renderPage();
    const prompt = await screen.findByRole("textbox", {
      name: "What does the user ask?",
    });
    const user = userEvent.setup();
    await user.type(prompt, "!");
    await user.click(
      screen.getByRole("button", { name: "Test Case Evaluators" }),
    );
    await waitFor(() =>
      expect(props.navigation.toTestEdit).toHaveBeenCalledWith(
        "suite-1",
        "case-1",
        { checks: true },
      ),
    );
    expect(state.update).toHaveBeenCalledOnce();
  });

  it("opens Test Case Evaluators straight away with nothing to save", async () => {
    const props = renderPage();
    await screen.findByTestId("case-steps-editor");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Test Case Evaluators" }));
    expect(props.navigation.toTestEdit).toHaveBeenCalledWith(
      "suite-1",
      "case-1",
      { checks: true },
    );
    expect(state.update).not.toHaveBeenCalled();
  });

  it("stays on the case when the save before Evaluators fails", async () => {
    state.update = vi.fn().mockRejectedValue(new Error("network"));
    const props = renderPage();
    const user = userEvent.setup();
    await user.type(
      await screen.findByRole("textbox", { name: "What does the user ask?" }),
      "!",
    );
    await user.click(
      screen.getByRole("button", { name: "Test Case Evaluators" }),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(props.navigation.toTestEdit).not.toHaveBeenCalled();
  });

  it("saves unsaved edits before a run, and skips the judge when the case does", async () => {
    state.cases = [
      {
        ...storedCase,
        judgeConfigOverride: { goalCompletion: { enabled: false } },
      },
    ];
    const props = renderPage();
    const user = userEvent.setup();
    await user.type(
      await screen.findByRole("textbox", { name: "What does the user ask?" }),
      "!",
    );
    await user.click(screen.getByRole("button", { name: "Run" }));
    await user.click(screen.getByRole("button", { name: "Save first" }));
    await waitFor(() => expect(state.update).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(props.onRunCase).toHaveBeenCalledWith(
      "case-1",
      expect.objectContaining({ skipJudge: true }),
    );
  });

  it.each([
    ["out of credits", { runOutOfCreditsReason: () => "Out of credits." }],
    ["a step to fix", {}],
  ])("disables Run with %s", async (_, over) => {
    if (!("runOutOfCreditsReason" in over))
      state.cases = [
        { ...storedCase, steps: [{ id: "p1", kind: "prompt", prompt: "" }] },
      ];
    renderPage(over);
    await screen.findByTestId("case-steps-editor");
    expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
  });

  it("runs only this case through the run setup", async () => {
    const props = renderPage();
    await screen.findByTestId("case-steps-editor");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Run" }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(props.onRunCase).toHaveBeenCalledWith("case-1", {
      iterationOverride: 2,
      suiteOverride: suite,
      skipJudge: false,
    });
  });

  it("deletes after confirming", async () => {
    const props = renderPage();
    await screen.findByTestId("case-steps-editor");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete test case" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(props.onDeleteTestCasesBatch).toHaveBeenCalledWith(["case-1"]);
    expect(toast.success).toHaveBeenCalledWith("Test case deleted");
    expect(props.navigation.toSuiteOverview).toHaveBeenCalledWith(
      "suite-1",
      "test-cases",
    );
  });

  it("keeps the dialog open and stays on the case when the delete fails", async () => {
    const props = renderPage({
      onDeleteTestCasesBatch: vi.fn().mockRejectedValue(new Error("nope")),
    });
    await screen.findByTestId("case-steps-editor");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete test case" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(toast.error).toHaveBeenCalledWith(
      "Could not delete the test case. Try again.",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(props.navigation.toSuiteOverview).not.toHaveBeenCalled();
  });

  it.each([
    ["the suite view locks the case", { readOnly: true }],
    ["the suite is CI-owned", {}],
  ])(
    "is locked where %s: no rename, Delete, Evaluators or save before Run",
    async (_, over) => {
      state.ciOwned = !("readOnly" in over);
      renderPage(over);
      await screen.findByTestId("case-steps-editor");
      for (const name of ["Delete test case", "Test Case Evaluators"])
        expect(screen.queryByRole("button", { name })).toBeNull();
      expect(
        screen.queryByRole("button", { name: "List workspaces" }),
      ).toBeNull();
      expect(
        screen.getByRole("textbox", { name: "What does the user ask?" }),
      ).toHaveAttribute("readonly");
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Run" }));
      expect(screen.queryByRole("button", { name: "Save first" })).toBeNull();
    },
  );

  it("hides Run where the viewer cannot launch runs", async () => {
    renderPage({ onRunCase: undefined });
    await screen.findByTestId("case-steps-editor");
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
  });

  it("says a deleted case is gone and links back to the list", async () => {
    state.cases = [];
    const props = renderPage();
    expect(
      screen.getByText("This test case no longer exists."),
    ).toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Open test cases" }));
    expect(props.navigation.toSuiteOverview).toHaveBeenCalledWith(
      "suite-1",
      "test-cases",
    );
  });

  it("says when the suite itself is gone", () => {
    state.suite = null;
    renderPage();
    expect(
      screen.getByText("This suite no longer exists."),
    ).toBeInTheDocument();
  });
});

describe("opensInStepsEditor", () => {
  it.each([
    [{ type: "test-edit", testId: "case-1" }, true],
    [{ type: "test-edit", testId: "case-1", checks: true }, false],
    [{ type: "test-edit", testId: "case-1", openCompare: true }, false],
    [{ type: "test-edit", testId: "case-1", iteration: "it-1" }, false],
    [{ type: "test-edit", testId: "draft:prompt" }, false],
    [{ type: "test-detail", testId: "case-1" }, false],
  ])("%j opens in the steps editor: %s", (route, opens) => {
    expect(opensInStepsEditor(route)).toBe(opens);
  });
});
