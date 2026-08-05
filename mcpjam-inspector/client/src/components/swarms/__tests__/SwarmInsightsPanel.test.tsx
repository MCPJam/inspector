/**
 * Panel wiring for the swarm Insights view.
 *
 * The heavy behavior (layout, selection chips, paging) is owned by the shared
 * components and covered by their own tests. What is new here — and what these
 * tests pin — is the wiring: the swarm scope reaches both hooks, the goal
 * column keeps the shared "Goal" label, and a flow click narrows the
 * drill-down without feeding the selection back into the breakdown that
 * draws it.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SwarmInsightsPanel } from "../SwarmInsightsPanel";
import {
  chipKey,
  type InsightsSelection,
  type UsageFilterState,
} from "@/hooks/chatbox-usage-filters";

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

const JOURNEY_NODE: InsightsSelection = {
  themes: [
    { dimension: "goal", clusterId: "journey-1", label: "Draw a diagram" },
  ],
};

vi.mock("@/components/chatboxes/ChatboxInsightsSankey", () => ({
  ChatboxInsightsSankey: ({
    onSelectNode,
    stageTitles,
    headerActions,
  }: {
    onSelectNode: (selection: InsightsSelection) => void;
    stageTitles?: Partial<Record<string, string>>;
    headerActions?: React.ReactNode;
  }) => (
    <>
      <span data-testid="goal-header">{stageTitles?.goal ?? "Goal"}</span>
      {headerActions}
      <button type="button" onClick={() => onSelectNode(JOURNEY_NODE)}>
        pick journey theme
      </button>
    </>
  ),
}));

vi.mock("@/components/chatboxes/ChatboxTopicMapPanel", () => ({
  ChatboxTopicMapPanel: ({
    journeyRunIds,
    headerActions,
  }: {
    journeyRunIds?: readonly string[];
    headerActions?: React.ReactNode;
  }) => (
    <div
      data-testid="topic-map-panel"
      data-journey-run-ids={(journeyRunIds ?? []).join(",")}
    >
      {headerActions}
    </div>
  ),
}));

function lastInsightsCall() {
  return mockUseUsageInsights.mock.calls.at(-1)?.[0] as {
    scope: unknown;
    filters: UsageFilterState;
  };
}

function lastDrilldownCall() {
  return mockUseGoalOutcomeDrilldown.mock.calls.at(-1)?.[0] as {
    scope: unknown;
    filters?: UsageFilterState;
    enabled?: boolean;
  };
}

beforeEach(() => {
  mockUseUsageInsights.mockReset().mockReturnValue({
    threads: undefined,
    breakdown: null,
    rebuild: vi.fn().mockResolvedValue({ alreadyRunning: false }),
  });
  mockUseGoalOutcomeDrilldown
    .mockReset()
    .mockReturnValue({ drilldown: undefined, isLoading: false });
});

describe("SwarmInsightsPanel", () => {
  it("reads the breakdown through the swarm scope with the shared Goal column", () => {
    render(<SwarmInsightsPanel projectId="proj-1" />);
    expect(lastInsightsCall().scope).toEqual({
      kind: "swarm",
      projectId: "proj-1",
    });
    expect(screen.getByTestId("goal-header")).toHaveTextContent("Goal");
  });

  it("forwards journeyRunIds onto the swarm scope for a wave-scoped Sankey", () => {
    render(
      <SwarmInsightsPanel
        projectId="proj-1"
        journeyRunIds={["run-a", "run-b"]}
      />,
    );
    expect(lastInsightsCall().scope).toEqual({
      kind: "swarm",
      projectId: "proj-1",
      journeyRunIds: ["run-a", "run-b"],
    });
  });

  it("a flow click narrows the drill-down but not the breakdown that draws the flow", async () => {
    const user = userEvent.setup();
    render(
      <SwarmInsightsPanel projectId="proj-1" journeyRunIds={["run-a"]} />,
    );
    await user.click(screen.getByRole("button", { name: "pick journey theme" }));

    // Drill-down: swarm scope, filter carrying the selection's cluster chip.
    const drilldown = lastDrilldownCall();
    expect(drilldown.scope).toEqual({
      kind: "swarm",
      projectId: "proj-1",
      journeyRunIds: ["run-a"],
    });

    // Breakdown: the selection chip is the diagram's own output and must not
    // reach the query that renders the diagram.
    const breakdownChips = lastInsightsCall().filters.chips.map(chipKey);
    expect(breakdownChips).toEqual([]);
  });

  it("fillViewport swaps the bottom pane to the drill-down instead of stacking", async () => {
    const user = userEvent.setup();
    render(
      <SwarmInsightsPanel projectId="proj-1" journeyRunIds={["run-a"]} fillViewport>
        <div data-testid="idle-footer">findings</div>
      </SwarmInsightsPanel>,
    );
    expect(screen.getByTestId("idle-footer")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "pick journey theme" }));
    expect(screen.queryByTestId("idle-footer")).toBeNull();
    expect(lastDrilldownCall().enabled !== false).toBe(true);
  });

  it("renders a sign-in gate with no project", () => {
    render(<SwarmInsightsPanel projectId={null} />);
    expect(screen.getByText(/sign in/i)).toBeInTheDocument();
  });

  it("toggles between Session flow and Clusters", async () => {
    const user = userEvent.setup();
    render(
      <SwarmInsightsPanel
        projectId="proj-1"
        journeyRunIds={["run-a", "run-b"]}
        fillViewport
      />,
    );
    expect(screen.getByTestId("goal-header")).toBeInTheDocument();
    expect(screen.queryByTestId("topic-map-panel")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Clusters" }));
    expect(screen.getByTestId("topic-map-panel")).toBeInTheDocument();
    expect(screen.getByTestId("topic-map-panel")).toHaveAttribute(
      "data-journey-run-ids",
      "run-a,run-b",
    );
    expect(screen.queryByTestId("goal-header")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Session flow" }));
    expect(screen.getByTestId("goal-header")).toBeInTheDocument();
    expect(screen.queryByTestId("topic-map-panel")).toBeNull();
  });
});
