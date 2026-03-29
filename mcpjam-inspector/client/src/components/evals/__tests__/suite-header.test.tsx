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
    createdAt: 1,
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

  it("shows Auto fix in playground overview when eligible", () => {
    const playgroundSuite = { ...baseSuite, source: "ui" as const };
    const failedUiRun = {
      ...baseRun,
      source: "ui" as const,
      summary: {
        total: 4,
        passed: 2,
        failed: 2,
        passRate: 0.5,
      },
      completedAt: 999,
      hasServerReplayConfig: true,
    };
    const onTraceRepair = vi.fn();

    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        suite={playgroundSuite}
        viewMode="overview"
        selectedRunDetails={null}
        runs={[failedUiRun]}
        readOnlyConfig={false}
        onEditSuite={() => {}}
        onTraceRepairSuite={onTraceRepair}
        traceRepairEligible
        traceRepairSuiteJobActive={false}
        traceRepairStarting={false}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Auto fix/i }),
    ).toBeEnabled();
  });

  it("does not show Auto fix for SDK suites even if callback is passed", () => {
    const onTraceRepair = vi.fn();
    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        viewMode="overview"
        selectedRunDetails={null}
        onTraceRepairSuite={onTraceRepair}
        traceRepairEligible
      />,
    );

    expect(
      screen.queryByRole("button", { name: /^Auto fix$/i }),
    ).toBeNull();
  });

  it("shows Delete suite in overview when editable and calls onDelete", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();

    renderWithProviders(
      <SuiteHeader
        {...baseProps}
        viewMode="overview"
        selectedRunDetails={null}
        readOnlyConfig={false}
        onDelete={onDelete}
        onEditSuite={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Delete suite" }));

    expect(onDelete).toHaveBeenCalledWith(baseSuite);
  });
});
