/**
 * Panel-level wiring for goal × outcome cell selection.
 *
 * Pins the regression the per-component tests could not see: the breakdown
 * query that RENDERS the grid must never receive the grid's own cell-selection
 * chips. Those chips are the grid's output — feeding them back re-runs the
 * scan filtered to the clicked cell, which collapses the grid to a single row
 * whose other cells count 0 and disable. The drill-down and the session list
 * are the opposite: narrowing to the cell is their entire job, so they must
 * keep the full filter. Only a test that renders the panel (where the two
 * filters diverge) can observe the difference, which is why this file exists
 * alongside 50-odd green component tests that missed it.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatboxUsagePanel } from "../ChatboxUsagePanel";
import {
  chipKey,
  type UsageFilterState,
} from "@/hooks/chatbox-usage-filters";
import type { GoalFacet, UsageBreakdown } from "@/hooks/useUsageInsights";

const { mockUseUsageInsights, mockUseGoalOutcomeDrilldown } = vi.hoisted(
  () => ({
    mockUseUsageInsights: vi.fn(),
    mockUseGoalOutcomeDrilldown: vi.fn(),
  })
);

vi.mock("@/hooks/useUsageInsights", () => ({
  useUsageInsights: (...args: unknown[]) => mockUseUsageInsights(...args),
  useGoalOutcomeDrilldown: (...args: unknown[]) =>
    mockUseGoalOutcomeDrilldown(...args),
}));

// The topic map pulls in react-force-graph-2d and owns no behavior under test
// here; its chip-driven dimming is covered by its own test file.
vi.mock("@/components/chatboxes/ChatboxTopicMapPanel", () => ({
  ChatboxTopicMapPanel: () => null,
}));

// Sessions-tab components: imported by the panel but never rendered in the
// insights section; stubbed to keep the module graph out of this test.
vi.mock("@/components/connection/share-usage/ShareUsageThreadList", () => ({
  ShareUsageThreadList: () => null,
}));
vi.mock("@/components/connection/share-usage/ShareUsageThreadDetail", () => ({
  ShareUsageThreadDetail: () => null,
}));

function facet(overrides: Partial<GoalFacet> = {}): GoalFacet {
  return {
    clusterId: "cluster-a",
    label: "Invoice lookup",
    total: 10,
    outcomes: {
      completed: 3,
      partial: 0,
      unresolved: 5,
      errored: 2,
      unclear: 0,
    },
    unlabeled: 0,
    unresolvedRate: 0.7,
    errorRate: 0.2,
    retryRate: 0.4,
    toolDistribution: [],
    pathDistribution: [],
    distinctPathCount: 4,
    routingEntropy: 1.85,
    ...overrides,
  };
}

function breakdown(): UsageBreakdown {
  return {
    themes: [],
    userBreakdown: [],
    deviceBreakdown: [],
    languageBreakdown: [],
    modelBreakdown: [],
    outcomeBreakdown: [],
    frictionBreakdown: [],
    behaviorTagBreakdown: [],
    goalFacets: [facet()],
    labeledOutcomeCount: 10,
    outcomeFeedbackCalibration: [],
    totalSessions: 10,
    latestRun: null,
  };
}

/** Chip keys of the filter passed to the breakdown-backing hook, last render. */
function lastBreakdownChipKeys(): string[] {
  const call = mockUseUsageInsights.mock.calls.at(-1)?.[0] as {
    filters: UsageFilterState;
  };
  return call.filters.chips.map(chipKey);
}

/** The drill-down hook's args as of the last render. */
function lastDrilldownArgs(): {
  clusterId: string | null;
  outcome: unknown;
  filters?: UsageFilterState;
} {
  return mockUseGoalOutcomeDrilldown.mock.calls.at(-1)?.[0];
}

function renderInsightsPanel() {
  return render(
    <ChatboxUsagePanel
      chatbox={{ chatboxId: "chatbox-1" } as never}
      section="insights"
    />
  );
}

beforeEach(() => {
  mockUseUsageInsights.mockReset();
  mockUseGoalOutcomeDrilldown.mockReset();
  mockUseUsageInsights.mockReturnValue({
    threads: undefined,
    breakdown: breakdown(),
    rebuild: vi.fn(),
  });
  mockUseGoalOutcomeDrilldown.mockReturnValue({
    drilldown: { sessions: [], nextBefore: null, total: 5, totalTruncated: false },
    isLoading: false,
  });
});

describe("ChatboxUsagePanel cell selection", () => {
  it("never feeds the cell-selection chips back into the breakdown query", async () => {
    const user = userEvent.setup();
    renderInsightsPanel();

    await user.click(
      screen.getByRole("button", { name: /Unresolved: 5 sessions/ })
    );

    const keys = lastBreakdownChipKeys();
    // The grid's own selection must not filter the grid's input…
    expect(keys).not.toContain("cluster:cluster-a");
    expect(keys.some((key) => key.startsWith("outcome:"))).toBe(false);
    // …while chips from other dimensions (here the forced synthetic:hide)
    // still narrow it.
    expect(keys).toContain("synthetic:hide");
  });

  it("gives the drill-down the full filter, cell chips included", async () => {
    const user = userEvent.setup();
    renderInsightsPanel();

    await user.click(
      screen.getByRole("button", { name: /Unresolved: 5 sessions/ })
    );

    const args = lastDrilldownArgs();
    expect(args.clusterId).toBe("cluster-a");
    expect(args.outcome).toBe("unresolved");
    const keys = (args.filters?.chips ?? []).map(chipKey);
    expect(keys).toContain("cluster:cluster-a");
    expect(keys).toContain("outcome:unresolved");
    expect(keys).toContain("synthetic:hide");
  });

  it("still highlights the selected cell even though the breakdown filter is stripped", async () => {
    // The grid's highlight reads the UNstripped user filter; stripping must
    // apply to the breakdown query alone.
    const user = userEvent.setup();
    renderInsightsPanel();

    const cell = screen.getByRole("button", {
      name: /Unresolved: 5 sessions/,
    });
    await user.click(cell);
    expect(cell).toHaveAttribute("aria-pressed", "true");
  });

  it("strips the breakdown filter again for the not-analyzed cell's sentinel chip", async () => {
    mockUseUsageInsights.mockReturnValue({
      threads: undefined,
      breakdown: {
        ...breakdown(),
        goalFacets: [facet({ unlabeled: 4 })],
      },
      rebuild: vi.fn(),
    });
    const user = userEvent.setup();
    renderInsightsPanel();

    await user.click(
      screen.getByRole("button", { name: /not analyzed: 4 sessions/ })
    );

    const keys = lastBreakdownChipKeys();
    expect(keys).not.toContain("cluster:cluster-a");
    expect(keys.some((key) => key.startsWith("outcome:"))).toBe(false);
    // And the drill-down still gets the null-outcome cell.
    expect(lastDrilldownArgs().outcome).toBeNull();
  });
});
