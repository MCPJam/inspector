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
    onDelete: vi.fn(),
    onCancelRun: vi.fn(),
    onDeleteRun: vi.fn(),
    onViewModeChange: vi.fn(),
    connectedServerNames: new Set<string>(),
    canDeleteSuite: false,
    rerunningSuiteId: null,
    cancellingRunId: null,
    deletingSuiteId: null,
    deletingRunId: null,
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

  it("shows compact run stats under the run title in run detail", () => {
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

  it("shows Delete suite in read-only overview when canDeleteSuite is true", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();

    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        viewMode="overview"
        selectedRunDetails={null}
        canDeleteSuite
        onDelete={onDelete}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete suite" }));

    expect(onDelete).toHaveBeenCalledWith(baseSuite);
  });

  it("hides Delete suite in read-only overview when canDeleteSuite is false", () => {
    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        viewMode="overview"
        selectedRunDetails={null}
        canDeleteSuite={false}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Delete suite" }),
    ).toBeNull();
  });
});
