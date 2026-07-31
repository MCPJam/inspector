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

/**
 * Topic-map stub. The real component pulls in react-force-graph-2d and its own
 * rendering is covered by its own test file — but it is NOT stubbed to `null`,
 * because it owns the second writer of cluster chips: its community list calls
 * `onToggleChip({ kind: "cluster", … })`. The panel has no `filter` prop, so
 * that callback is the only way a map-originated community chip can enter the
 * panel's state, and seeding the state some other way would test a path the
 * product does not have. The stub therefore exposes exactly that one call.
 */
vi.mock("@/components/chatboxes/ChatboxTopicMapPanel", () => ({
  ChatboxTopicMapPanel: (props: {
    filter: UsageFilterState;
    onToggleChip: (chip: {
      kind: "cluster";
      clusterId: string;
      label?: string;
    }) => void;
  }) => (
    <button
      type="button"
      data-testid="map-community"
      data-map-chips={props.filter.chips.map(chipKey).join(" ")}
      onClick={() =>
        props.onToggleChip({
          kind: "cluster",
          clusterId: "cluster-map",
          label: "Password resets",
        })
      }
    >
      Select map community
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

describe("ChatboxUsagePanel cluster-chip provenance", () => {
  // Cluster chips have TWO writers: this grid's cell selection and the topic
  // map's community list. Stripping the cluster dimension wholesale to protect
  // the grid from its own output also discarded the map's — a filter the user
  // asked for. The strip is therefore scoped to the open cell, which is the
  // only provenance signal available (`selectedCell`).
  it("lets a map community chip narrow the grid when no cell is open", async () => {
    const user = userEvent.setup();
    renderInsightsPanel();

    await user.click(screen.getByTestId("map-community"));

    const keys = lastBreakdownChipKeys();
    expect(keys).toContain("cluster:cluster-map");
    expect(keys).toContain("synthetic:hide");
  });

  it("strips only the open cell's cluster, keeping a map community chip", async () => {
    // Both chips are in the same dimension, so only provenance can tell them
    // apart. The grid's own cluster goes; the map's stays.
    const user = userEvent.setup();
    renderInsightsPanel();

    await user.click(
      screen.getByRole("button", { name: /Unresolved: 5 sessions/ })
    );
    // The map chip has to arrive AFTER the cell selection: `selectCell` resets
    // the cluster dimension, so a chip added before it would already be gone.
    await user.click(screen.getByTestId("map-community"));

    const keys = lastBreakdownChipKeys();
    expect(keys).toContain("cluster:cluster-map");
    expect(keys).not.toContain("cluster:cluster-a");
    expect(keys).not.toContain("outcome:unresolved");
    expect(keys).toContain("synthetic:hide");
  });

  it("gives the map itself the unstripped filter", async () => {
    // The map dims from chips, not from the breakdown query, so it must see the
    // cell selection even though the breakdown does not.
    const user = userEvent.setup();
    renderInsightsPanel();

    await user.click(
      screen.getByRole("button", { name: /Unresolved: 5 sessions/ })
    );

    const mapChips = (
      screen.getByTestId("map-community").getAttribute("data-map-chips") ?? ""
    ).split(" ");
    expect(mapChips).toContain("cluster:cluster-a");
    expect(mapChips).toContain("outcome:unresolved");
  });

  it("clears the cell chips outright when the drill-down is closed", async () => {
    const user = userEvent.setup();
    renderInsightsPanel();

    const cell = screen.getByRole("button", {
      name: /Unresolved: 5 sessions/,
    });
    await user.click(cell);
    await user.click(
      screen.getByRole("button", { name: /Close cell drill-down/i })
    );

    // Nothing open, nothing highlighted, and no cluster narrowing left behind.
    expect(cell).toHaveAttribute("aria-pressed", "false");
    const keys = lastBreakdownChipKeys();
    expect(keys.some((key) => key.startsWith("cluster:"))).toBe(false);
    expect(keys.some((key) => key.startsWith("outcome:"))).toBe(false);
    expect(keys).toContain("synthetic:hide");
  });

  it("clears the cell chips when the open cell is re-clicked", async () => {
    const user = userEvent.setup();
    renderInsightsPanel();

    const cell = screen.getByRole("button", {
      name: /Unresolved: 5 sessions/,
    });
    await user.click(cell);
    await user.click(cell);

    expect(cell).toHaveAttribute("aria-pressed", "false");
    const keys = lastBreakdownChipKeys();
    expect(keys.some((key) => key.startsWith("cluster:"))).toBe(false);
    expect(keys.some((key) => key.startsWith("outcome:"))).toBe(false);
  });
});
