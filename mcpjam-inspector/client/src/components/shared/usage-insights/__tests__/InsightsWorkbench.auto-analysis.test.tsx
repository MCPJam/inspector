/**
 * BB-196: User Testing analyzes itself.
 *
 * The workbench is shared by three scopes, and only one of them makes this
 * promise — so what these pin is mostly the BOUNDARY:
 *
 *   - SCENARIO scope starts the first analysis on open, and tells the diagram
 *     that a missing run means work in progress rather than a button to find.
 *   - SWARM scope does not. It already auto-queues when a run settles
 *     (`journeyRuns.recomputeRunSummaries`), so a swarm with no run is a
 *     different story from an unanalyzed scenario.
 *   - BENCHMARK scope does not. Its flow analysis is the one PAID call here,
 *     an action rather than a mutation, designed to wait to be asked.
 *   - The automatic start is SILENT. Nobody asked for it, so a toast would
 *     report an outcome for an action the user did not take.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InsightsWorkbench } from "../InsightsWorkbench";
import type { InsightsScope, UsageBreakdown } from "@/hooks/useUsageInsights";

const { mockUseUsageInsights, mockUseGoalOutcomeDrilldown, toastMock } =
  vi.hoisted(() => ({
    mockUseUsageInsights: vi.fn(),
    mockUseGoalOutcomeDrilldown: vi.fn(),
    toastMock: {
      success: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      error: vi.fn(),
    },
  }));

vi.mock("@/lib/toast", () => ({ toast: toastMock }));

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useQuery: () => undefined,
    useMutation: () => async () => undefined,
  };
});

vi.mock("@/hooks/useUsageInsights", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useUsageInsights: (...args: unknown[]) => mockUseUsageInsights(...args),
    useGoalOutcomeDrilldown: (...args: unknown[]) =>
      mockUseGoalOutcomeDrilldown(...args),
  };
});

vi.mock("@/components/shared/usage-insights/TopicMapPanel", () => ({
  TopicMapPanel: () => <div data-testid="topic-map-panel" />,
}));

// Stubbed to the one prop under test: this file exercises what the workbench
// TELLS the diagram, not what the diagram does with it (that has its own).
vi.mock("@/components/shared/usage-insights/SessionFlowSankey", () => ({
  SessionFlowSankey: ({
    analysisIsAutomatic,
  }: {
    analysisIsAutomatic?: boolean;
  }) => (
    <span data-testid="analysis-is-automatic">
      {String(analysisIsAutomatic)}
    </span>
  ),
}));

let rebuild: ReturnType<typeof vi.fn>;

/** A cohort with sessions and no analysis — the state BB-196 is about. */
function breakdown(
  overrides: Partial<Pick<UsageBreakdown, "totalSessions" | "latestRun">> = {},
): UsageBreakdown {
  return {
    totalSessions: 4,
    latestRun: null,
    ...overrides,
  } as unknown as UsageBreakdown;
}

function renderWorkbench(
  scope: InsightsScope | null,
  breakdownValue: UsageBreakdown | null | undefined = breakdown(),
) {
  mockUseUsageInsights.mockReturnValue({
    threads: undefined,
    breakdown: breakdownValue,
    rebuild,
  });
  return render(
    <InsightsWorkbench
      scope={scope}
      cohortKey="cohort-1"
      testIdPrefix="insights"
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  rebuild = vi.fn().mockResolvedValue({
    runId: "run-1",
    status: "queued",
    alreadyRunning: false,
  });
  mockUseGoalOutcomeDrilldown
    .mockReset()
    .mockReturnValue({ drilldown: undefined, isLoading: false });
});

describe("InsightsWorkbench automatic analysis", () => {
  it("starts the first analysis of a User Testing scenario on open", async () => {
    renderWorkbench({ kind: "scenario", scenarioId: "sc-1" });
    await waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("analysis-is-automatic")).toHaveTextContent(
      "true",
    );
  });

  it("says nothing about it — the user did not ask", async () => {
    renderWorkbench({ kind: "scenario", scenarioId: "sc-1" });
    await waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.info).not.toHaveBeenCalled();
  });

  it("leaves a scenario that has already been analyzed alone", () => {
    renderWorkbench(
      { kind: "scenario", scenarioId: "sc-1" },
      breakdown({
        latestRun: { status: "done" } as UsageBreakdown["latestRun"],
      }),
    );
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("does not analyze a swarm on open — a settling run already does", () => {
    renderWorkbench({ kind: "swarm", projectId: "proj-1" });
    expect(rebuild).not.toHaveBeenCalled();
    expect(screen.getByTestId("analysis-is-automatic")).toHaveTextContent(
      "false",
    );
  });

  it("withdraws the promise when the start is refused", async () => {
    // The refusal a signed-out guest gets: `rebuildScenarioInsights`
    // authenticates. There will never be a run, so continuing to promise that
    // this surface analyzes itself would leave the guest watching a spinner
    // with the rebuild button hidden behind it.
    rebuild.mockRejectedValue(new Error("Not authenticated"));
    renderWorkbench({ kind: "scenario", scenarioId: "sc-1" });

    await waitFor(() =>
      expect(screen.getByTestId("analysis-is-automatic")).toHaveTextContent(
        "false",
      ),
    );
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it("does not buy a benchmark flow analysis on open", () => {
    renderWorkbench({ kind: "benchmark", benchmarkRunId: "run-9" });
    expect(rebuild).not.toHaveBeenCalled();
    expect(screen.getByTestId("analysis-is-automatic")).toHaveTextContent(
      "false",
    );
  });
});
