/**
 * BB-196: User Testing analyzes itself.
 *
 * The workbench is shared by three scopes, and only one of them makes this
 * promise — so what these pin is mostly the BOUNDARY:
 *
 *   - SCENARIO scope starts the first analysis on open, and tells the diagram
 *     that a missing run means work in progress rather than a button to find.
 *   - SWARM scope does not. It already auto-queues when a run settles
 *     (journeyRuns.ts, on first settle), so a swarm with no run is a
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

vi.mock("@/components/connection/share-usage/ShareUsageThreadDetail", () => ({
  ShareUsageThreadDetail: () => null,
}));

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

describe("automatic session analysis", () => {
  it("does not schedule paid work when a study opens", async () => {
    const rebuild = vi.fn().mockResolvedValue({ alreadyRunning: false });
    mockUseUsageInsights.mockReturnValue({
      breakdown: { totalSessions: 10, latestRun: null },
      rebuild,
    });
    render(
      <InsightsWorkbench
        scope={{ kind: "scenario", scenarioId: "study" }}
        cohortKey="study"
        testIdPrefix="study"
      />,
    );
    expect(rebuild).not.toHaveBeenCalled();
  });
});
