/**
 * Panel-level wiring for session-flow selection.
 *
 * Pins the regression the per-component tests could not see: the breakdown
 * query that RENDERS the flow must never receive the flow's own selection
 * chips. Those chips are the diagram's output — feeding them back re-runs the
 * scan filtered to the clicked node, which collapses the diagram to the single
 * path that was selected. The drill-down and the session list are the opposite:
 * narrowing to the selection is their entire job, so they must keep the full
 * filter. Only a test that renders the panel (where the two filters diverge)
 * can observe the difference, which is why this file exists alongside 50-odd
 * green component tests that missed it.
 *
 * The flow itself is stubbed down to the two callbacks the real component
 * fires. Driving it through recharts' SVG would test recharts' layout, not the
 * panel's filter plumbing, and jsdom gives ResponsiveContainer no dimensions to
 * lay anything out in.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatboxUsagePanel } from "../ChatboxUsagePanel";
import {
  chipKey,
  type InsightsSelection,
  type UsageFilterChip,
  type UsageFilterState,
} from "@/hooks/chatbox-usage-filters";
import type { GoalFacet, UsageBreakdown } from "@/hooks/useUsageInsights";

const { mockUseUsageInsights, mockUseGoalOutcomeDrilldown } = vi.hoisted(
  () => ({
    mockUseUsageInsights: vi.fn(),
    mockUseGoalOutcomeDrilldown: vi.fn(),
  }),
);

vi.mock("@/hooks/useUsageInsights", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useUsageInsights: (...args: unknown[]) => mockUseUsageInsights(...args),
    useGoalOutcomeDrilldown: (...args: unknown[]) =>
      mockUseGoalOutcomeDrilldown(...args),
  };
});

const CELL_A_UNRESOLVED: InsightsSelection = {
  goal: { clusterId: "cluster-a", label: "Invoice lookup" },
  outcome: "unresolved",
};
const UNLABELED_OUTCOME_CELL: InsightsSelection = {
  goal: { clusterId: "cluster-a", label: "Invoice lookup" },
  outcome: null,
};
const SENTIMENT_NODE: InsightsSelection = { sentiment: "frustrated" };

vi.mock("@/components/chatboxes/ChatboxInsightsSankey", () => ({
  ChatboxInsightsSankey: ({
    onSelectNode,
    onSelectLink,
  }: {
    onSelectNode: (selection: InsightsSelection) => void;
    onSelectLink: (selection: InsightsSelection) => void;
  }) => (
    <>
      <button type="button" onClick={() => onSelectNode(CELL_A_UNRESOLVED)}>
        pick goal outcome node
      </button>
      <button
        type="button"
        onClick={() => onSelectNode(UNLABELED_OUTCOME_CELL)}
      >
        pick unlabeled outcome node
      </button>
      <button type="button" onClick={() => onSelectNode(SENTIMENT_NODE)}>
        pick sentiment node
      </button>
      <button
        type="button"
        onClick={() =>
          onSelectLink({ outcome: "completed", sentiment: "frustrated" })
        }
      >
        pick discordant link
      </button>
    </>
  ),
}));

// The topic map pulls in react-force-graph-2d and owns no behavior under test
// here; its chip-driven dimming is covered by its own test file. It is stubbed
// down to the one thing this file needs: the `onToggleChip` callback the real
// map fires when a community is clicked, which writes a CLUSTER chip — the same
// dimension the flow's goal selection writes. That collision is what the
// map-originated tests below exercise.
vi.mock("@/components/chatboxes/ChatboxTopicMapPanel", () => ({
  ChatboxTopicMapPanel: ({
    onToggleChip,
  }: {
    onToggleChip: (chip: UsageFilterChip) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        onToggleChip({
          kind: "cluster",
          clusterId: "cluster-b",
          label: "Refund status",
        })
      }
    >
      pick map community
    </button>
  ),
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
    sankey: { nodes: [], links: [], foldedGoalCount: 0 },
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
  enabled?: boolean;
  filters?: UsageFilterState;
} {
  return mockUseGoalOutcomeDrilldown.mock.calls.at(-1)?.[0];
}

function renderInsightsPanel() {
  return render(
    <ChatboxUsagePanel
      chatbox={{ chatboxId: "chatbox-1" } as never}
      section="insights"
    />,
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
    drilldown: {
      sessions: [],
      nextBefore: null,
      total: 5,
      totalTruncated: false,
    },
    isLoading: false,
  });
});

describe("ChatboxUsagePanel flow selection", () => {
  it("never feeds the selection chips back into the breakdown query", async () => {
    const user = userEvent.setup();
    renderInsightsPanel();

    await user.click(
      screen.getByRole("button", { name: "pick goal outcome node" }),
    );

    const keys = lastBreakdownChipKeys();
    // The diagram's own selection must not filter the diagram's input…
    expect(keys).not.toContain("cluster:cluster-a");
    expect(keys.some((key) => key.startsWith("outcome:"))).toBe(false);
    // …while chips from other dimensions (here the forced synthetic:hide)
    // still narrow it.
    expect(keys).toContain("synthetic:hide");
  });

  it("gives the drill-down the full filter, selection chips included", async () => {
    const user = userEvent.setup();
    renderInsightsPanel();

    await user.click(
      screen.getByRole("button", { name: "pick goal outcome node" }),
    );

    const args = lastDrilldownArgs();
    expect(args.clusterId).toBe("cluster-a");
    expect(args.outcome).toBe("unresolved");
    const keys = (args.filters?.chips ?? []).map(chipKey);
    expect(keys).toContain("cluster:cluster-a");
    expect(keys).toContain("outcome:unresolved");
    expect(keys).toContain("synthetic:hide");
  });

  it("strips the breakdown filter again for an unlabeled node's sentinel chip", async () => {
    const user = userEvent.setup();
    renderInsightsPanel();

    await user.click(
      screen.getByRole("button", { name: "pick unlabeled outcome node" }),
    );

    const keys = lastBreakdownChipKeys();
    expect(keys).not.toContain("cluster:cluster-a");
    expect(keys.some((key) => key.startsWith("outcome:"))).toBe(false);
    // And the drill-down still gets the null-outcome selection.
    expect(lastDrilldownArgs().outcome).toBeNull();
  });

  it("opens the drill-down for a node with no goal", async () => {
    // The generalization: a sentiment node has no cluster, so the old
    // cell-shaped wiring would have skipped the query entirely.
    const user = userEvent.setup();
    renderInsightsPanel();

    await user.click(
      screen.getByRole("button", { name: "pick sentiment node" }),
    );

    const args = lastDrilldownArgs();
    expect(args.clusterId).toBeNull();
    expect(args.enabled).toBe(true);
    expect((args.filters?.chips ?? []).map(chipKey)).toContain(
      "sentiment:frustrated",
    );
    expect(lastBreakdownChipKeys()).not.toContain("sentiment:frustrated");
  });

  it("ANDs both endpoints for a link, and keeps them out of the breakdown", async () => {
    const user = userEvent.setup();
    renderInsightsPanel();

    await user.click(
      screen.getByRole("button", { name: "pick discordant link" }),
    );

    const drilldownKeys = (lastDrilldownArgs().filters?.chips ?? []).map(
      chipKey,
    );
    expect(drilldownKeys).toContain("outcome:completed");
    expect(drilldownKeys).toContain("sentiment:frustrated");

    const breakdownKeys = lastBreakdownChipKeys();
    expect(breakdownKeys).not.toContain("outcome:completed");
    expect(breakdownKeys).not.toContain("sentiment:frustrated");
  });

  it("closes the selection when the open node is clicked again", async () => {
    const user = userEvent.setup();
    renderInsightsPanel();

    const node = screen.getByRole("button", { name: "pick sentiment node" });
    await user.click(node);
    expect(lastDrilldownArgs().enabled).toBe(true);

    await user.click(node);
    expect(lastDrilldownArgs().enabled).toBe(false);
    expect(lastBreakdownChipKeys()).not.toContain("sentiment:frustrated");
  });

  // The flow is not the only writer of cluster chips: the topic map writes one
  // when a community is clicked, and the insights strip does too. Stripping the
  // cluster DIMENSION to keep the diagram from filtering itself therefore also
  // discarded those, and picking a community silently stopped narrowing it.
  // Only the open selection's own chips may be subtracted.
  it("keeps a map-originated cluster chip in the breakdown query when nothing is open", async () => {
    const user = userEvent.setup();
    renderInsightsPanel();

    await user.click(
      screen.getByRole("button", { name: "pick map community" }),
    );

    expect(lastBreakdownChipKeys()).toContain("cluster:cluster-b");
  });

  it("subtracts only the open selection's cluster chip, not a map community's", async () => {
    const user = userEvent.setup();
    renderInsightsPanel();

    // Selection first: applying one replaces any prior cluster narrowing, so a
    // map chip added before this click would legitimately be gone.
    await user.click(
      screen.getByRole("button", { name: "pick goal outcome node" }),
    );
    await user.click(
      screen.getByRole("button", { name: "pick map community" }),
    );

    const keys = lastBreakdownChipKeys();
    expect(keys).toContain("cluster:cluster-b");
    expect(keys).not.toContain("cluster:cluster-a");
    expect(keys.some((key) => key.startsWith("outcome:"))).toBe(false);
  });
});
