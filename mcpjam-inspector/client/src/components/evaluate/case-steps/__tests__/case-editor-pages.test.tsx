import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { EVAL_NAV_FOCUS_STEP_STATE_KEY } from "../../nav/evaluate-nav-events";
import type { CaseEditorDraft } from "../case-save-payload";
import { CaseEditorPage } from "../case-editor-page";
import { CaseEvaluatorsPage } from "../case-evaluators-page";

const navigateApp = vi.fn();
const save = vi.fn();
const update = vi.fn();
const run = vi.fn();
const draftState = {
  value: {
    suite: { _id: "suite-1", name: "Excalidraw quickstart" },
    testCase: { _id: "case-1", title: "Sketch a two-node flow" },
    status: "ready",
    draft: {
      title: "Sketch a two-node flow",
      steps: [{ id: "p1", kind: "prompt", prompt: "Sketch it" }],
    } as CaseEditorDraft,
    update,
    isDirty: false,
    isSaving: false,
    save,
  },
};

vi.mock("@/lib/app-navigation", async (original) => ({
  ...(await original<typeof import("@/lib/app-navigation")>()),
  navigateApp: (...args: unknown[]) => navigateApp(...args),
}));
vi.mock("@/lib/app-route-context", () => ({
  useAppRouteContext: () => ({ convexProjectId: "project-1" }),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));
vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: () => false }));
vi.mock("@/hooks/use-actor-can-query", () => ({
  useActorCanQuery: () => true,
}));
vi.mock("@/hooks/useProjects", () => ({
  useProjectServers: () => ({ servers: [] }),
}));
vi.mock("@/hooks/use-suite-capabilities", () => ({
  useSuiteCapabilities: () => ({ state: "loading", capabilities: null }),
}));
vi.mock("../use-case-editor-draft", () => ({
  useCaseEditorDraft: () => draftState.value,
}));
vi.mock("../use-case-tools", () => ({
  useCaseTools: () => ({
    suiteServers: [],
    availableTools: [],
    retryTools: vi.fn(),
  }),
}));
vi.mock("../use-case-run", () => ({
  useCaseRun: () => ({ run, isStarting: false, disabledReason: null }),
}));
vi.mock("../../case-workspace/case-checks-page", () => ({
  CaseChecksPage: ({ title }: { title: string }) => (
    <div data-testid="case-checks-page">{title}</div>
  ),
}));

function crumbs() {
  return screen
    .getByTestId("case-page-header")
    .querySelectorAll("li")
    .values()
    .toArray()
    .map((item) => item.textContent)
    .filter((text) => text !== "/");
}

describe("case editor pages", () => {
  beforeEach(() => {
    navigateApp.mockReset();
    save.mockReset();
    run.mockReset();
    draftState.value.isDirty = false;
  });

  it("opened from a test run, leads its breadcrumb and Back to that test run (D13)", () => {
    render(
      <CaseEditorPage
        route={{
          type: "test-run-edit",
          suiteId: "suite-1",
          runId: "run-6",
          caseId: "case-1",
        }}
      />,
    );
    expect(crumbs()).toEqual([
      "Evaluate",
      "Excalidraw quickstart",
      "Run",
      "Sketch a two-node flow",
      "Edit Test Case",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Back to test run" }));
    expect(navigateApp).toHaveBeenCalledWith(
      expect.stringMatching(
        /\/evaluate\/suite\/suite-1\/runs\/run-6\/cases\/case-1$/,
      ),
      {},
    );
    // No past-runs pane: the editor and its header are the whole page.
    expect(screen.queryByText(/past runs/i)).toBeNull();
    expect(
      screen.getByRole("button", { name: /Test Case Evaluators/ }),
    ).toBeEnabled();
  });

  it("opens scrolled to and expanded at the step a test run's preview named", () => {
    const original = Element.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: "/evaluate/suite/suite-1/runs/run-6/cases/case-1/edit",
            state: { [EVAL_NAV_FOCUS_STEP_STATE_KEY]: 0 },
          },
        ]}
      >
        <CaseEditorPage
          route={{
            type: "test-run-edit",
            suiteId: "suite-1",
            runId: "run-6",
            caseId: "case-1",
          }}
        />
      </MemoryRouter>,
    );
    const step = screen.getByRole("region", { name: /^Step 1:/ });
    expect(scrollIntoView.mock.contexts).toEqual([step]);
    expect(step).not.toHaveAttribute("data-collapsed");
    Element.prototype.scrollIntoView = original;
  });

  it("saves unsaved edits before Run and stays on the page", async () => {
    draftState.value.isDirty = true;
    save.mockResolvedValue("case-1");
    render(
      <CaseEditorPage
        route={{ type: "case-settings", suiteId: "suite-1", caseId: "case-1" }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(run).toHaveBeenCalledWith({ skipJudge: false }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(navigateApp).not.toHaveBeenCalled();
  });

  it("on New case, has no Run and offers Create test case", () => {
    render(<CaseEditorPage route={{ type: "case-new", suiteId: "suite-1" }} />);
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Create test case" }),
    ).toBeInTheDocument();
    expect(crumbs().at(-1)).toBe("New test case");
  });

  it("shows Test Case Evaluators under the case, with Back to the case", () => {
    render(
      <CaseEvaluatorsPage
        route={{
          type: "case-evaluators",
          suiteId: "suite-1",
          caseId: "case-1",
        }}
      />,
    );
    expect(crumbs()).toEqual([
      "Evaluate",
      "Excalidraw quickstart",
      "Suite settings",
      "Sketch a two-node flow",
      "Test Case Evaluators",
    ]);
    expect(screen.getByTestId("case-checks-page")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to test case" }));
    expect(navigateApp).toHaveBeenCalledWith(
      expect.stringMatching(/\/settings\/cases\/case-1$/),
      {},
    );
  });
});
