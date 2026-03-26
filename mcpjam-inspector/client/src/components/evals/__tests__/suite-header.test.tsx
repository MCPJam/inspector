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
    showRunSummarySidebar: false,
    setShowRunSummarySidebar: vi.fn(),
    runs: [baseRun],
    allIterations: [],
    aggregate: null,
    testCases: [],
    availableModels: [],
    readOnlyConfig: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsHostedMode.mockReturnValue(true);
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

  it("shows replay latest run in overview for hosted CI suites", () => {
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
});
