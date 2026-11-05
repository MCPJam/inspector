import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { ReactNode } from "react";
import type { SuiteSettingsTab } from "@/lib/eval-route-types";
import type { EvalSuite } from "../../../evals/types";
import { SuiteSettingsPage } from "../suite-settings-page";

const suite: EvalSuite = {
  _id: "s_1",
  createdBy: "u",
  name: "Excalidraw quickstart",
  description: "",
  configRevision: "r",
  environment: { servers: [] },
  createdAt: 1,
  updatedAt: 1,
  source: "ui",
};

const pageData = {
  projectId: "p_1",
  suite: suite as EvalSuite | null | undefined,
  cases: [],
  runs: [],
  capabilities: { state: "loading", capabilities: null },
  configLocked: false,
  generateState: { canGenerate: true, disabledReason: "" },
  deleteTestCases: vi.fn(),
  evalContext: {
    connectedServerNames: new Set<string>(),
    availableModels: [],
    requireOrgKeys: false,
    onManageOrgProviders: undefined,
    onAddProvider: null,
  },
};
vi.mock("../use-suite-settings-page-data", () => ({
  useSuiteSettingsPageData: () => pageData,
}));

const editor = {
  draft: { current: { name: "Excalidraw quickstart" }, conflicts: [] },
  dispatchDraft: vi.fn(),
  draftChanges: [] as { label: string }[],
  draftCanCommit: true,
  isCommitting: false,
  nameRowError: undefined,
  passOrFailRowError: undefined,
  commitSettings: vi.fn(),
};
const editorOptions = vi.fn();
vi.mock(
  "../../../evals/suite-settings-sheet/use-suite-settings-editor",
  () => ({
    useSuiteSettingsEditor: (options: unknown) => {
      editorOptions(options);
      return editor;
    },
  }),
);

const authoring = { takeover: null as ReactNode };
vi.mock("../../case-authoring-takeovers", () => ({
  useCaseAuthoringTakeovers: () => ({
    ...authoring,
    generation: undefined,
    canGenerate: true,
    handleGenerateCases: vi.fn(),
    generateDialog: null,
  }),
}));

vi.mock("../../../evals/suite-settings-sheet/suite-settings-fields", () => ({
  SuiteSettingsFields: () => <div>settings fields</div>,
}));
vi.mock(
  "../../../evals/suite-settings-sheet/suite-run-target-settings-fields",
  () => ({ SuiteRunTargetSettingsFields: () => <div>run target fields</div> }),
);
vi.mock(
  "../../../evals/suite-settings-sheet/suite-budget-settings-fields",
  () => ({
    SuiteBudgetSettingsFields: () => <div>budget fields</div>,
  }),
);
vi.mock(
  "../../../evals/suite-settings-sheet/suite-default-evaluators-fields",
  () => ({
    SuiteDefaultEvaluatorsFields: () => <div>default evaluators fields</div>,
  }),
);
vi.mock("../../../evals/test-cases-overview", () => ({
  TestCasesOverview: ({
    onTestCaseClick,
  }: {
    onTestCaseClick: (id: string) => void;
  }) => (
    <button type="button" onClick={() => onTestCaseClick("c_1")}>
      case row
    </button>
  ),
}));
vi.mock("../../import-dataset-dialog", () => ({
  ImportDatasetDialog: () => null,
}));
vi.mock("@/components/billing/SharedSettingsGate", () => ({
  SharedSettingsGate: ({ children }: { children: ReactNode }) => children,
}));

function renderTab(tab: SuiteSettingsTab) {
  const path = `/evaluate/suite/s_1/settings${tab === "settings" ? "" : `/${tab}`}`;
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <SuiteSettingsPage
            route={{ type: "suite-settings", suiteId: "s_1", tab }}
          />
        ),
      },
    ],
    { initialEntries: [path] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("SuiteSettingsPage", () => {
  beforeEach(() => {
    authoring.takeover = null;
    editor.draftChanges = [];
    pageData.suite = suite;
    pageData.configLocked = false;
  });

  it("shows the trail and one Save bar on the Settings tab", () => {
    renderTab("settings");
    expect(screen.getByText("Excalidraw quickstart")).toBeTruthy();
    expect(screen.getByText("Suite settings")).toBeTruthy();
    expect(screen.getByText("settings fields")).toBeTruthy();
    expect(screen.getByText("budget fields")).toBeTruthy();
    expect(screen.queryByText("default evaluators fields")).toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Save settings" }),
    ).toHaveLength(1);
  });

  it("shows the default evaluators with the same Save bar", () => {
    editor.draftChanges = [{ label: "Judge" }];
    renderTab("evaluators");
    expect(screen.getByText("default evaluators fields")).toBeTruthy();
    expect(screen.queryByText("settings fields")).toBeNull();
    expect(screen.getByTestId("suite-settings-commit-bar")).toBeTruthy();
  });

  it("has no Save bar on the Test cases tab", () => {
    editor.draftChanges = [{ label: "Name" }];
    renderTab("cases");
    expect(screen.getByTestId("suite-settings-cases-tab")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
    expect(screen.queryByTestId("suite-settings-commit-bar")).toBeNull();
  });

  it("gives each tab its own address", () => {
    const router = renderTab("settings");
    act(() => {
      fireEvent.mouseDown(
        screen.getByRole("tab", { name: "Default evaluators" }),
      );
    });
    expect(router.state.location.pathname).toBe(
      "/evaluate/suite/s_1/settings/evaluators",
    );
  });

  it("keeps the draft when moving between the three tabs", () => {
    renderTab("settings");
    const { keepsDraft } = editorOptions.mock.lastCall?.[0] as {
      keepsDraft: (pathname: string) => boolean;
    };
    expect(keepsDraft("/p/p_1/evaluate/suite/s_1/settings/cases")).toBe(true);
    expect(keepsDraft("/evaluate/suite/s_1/settings/evaluators")).toBe(true);
    expect(keepsDraft("/evaluate/suite/s_1/settings/cases/c_1")).toBe(false);
    expect(keepsDraft("/evaluate/suite/s_2/settings")).toBe(false);
  });

  it("opens Add case and each case at their own addresses", () => {
    const router = renderTab("cases");
    fireEvent.click(screen.getByRole("button", { name: "Add case" }));
    expect(router.state.location.pathname).toBe(
      "/evaluate/suite/s_1/settings/cases/new",
    );
    act(() => {
      void router.navigate("/evaluate/suite/s_1/settings/cases");
    });
    fireEvent.click(screen.getByRole("button", { name: "case row" }));
    expect(router.state.location.pathname).toBe(
      "/evaluate/suite/s_1/settings/cases/c_1",
    );
    expect(router.state.location.state).toEqual({ evalNavArrival: "link" });
  });

  it("shows Generate and Import review inside the Test cases tab", () => {
    authoring.takeover = <div>generation workspace</div>;
    renderTab("cases");
    expect(screen.getByText("generation workspace")).toBeTruthy();
    expect(screen.getByText("Suite settings")).toBeTruthy();
  });

  it("locks a CI-owned suite: no Save bar and no Add case", () => {
    pageData.configLocked = true;
    renderTab("settings");
    expect(screen.getByTestId("suite-settings-ci-owned")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save settings" })).toBeNull();
  });

  it("says so when the suite is gone", () => {
    pageData.suite = null;
    renderTab("settings");
    expect(
      screen.getByText(/deleted or you no longer have access/),
    ).toBeTruthy();
  });
});
