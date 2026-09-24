/**
 * BB-196, as it stands after per-session analysis (B3) and the provisional
 * door (B5): User Testing analyzes itself on the BACKEND. Each session is
 * analyzed a few minutes after its last message and again once it has been
 * quiet for thirty, with no client involved.
 *
 * So opening a study must not start paid work. The one voluntary action is
 * Analyze now, which the Session flow offers only where its reason can help.
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

// Stubbed: this file exercises what the workbench does on open, not what the
// diagram draws (that has its own suite).
vi.mock("@/components/shared/usage-insights/SessionFlowSankey", () => ({
  SessionFlowSankey: () => <span data-testid="session-flow" />,
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
