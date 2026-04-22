import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import {
  fireEvent,
  renderWithProviders,
  screen,
  waitFor,
  within,
} from "@/test";
import { TestCasesOverview } from "../test-cases-overview";

const useConvexMock = vi.hoisted(() => vi.fn());
const useQueryMock = vi.hoisted(() => vi.fn());

vi.mock("posthog-js", () => ({
  default: {
    capture: vi.fn(),
  },
}));

vi.mock("@/lib/PosthogUtils", () => ({
  detectEnvironment: vi.fn().mockReturnValue("test"),
  detectPlatform: vi.fn().mockReturnValue("web"),
}));

vi.mock("convex/react", () => ({
  useConvex: useConvexMock,
  useQuery: useQueryMock,
}));

describe("TestCasesOverview", () => {
  const suite = {
    _id: "suite-1",
    name: "Suite 1",
  };

  const baseCase = {
    _id: "case-1",
    testSuiteId: "suite-1",
    createdBy: "user-1",
    title: "Create a simple flowchart diagram",
    query: "Draw a basic flowchart",
    models: [{ model: "gpt-5-nano", provider: "openai" }],
    runs: 1,
    expectedToolCalls: [],
    lastMessageRun: null,
  };

  const savedIteration = {
    _id: "iter-1",
    testCaseId: "case-1",
    createdBy: "user-1",
    createdAt: Date.now() - 5_000,
    updatedAt: Date.now() - 1_000,
    iterationNumber: 1,
    status: "completed" as const,
    result: "passed" as const,
    resultSource: "reported" as const,
    actualToolCalls: [],
    tokensUsed: 42,
    testCaseSnapshot: {
      title: "Create a simple flowchart diagram",
      query: "Draw a basic flowchart",
      provider: "openai",
      model: "gpt-5-nano",
      expectedToolCalls: [],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hydrates saved quick runs from fresh case metadata and iteration queries", async () => {
    const convexQueryMock = vi.fn(async (name: string) => {
      if (name === "testSuites:listTestIterations") {
        return [savedIteration];
      }
      if (name === "testSuites:getTestIteration") {
        return savedIteration;
      }
      return null;
    });

    useConvexMock.mockReturnValue({ query: convexQueryMock });
    useQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:listTestCases") {
        return [
          {
            ...baseCase,
            lastMessageRun: savedIteration._id,
          },
        ];
      }
      return undefined;
    });

    renderWithProviders(
      <TestCasesOverview
        suite={suite}
        cases={[baseCase]}
        allIterations={[]}
        runsViewMode="test-cases"
        onViewModeChange={vi.fn()}
        onTestCaseClick={vi.fn()}
        runTrendData={[]}
        modelStats={[]}
        runsLoading={false}
      />,
    );

    const row = await screen.findByTestId("test-case-row-case-1");

    await waitFor(() => {
      expect(within(row).getByLabelText("Passed")).toBeInTheDocument();
    });

    expect(within(row).queryByText(/^1$/)).not.toBeInTheDocument();
    expect(convexQueryMock).toHaveBeenCalledWith(
      "testSuites:listTestIterations",
      { testCaseId: "case-1" },
    );
  });

  it("uses the latest iteration by updatedAt for Last run", async () => {
    const olderPassed = {
      ...savedIteration,
      _id: "iter-old",
      updatedAt: 1_000,
      result: "passed" as const,
    };
    const newerFailed = {
      ...savedIteration,
      _id: "iter-new",
      updatedAt: 9_000,
      result: "failed" as const,
    };

    const convexQueryMock = vi.fn(async (name: string) => {
      if (name === "testSuites:listTestIterations") {
        return [olderPassed, newerFailed];
      }
      return null;
    });

    useConvexMock.mockReturnValue({ query: convexQueryMock });
    useQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:listTestCases") {
        return [{ ...baseCase, lastMessageRun: newerFailed._id }];
      }
      return undefined;
    });

    renderWithProviders(
      <TestCasesOverview
        suite={suite}
        cases={[baseCase]}
        allIterations={[]}
        runsViewMode="test-cases"
        onViewModeChange={vi.fn()}
        onTestCaseClick={vi.fn()}
        runTrendData={[]}
        modelStats={[]}
        runsLoading={false}
      />,
    );

    const row = await screen.findByTestId("test-case-row-case-1");

    await waitFor(() => {
      expect(within(row).getByLabelText("Failed")).toBeInTheDocument();
    });
    expect(within(row).queryByLabelText("Passed")).not.toBeInTheDocument();
  });

  it("does not show the failure indicator when the latest iteration passed", async () => {
    const olderFailedIt = {
      ...savedIteration,
      _id: "iter-old",
      updatedAt: 1_000,
      result: "failed" as const,
    };
    const newerPassedIt = {
      ...savedIteration,
      _id: "iter-new",
      updatedAt: 9_000,
      result: "passed" as const,
    };

    const convexQueryMock = vi.fn(async (name: string) => {
      if (name === "testSuites:listTestIterations") {
        return [olderFailedIt, newerPassedIt];
      }
      return null;
    });

    useConvexMock.mockReturnValue({ query: convexQueryMock });
    useQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:listTestCases") {
        return [{ ...baseCase, lastMessageRun: olderFailedIt._id }];
      }
      return undefined;
    });

    renderWithProviders(
      <TestCasesOverview
        suite={suite}
        cases={[baseCase]}
        allIterations={[]}
        runsViewMode="test-cases"
        onViewModeChange={vi.fn()}
        onTestCaseClick={vi.fn()}
        runTrendData={[]}
        modelStats={[]}
        runsLoading={false}
      />,
    );

    const row = await screen.findByTestId("test-case-row-case-1");

    await waitFor(() => {
      expect(within(row).getByLabelText("Passed")).toBeInTheDocument();
    });
    expect(
      within(row).queryByLabelText("Last run failed"),
    ).not.toBeInTheDocument();
  });

  it("calls onOpenLastRun when the last run summary is clicked", async () => {
    const onTestCaseClick = vi.fn();
    const onOpenLastRun = vi.fn();
    useConvexMock.mockReturnValue({ query: vi.fn() });
    useQueryMock.mockReturnValue(undefined);
    const user = userEvent.setup();

    renderWithProviders(
      <TestCasesOverview
        suite={suite}
        cases={[baseCase]}
        allIterations={[savedIteration]}
        runsViewMode="test-cases"
        onViewModeChange={vi.fn()}
        onTestCaseClick={onTestCaseClick}
        onOpenLastRun={onOpenLastRun}
        runTrendData={[]}
        modelStats={[]}
        runsLoading={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: /View last run:/i }));

    expect(onOpenLastRun).toHaveBeenCalledTimes(1);
    expect(onOpenLastRun).toHaveBeenCalledWith("case-1", "iter-1");
    expect(onTestCaseClick).not.toHaveBeenCalled();
  });

  it("calls onTestCaseClick when clicking last-run summary area without onOpenLastRun", async () => {
    const onTestCaseClick = vi.fn();
    useConvexMock.mockReturnValue({ query: vi.fn() });
    useQueryMock.mockReturnValue(undefined);
    const user = userEvent.setup();

    renderWithProviders(
      <TestCasesOverview
        suite={suite}
        cases={[baseCase]}
        allIterations={[savedIteration]}
        runsViewMode="test-cases"
        onViewModeChange={vi.fn()}
        onTestCaseClick={onTestCaseClick}
        runTrendData={[]}
        modelStats={[]}
        runsLoading={false}
      />,
    );

    await user.click(screen.getByLabelText("Passed"));

    expect(onTestCaseClick).toHaveBeenCalledTimes(1);
    expect(onTestCaseClick).toHaveBeenCalledWith("case-1");
  });

  it("calls onTestCaseClick when clicking Never run summary (full row target)", async () => {
    const onTestCaseClick = vi.fn();
    useConvexMock.mockReturnValue({ query: vi.fn() });
    useQueryMock.mockReturnValue(undefined);
    const user = userEvent.setup();

    renderWithProviders(
      <TestCasesOverview
        suite={suite}
        cases={[baseCase]}
        allIterations={[]}
        runsViewMode="test-cases"
        onViewModeChange={vi.fn()}
        onTestCaseClick={onTestCaseClick}
        runTrendData={[]}
        modelStats={[]}
        runsLoading={false}
      />,
    );

    await user.click(screen.getByText("Never run"));

    expect(onTestCaseClick).toHaveBeenCalledTimes(1);
    expect(onTestCaseClick).toHaveBeenCalledWith("case-1");
  });

  it("hides the Runs/Cases selector when hideViewModeSelect is set", () => {
    useConvexMock.mockReturnValue({ query: vi.fn() });
    useQueryMock.mockReturnValue(undefined);

    renderWithProviders(
      <TestCasesOverview
        suite={suite}
        cases={[]}
        allIterations={[]}
        runsViewMode="test-cases"
        onViewModeChange={vi.fn()}
        onTestCaseClick={vi.fn()}
        hideViewModeSelect
        runTrendData={[]}
        modelStats={[]}
        runsLoading={false}
      />,
    );

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("calls onRunTestCase when the row Run button is clicked", async () => {
    const onRunTestCase = vi.fn();
    useConvexMock.mockReturnValue({ query: vi.fn() });
    useQueryMock.mockReturnValue(undefined);
    const user = userEvent.setup();

    renderWithProviders(
      <TestCasesOverview
        suite={{
          ...suite,
          environment: { servers: ["playground-server"] },
        }}
        cases={[baseCase]}
        allIterations={[]}
        runsViewMode="test-cases"
        onViewModeChange={vi.fn()}
        onTestCaseClick={vi.fn()}
        onRunTestCase={onRunTestCase}
        connectedServerNames={new Set(["playground-server"])}
        runTrendData={[]}
        modelStats={[]}
        runsLoading={false}
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: /Run Create a simple flowchart diagram/i,
      }),
    );

    expect(onRunTestCase).toHaveBeenCalledTimes(1);
    expect(onRunTestCase).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "case-1" }),
    );
  });

  it("shows per-case checkboxes when onDeleteTestCasesBatch is set", async () => {
    useConvexMock.mockReturnValue({ query: vi.fn() });
    useQueryMock.mockReturnValue(undefined);

    renderWithProviders(
      <TestCasesOverview
        suite={suite}
        cases={[baseCase]}
        allIterations={[]}
        runsViewMode="test-cases"
        onViewModeChange={vi.fn()}
        onTestCaseClick={vi.fn()}
        hideViewModeSelect
        onDeleteTestCasesBatch={vi.fn().mockResolvedValue(undefined)}
        runTrendData={[]}
        modelStats={[]}
        runsLoading={false}
      />,
    );

    expect(
      screen.getByRole("checkbox", {
        name: /Select case Create a simple flowchart diagram/i,
      }),
    ).toBeInTheDocument();
  });

  it("shows a disconnected playground empty state when no cases exist", () => {
    useConvexMock.mockReturnValue({ query: vi.fn() });
    useQueryMock.mockReturnValue(undefined);

    renderWithProviders(
      <TestCasesOverview
        suite={{
          ...suite,
          environment: { servers: ["playground-server"] },
        }}
        cases={[]}
        allIterations={[]}
        runsViewMode="test-cases"
        onViewModeChange={vi.fn()}
        onTestCaseClick={vi.fn()}
        hideViewModeSelect
        connectedServerNames={new Set()}
        onDeleteTestCasesBatch={vi.fn().mockResolvedValue(undefined)}
        runTrendData={[]}
        modelStats={[]}
        runsLoading={false}
      />,
    );

    expect(
      screen.getByText("Start playground-server to generate tests"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Playground can automatically generate test cases once a server is connected.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", { name: /Select all cases/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps a persistent batch header in playground mode", async () => {
    useConvexMock.mockReturnValue({ query: vi.fn() });
    useQueryMock.mockReturnValue(undefined);
    const user = userEvent.setup();

    renderWithProviders(
      <TestCasesOverview
        suite={suite}
        cases={[baseCase]}
        allIterations={[]}
        runsViewMode="test-cases"
        onViewModeChange={vi.fn()}
        onTestCaseClick={vi.fn()}
        hideViewModeSelect
        onDeleteTestCasesBatch={vi.fn().mockResolvedValue(undefined)}
        runTrendData={[]}
        modelStats={[]}
        runsLoading={false}
      />,
    );

    expect(screen.getByText("Test Cases")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Cancel" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("checkbox", {
        name: /Select case Create a simple flowchart diagram/i,
      }),
    );

    expect(screen.getByText("Test Cases")).toBeInTheDocument();
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Cancel" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Delete" }),
    ).toBeEnabled();
  });

  it("toggles row selection on right-click without opening the test case", () => {
    const onTestCaseClick = vi.fn();
    useConvexMock.mockReturnValue({ query: vi.fn() });
    useQueryMock.mockReturnValue(undefined);

    renderWithProviders(
      <TestCasesOverview
        suite={suite}
        cases={[baseCase]}
        allIterations={[]}
        runsViewMode="test-cases"
        onViewModeChange={vi.fn()}
        onTestCaseClick={onTestCaseClick}
        hideViewModeSelect
        onDeleteTestCasesBatch={vi.fn().mockResolvedValue(undefined)}
        runTrendData={[]}
        modelStats={[]}
        runsLoading={false}
      />,
    );

    const row = screen.getByTestId("test-case-row-case-1");
    const checkbox = screen.getByRole("checkbox", {
      name: /Select case Create a simple flowchart diagram/i,
    });

    const firstContextMenu = fireEvent.contextMenu(row);
    expect(firstContextMenu).toBe(false);
    expect(checkbox).toBeChecked();

    const secondEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    fireEvent(row, secondEvent);

    expect(secondEvent.defaultPrevented).toBe(true);
    expect(checkbox).not.toBeChecked();
    expect(onTestCaseClick).not.toHaveBeenCalled();
  });
});
