import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import { SuiteHeader } from "../suite-header";

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
}));

const mockIsHostedMode = vi.fn(() => false);
vi.mock("@/lib/apis/mode-client", () => ({
  isHostedMode: () => mockIsHostedMode(),
}));

vi.mock("posthog-js", () => ({
  default: { capture: vi.fn() },
}));

vi.mock("@/components/chat-v2/chat-input/model/provider-logo", () => ({
  ProviderLogo: () => null,
}));

describe("SuiteHeader", () => {
  const baseSuite = {
    _id: "suite-1",
    createdBy: "user-1",
    name: "Asana MCP Evals",
    description: "CI suite",
    configRevision: "1",
    environment: { servers: ["asana"] },
    createdAt: 1,
    updatedAt: 1,
    source: "sdk" as const,
  };

  const baseRun = {
    _id: "run-1",
    suiteId: "suite-1",
    createdBy: "user-1",
    runNumber: 1,
    configRevision: "1",
    configSnapshot: {
      tests: [],
      environment: { servers: ["asana"] },
    },
    status: "completed" as const,
    source: "sdk" as const,
    hasServerReplayConfig: true,
    createdAt: 1_000,
    completedAt: 136_000,
    summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
  };

  const baseProps = {
    suite: baseSuite,
    viewMode: "run-detail" as const,
    selectedRunDetails: baseRun,
    isEditMode: false,
    onRerun: vi.fn(),
    onReplayRun: vi.fn(),
    onCancelRun: vi.fn(),
    onViewModeChange: vi.fn(),
    connectedServerNames: new Set<string>(),
    rerunningSuiteId: null,
    cancellingRunId: null,
    runs: [baseRun],
    allIterations: [],
    aggregate: null,
    testCases: [],
    availableModels: [],
    readOnlyConfig: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsHostedMode.mockReturnValue(false);
  });

  it("shows compact run stats under the run title in run detail when no KPI strip", () => {
    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        selectedRunDetails={{
          ...baseRun,
          summary: { total: 2, passed: 1, failed: 1, passRate: 0.5 },
        }}
      />,
    );
    expect(screen.getByText(/1 passed · 1 failed · 50%/)).toBeInTheDocument();
  });

  it("hides compact run stats when the KPI strip is shown", () => {
    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        selectedRunDetails={{
          ...baseRun,
          summary: { total: 2, passed: 1, failed: 1, passRate: 0.5 },
        }}
        runDetailKpiStrip={<div data-testid="run-kpi-strip">kpis</div>}
      />,
    );
    expect(
      screen.queryByText(/1 passed · 1 failed · 50%/),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("run-kpi-strip")).toBeInTheDocument();
  });

  it("shows replay lineage under the run title when replayedFromRunId is set", () => {
    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        selectedRunDetails={{
          ...baseRun,
          replayedFromRunId: "n573zfck8sdhjg7by2s31ex2yx83m6sh",
        }}
      />,
    );

    expect(screen.getByText("Replay of")).toBeTruthy();
    expect(screen.getByText("Run n573zfck")).toBeTruthy();
  });

  it("shows a replay action for replayable CI runs in read-only run detail", async () => {
    const user = userEvent.setup();

    renderWithProviders(<SuiteHeader {...baseProps} />);

    const replayButton = screen.getByRole("button", {
      name: "Replay this run",
    });
    expect(replayButton).toBeTruthy();
    expect(replayButton).not.toBeDisabled();

    await user.click(replayButton);

    expect(baseProps.onReplayRun).toHaveBeenCalledWith(baseSuite, baseRun);
    expect(baseProps.onRerun).not.toHaveBeenCalled();
  });

  it("hides run-detail actions when run actions are suppressed", () => {
    renderWithProviders(<SuiteHeader {...baseProps} hideRunActions />);

    expect(
      screen.queryByRole("button", { name: "Replay this run" }),
    ).toBeNull();
  });

  it("shows replay latest run in overview without hosted-mode gating", () => {
    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        viewMode="overview"
        selectedRunDetails={null}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Replay latest run" }),
    ).toBeTruthy();
  });

  it("truncates a very long read-only suite name in overview and keeps full name in title", () => {
    const longName = "excalidraw " + "x".repeat(200);
    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        viewMode="overview"
        selectedRunDetails={null}
        suite={{ ...baseSuite, name: longName }}
        readOnlyConfig
      />,
    );

    const heading = screen.getByRole("heading", { level: 2, name: longName });
    expect(heading).toHaveClass("truncate");
    expect(heading).toHaveAttribute("title", longName);
  });

  it("hides overview run actions when run actions are suppressed", () => {
    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        viewMode="overview"
        selectedRunDetails={null}
        hideRunActions
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Replay latest run" }),
    ).toBeNull();
  });

  it("shows Cases when cases sidebar is hidden on runs overview", async () => {
    const user = userEvent.setup();
    const onShowCasesSidebar = vi.fn();

    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        viewMode="overview"
        selectedRunDetails={null}
        runsViewMode="runs"
        casesSidebarHidden
        onShowCasesSidebar={onShowCasesSidebar}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Cases" }));

    expect(onShowCasesSidebar).toHaveBeenCalled();
  });

  it("fires the export callback when Setup SDK is clicked", async () => {
    const user = userEvent.setup();
    const onOpenExportSuite = vi.fn();

    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        viewMode="overview"
        selectedRunDetails={null}
        onOpenExportSuite={onOpenExportSuite}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Setup SDK" }));

    expect(onOpenExportSuite).toHaveBeenCalledTimes(1);
  });

  it("shows a loading state on Generate in test-cases overview while generating", () => {
    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        viewMode="overview"
        selectedRunDetails={null}
        runsViewMode="test-cases"
        onGenerateTestCases={vi.fn()}
        canGenerateTestCases
        isGeneratingTestCases
      />,
    );

    const generateBtn = screen.getByRole("button", { name: /generate/i });
    expect(generateBtn).toHaveAttribute("aria-busy", "true");
    expect(generateBtn).toBeDisabled();
    expect(generateBtn.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("shows Generate and New case on unified suite dashboard when URL is still ?view=runs", () => {
    const onCreate = vi.fn();
    const onGenerate = vi.fn();

    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        viewMode="overview"
        selectedRunDetails={null}
        runsViewMode="runs"
        hideRunActions
        unifiedSuiteDashboard
        onCreateTestCase={onCreate}
        onGenerateTestCases={onGenerate}
        canGenerateTestCases
      />,
    );

    expect(
      screen.getByRole("button", { name: "New case" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /generate/i }),
    ).toBeInTheDocument();
  });

  it("shows Run all in the playground header and calls onRerun", async () => {
    const user = userEvent.setup();
    const onRerun = vi.fn();

    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        viewMode="overview"
        selectedRunDetails={null}
        onRerun={onRerun}
        runsViewMode="runs"
        hideRunActions
        unifiedSuiteDashboard
        onCreateTestCase={vi.fn()}
        onGenerateTestCases={vi.fn()}
        canGenerateTestCases
        testCases={[
          { _id: "c1", models: [{ provider: "openai", model: "gpt-4" }] } as any,
        ]}
        connectedServerNames={new Set(["asana"])}
      />,
    );

    const runAll = screen.getByRole("button", {
      name: /Run all cases in this suite/i,
    });
    expect(runAll).toBeEnabled();
    await user.click(runAll);
    expect(onRerun).toHaveBeenCalledWith(baseSuite);
  });

  it("shows the suite model bar on overview when test cases exist", () => {
    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        viewMode="overview"
        selectedRunDetails={null}
        readOnlyConfig={false}
        testCases={[
          {
            _id: "c1",
            title: "Case",
            models: [{ provider: "openai", model: "gpt-4" }],
          } as any,
        ]}
        availableModels={
          [
            { id: "gpt-4", name: "GPT-4", provider: "openai" },
            { id: "gpt-5-nano", name: "GPT-5 Nano", provider: "openai" },
          ] as any
        }
        onSuiteModelsUpdate={vi.fn()}
      />,
    );

    expect(screen.getByText("GPT-4")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add model" }),
    ).toBeInTheDocument();
  });

});
