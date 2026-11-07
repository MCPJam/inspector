import type { ReactNode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import type { EvalCase, EvalSuite } from "@/components/evals/types";
import { buildEvalBack, buildEvalCrumbs } from "../nav/eval-nav-crumbs";
import {
  buildEvalNavPageServices,
  EvalNavPageServicesProvider,
  type EvalNavPageServiceDeps,
} from "../nav/eval-nav-page-services";
import type { EvalNavPageRoute } from "../nav/eval-nav-pages";

const h = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  update: vi.fn(async (_args: Record<string, unknown>) => null),
  create: vi.fn(async (_args: Record<string, unknown>) => "tc-new"),
  track: vi.fn(),
  navigate: vi.fn(),
  crumbBar: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  capabilities: null as null | { ownership?: { ciOwned?: boolean } },
  panel: vi.fn(),
  previewSurface: vi.fn(),
}));

vi.mock("posthog-js/react", () => ({ useFeatureFlagEnabled: () => false }));
vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) =>
    args === "skip" ? undefined : h.queries[name],
  useQueries: () => ({}),
  useMutation: (name: string) =>
    name === "testSuites:createTestCase" ? h.create : h.update,
  useConvex: () => ({}),
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));
vi.mock("@/hooks/use-actor-can-query", () => ({
  useActorCanQuery: () => true,
}));
vi.mock("@/hooks/use-suite-capabilities", () => ({
  useSuiteCapabilities: () => ({
    state: "ready",
    capabilities: h.capabilities,
  }),
}));
vi.mock("@/lib/analytics", () => ({ track: h.track }));
vi.mock("sonner", () => ({ toast: h.toast }));
vi.mock("../case-steps/use-case-tools", () => ({ useCaseTools: () => [] }));
vi.mock("@/components/evals/use-selected-run", () => ({
  useSelectedRun: () => ({ run: { runNumber: 4 }, isLoading: false }),
}));
vi.mock("../evals-header", () => ({
  EvalCrumbBar: (props: { crumbs: unknown; back?: unknown }) => {
    h.crumbBar(props);
    return <div data-testid="crumb-bar" />;
  },
}));
vi.mock("../nav/eval-nav-state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../nav/eval-nav-state")>()),
  useEvalNavigate: () => h.navigate,
}));
vi.mock("../suite-run-review", () => ({
  SuiteRunReview: (props: {
    onStart: (suite: EvalSuite, options: { iterationOverride: number }) => void;
    suite: EvalSuite;
  }) => (
    <button
      type="button"
      onClick={() => props.onStart(props.suite, { iterationOverride: 1 })}
    >
      Start run
    </button>
  ),
}));
vi.mock("../case-steps/execution-preview-panel", async () => {
  const { useState } = await import("react");
  return {
    useExecutionPreviewOpen: (surface?: string) => {
      h.previewSurface(surface);
      return useState(false);
    },
    ExecutionPreviewToggle: (props: {
      open: boolean;
      onToggle: () => void;
    }) => (
      <button
        type="button"
        aria-label="Execution preview"
        aria-pressed={props.open}
        onClick={props.onToggle}
      />
    ),
    ExecutionPreviewPanel: (props: {
      items: { key: string }[];
      onJump: (key: string) => void;
      variant: string;
    }) => {
      h.panel(props);
      return (
        <aside aria-label="Execution preview panel">
          {props.items.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => props.onJump(item.key)}
            >
              {`jump ${item.key}`}
            </button>
          ))}
        </aside>
      );
    },
  };
});
vi.mock("../case-workspace/case-checks-page", () => ({
  CaseChecksPage: (props: {
    title: string;
    onChecksChange: (next: object) => void;
    onConfigureSuite?: () => void;
    configureSuiteLabel?: string;
  }) => (
    <div>
      <p>{`Overrides for ${props.title}.`}</p>
      {props.onConfigureSuite ? (
        <button type="button" onClick={props.onConfigureSuite}>
          {props.configureSuiteLabel ?? "Configure suite assertions"}
        </button>
      ) : null}
      <button
        type="button"
        onClick={() =>
          props.onChecksChange({
            predicates: { mode: "extend", list: [{ type: "noToolErrors" }] },
          })
        }
      >
        Change evaluators
      </button>
    </div>
  ),
}));

const { CaseStepsNavPage } = await import("../case-steps/case-steps-page");
const { CaseEvaluatorsNavPage } =
  await import("../case-steps/case-evaluators-nav-page");

const suite = {
  _id: "s1",
  name: "Excalidraw quickstart",
  defaultPredicates: [{ type: "noToolErrors" }],
  judgeConfig: { goalCompletion: { enabled: true, autoRun: true } },
  environment: { servers: ["excalidraw"] },
} as unknown as EvalSuite;
const sketch = {
  _id: "tc1",
  title: "Sketch a two-node flow",
  runs: 1,
  models: [{ provider: "openai", model: "openai/gpt-5.4-mini" }],
  expectedOutput: "Two boxes.",
  steps: [
    { id: "p1", kind: "prompt", prompt: "Sketch a tiny flow" },
    {
      id: "a2",
      kind: "assert",
      assertion: {
        type: "toolCalledWith",
        toolName: "read_me",
        args: { args: {} },
      },
    },
  ],
} as unknown as EvalCase;

const services = (over: Partial<EvalNavPageServiceDeps> = {}) =>
  buildEvalNavPageServices({
    rerunWithQuota: vi.fn(async () => ({ runIds: ["r9"] })),
    deleteTestCasesBatch: vi.fn(async () => {}),
    handlers: {
      handleCancelRun: vi.fn(async () => {}),
      directDeleteRun: vi.fn(async () => {}),
      handleDuplicateSuite: vi.fn(),
      rerunningSuiteId: null,
      cancellingRunId: null,
      replayingRunId: null,
      runningTestCaseId: null,
    },
    canDeleteRuns: true,
    canDeleteArtifact: () => true,
    evalRunsDisabledReason: null,
    isDirectGuest: false,
    projectServers: [],
    connectedServerNames: new Set(),
    openCreateSuite: vi.fn(),
    evalServer: vi.fn(),
    showQuickstart: false,
    quickstartRunning: false,
    runQuickstart: vi.fn(),
    launchSources: { projectId: "p1", environments: [], hosts: [] },
    ...over,
  });

function renderPage(
  route: EvalNavPageRoute,
  {
    search = "",
    deps = {},
    Page = CaseStepsNavPage,
  }: {
    search?: string;
    deps?: Partial<EvalNavPageServiceDeps>;
    Page?: typeof CaseStepsNavPage;
  } = {},
) {
  const value = services(deps);
  const wrap = (node: ReactNode) => (
    <MemoryRouter initialEntries={[`/x${search}`]}>
      <EvalNavPageServicesProvider value={value}>
        {node}
      </EvalNavPageServicesProvider>
    </MemoryRouter>
  );
  return { value, ...render(wrap(<Page route={route} projectId="p1" />)) };
}

const caseRoute = {
  type: "case-settings",
  suiteId: "s1",
  testCaseId: "tc1",
} as const;
const names = {
  suiteName: "Excalidraw quickstart",
  testCaseTitle: "Sketch a two-node flow",
  runNumber: 4,
};
const pageViews = () =>
  h.track.mock.calls.filter(([event]) => event === "eval_nav_page_viewed");

beforeEach(() => {
  vi.clearAllMocks();
  h.capabilities = null;
  h.queries = {
    "testSuites:getTestSuite": suite,
    "testSuites:listTestCases": [sketch],
  };
});

describe("Test case (case-settings)", () => {
  it("passes the builders' crumbs and Back, and fires one nav page view", () => {
    renderPage(caseRoute);
    expect(h.crumbBar).toHaveBeenLastCalledWith({
      crumbs: buildEvalCrumbs(caseRoute, { ...names, runNumber: 4 }),
      back: buildEvalBack(caseRoute, names, null),
    });
    expect(pageViews()).toHaveLength(1);
    expect(pageViews()[0]![1]).toMatchObject({ page: "test_case", ui: "nav" });
  });

  it("shows Delete, Test Case Evaluators and Run; Save only once dirty", () => {
    renderPage(caseRoute);
    expect(screen.getByLabelText("Delete test case")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Test Case Evaluators" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.change(screen.getByLabelText("What does the user ask?"), {
      target: { value: "Sketch two boxes" },
    });
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("Save sends the null-clears and fires eval_test_case_edited", async () => {
    renderPage(caseRoute);
    fireEvent.change(screen.getByLabelText("What does the user ask?"), {
      target: { value: "Sketch two boxes" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({
        testCaseId: "tc1",
        matchOptions: null,
        predicates: null,
        judgeConfigOverride: null,
        expectedOutput: "Two boxes.",
      }),
    );
    expect(h.track).toHaveBeenCalledWith(
      "eval_test_case_edited",
      expect.objectContaining({
        location: "case_steps_editor",
        test_case_id: "tc1",
      }),
    );
    expect(h.toast.success).toHaveBeenCalledWith("Changes saved");
  });

  it("a refused save keeps the draft and never calls the mutation", async () => {
    renderPage(caseRoute);
    fireEvent.change(screen.getByLabelText("What does the user ask?"), {
      target: { value: "" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(h.update).not.toHaveBeenCalled();
    expect(h.toast.error).toHaveBeenCalledWith(
      "Enter a user prompt before run or save.",
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("a live query update while dirty does not reset the draft", () => {
    const { rerender } = renderPage(caseRoute);
    fireEvent.change(screen.getByLabelText("What does the user ask?"), {
      target: { value: "Mine" },
    });
    h.queries["testSuites:listTestCases"] = [{ ...sketch, title: "Renamed" }];
    rerender(
      <MemoryRouter>
        <EvalNavPageServicesProvider value={services()}>
          <CaseStepsNavPage route={caseRoute} projectId="p1" />
        </EvalNavPageServicesProvider>
      </MemoryRouter>,
    );
    expect(
      (screen.getByLabelText("What does the user ask?") as HTMLTextAreaElement)
        .value,
    ).toBe("Mine");
  });

  it("Test Case Evaluators opens the case's evaluators page", async () => {
    renderPage(caseRoute);
    await userEvent.click(
      screen.getByRole("button", { name: "Test Case Evaluators" }),
    );
    expect(h.navigate).toHaveBeenCalledWith(
      { type: "case-evaluators", suiteId: "s1", testCaseId: "tc1" },
      { via: "link", from: { route: caseRoute, names: expect.any(Object) } },
    );
  });

  it("Run launches through the services, stays, and toasts a link to the test run", async () => {
    const user = userEvent.setup();
    const { value } = renderPage(caseRoute);
    const runCase = vi.spyOn(value, "runCase");
    await user.click(screen.getByRole("button", { name: "Run" }));
    await user.click(screen.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(runCase).toHaveBeenCalled());
    expect(runCase.mock.calls[0]![1]).toBe("tc1");
    expect(runCase.mock.calls[0]![2]).toMatchObject({ skipJudge: false });
    const [message, options] = h.toast.success.mock.lastCall!;
    expect(message).toBe("Test run started");
    expect(options.action.label).toBe("Open test run");
    options.action.onClick();
    expect(h.navigate).toHaveBeenLastCalledWith(
      { type: "test-run", suiteId: "s1", runId: "r9", testCaseId: "tc1" },
      expect.objectContaining({ via: "link" }),
    );
  });

  it("Delete deletes through the services and lands on the Test cases tab", async () => {
    const user = userEvent.setup();
    const deleteTestCasesBatch = vi.fn(async () => {});
    renderPage(caseRoute, { deps: { deleteTestCasesBatch } });
    await user.click(screen.getByLabelText("Delete test case"));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(deleteTestCasesBatch).toHaveBeenCalledWith(["tc1"]);
    expect(h.toast.success).toHaveBeenCalledWith("Test case deleted");
    expect(h.navigate).toHaveBeenLastCalledWith(
      { type: "suite-settings", suiteId: "s1", tab: "cases" },
      { via: "link", replace: true },
    );
  });

  it("a read-only suite hides Delete, Save and every Add button", () => {
    h.capabilities = { ownership: { ciOwned: true } };
    renderPage(caseRoute);
    expect(screen.queryByLabelText("Delete test case")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Add/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Run" })).toBeTruthy();
  });

  it("a case that is not in the suite shows the missing state", () => {
    renderPage({ ...caseRoute, testCaseId: "gone" });
    expect(screen.getByText("This test case no longer exists.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Open suite settings" }),
    ).toBeTruthy();
  });
});

describe("Execution preview slot", () => {
  it("sits after the title, docks left of the editor, lists the draft, and jumps to a row", async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderPage(caseRoute);
    const toggle = screen.getByRole("button", { name: "Execution preview" });
    expect(toggle.previousElementSibling?.textContent).toBe(
      "Sketch a two-node flow",
    );
    fireEvent.change(screen.getByLabelText("What does the user ask?"), {
      target: { value: "Unsaved prompt" },
    });
    await user.click(toggle);
    const panel = screen.getByLabelText("Execution preview panel");
    const editor = screen.getByTestId("case-steps-editor");
    expect(
      panel.compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const { buildExecutionPreview } =
      await import("../case-steps/case-steps-model");
    const props = h.panel.mock.lastCall![0];
    expect(props.variant).toBe("editor");
    expect(props.items[0].detail).toBe("“Unsaved prompt”");
    expect(props.items.map((item: { key: string }) => item.key)).toEqual(
      buildExecutionPreview({
        steps: [
          { id: "p1", kind: "prompt", prompt: "Unsaved prompt" },
          sketch.steps![1]!,
        ],
        toolsChoice: "tools",
        suiteDefaultPredicates: [],
      }).map((item) => item.key),
    );
    await user.click(screen.getByRole("button", { name: "jump check:a2" }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(
      document
        .querySelector('[data-case-step-toggle="check:a2"]')!
        .getAttribute("aria-expanded"),
    ).toBe("true");
    // The hook fires the opened event for the surface it is given; the page adds none.
    expect(h.previewSurface).toHaveBeenCalledWith("editor");
    expect(
      h.track.mock.calls.some(
        ([event]) => event === "eval_execution_preview_opened",
      ),
    ).toBe(false);
  });
});

describe("Edit Test Case (test-run-edit)", () => {
  const route = {
    type: "test-run-edit",
    suiteId: "s1",
    runId: "r4",
    testCaseId: "tc1",
  } as const;

  it("uses the test run trail and Back", () => {
    renderPage(route);
    expect(h.crumbBar).toHaveBeenLastCalledWith({
      crumbs: buildEvalCrumbs(route, names),
      back: buildEvalBack(route, names, null),
    });
  });

  it("?step= opens that row, scrolls to it and focuses it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderPage(route, { search: "?step=check%3Aa2" });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    const toggle = document.querySelector(
      '[data-case-step-toggle="check:a2"]',
    )!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(scrollIntoView).toHaveBeenCalled();
    expect(document.activeElement).toBe(toggle);
    vi.useRealTimers();
  });

  it("an unknown ?step= key changes nothing", () => {
    renderPage(route, { search: "?step=check%3Anope" });
    expect(document.querySelector('[aria-expanded="true"]')).toBeNull();
  });

  it("Delete lands on the suite run", async () => {
    const user = userEvent.setup();
    renderPage(route);
    await user.click(screen.getByLabelText("Delete test case"));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(h.navigate).toHaveBeenLastCalledWith(
      { type: "run-detail", suiteId: "s1", runId: "r4" },
      { via: "link", replace: true },
    );
  });
});

describe("New case (case-new)", () => {
  const route = { type: "case-new", suiteId: "s1" } as const;

  it("is a blank draft with the banner; Save case waits for a prompt", async () => {
    renderPage(route);
    expect(
      (screen.getByLabelText("Draft case title") as HTMLInputElement).value,
    ).toBe("Untitled test case");
    expect(screen.getByText("Suite settings apply")).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save case" });
    expect(save.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("What does the user ask?"), {
      target: { value: "Draw a box" },
    });
    expect(save.hasAttribute("disabled")).toBe(false);
    expect(h.create).not.toHaveBeenCalled();
    await userEvent.click(save);
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({ suiteId: "s1", caseId: expect.any(String) }),
    );
    expect(h.track).toHaveBeenCalledWith(
      "eval_test_case_created",
      expect.objectContaining({
        location: "case_steps_editor",
        test_case_id: "tc-new",
      }),
    );
    expect(h.navigate).toHaveBeenLastCalledWith(
      { type: "suite-settings", suiteId: "s1", tab: "cases" },
      expect.objectContaining({ via: "link", replace: true }),
    );
  });

  it("Open suite settings goes to Default evaluators", async () => {
    renderPage(route);
    await userEvent.click(
      screen.getByRole("button", { name: "Open suite settings" }),
    );
    expect(h.navigate.mock.lastCall![0]).toEqual({
      type: "suite-settings",
      suiteId: "s1",
      tab: "evaluators",
    });
  });
});

describe("Test Case Evaluators (case-evaluators)", () => {
  const route = {
    type: "case-evaluators",
    suiteId: "s1",
    testCaseId: "tc1",
  } as const;

  it("renders CaseChecksPage, crumbs with no Back, and auto-saves", async () => {
    renderPage(route, { Page: CaseEvaluatorsNavPage });
    expect(h.crumbBar).toHaveBeenLastCalledWith({
      crumbs: buildEvalCrumbs(route, names),
      back: null,
    });
    expect(
      screen.getByText("Overrides for Sketch a two-node flow."),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Change evaluators" }),
    );
    await waitFor(() =>
      expect(h.update).toHaveBeenCalledWith(
        expect.objectContaining({
          testCaseId: "tc1",
          predicates: { mode: "extend", list: [{ type: "noToolErrors" }] },
        }),
      ),
    );
    expect(pageViews()[0]![1]).toMatchObject({
      page: "test_case_evaluators",
      ui: "nav",
    });
  });

  it("Edit default evaluators opens Suite settings › Default evaluators", async () => {
    renderPage(route, { Page: CaseEvaluatorsNavPage });
    expect(
      screen.queryByRole("button", { name: "Configure suite assertions" }),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Edit default evaluators" }),
    );
    expect(h.navigate).toHaveBeenLastCalledWith(
      { type: "suite-settings", suiteId: "s1", tab: "evaluators" },
      { via: "link", from: { route, names: expect.any(Object) } },
    );
  });
});
