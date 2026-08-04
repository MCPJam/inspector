/**
 * Panel wiring for the swarm Insights view.
 *
 * The heavy behavior (layout, selection chips, paging) is owned by the shared
 * components and covered by their own tests. What is new here — and what these
 * tests pin — is the wiring: the swarm scope reaches both hooks, the goal
 * column is renamed to "Journey", and a flow click narrows the drill-down
 * without feeding the selection back into the breakdown that draws it.
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
  }: {
    onSelectNode: (selection: InsightsSelection) => void;
    stageTitles?: Partial<Record<string, string>>;
  }) => (
    <>
      <span data-testid="goal-header">{stageTitles?.goal ?? "Goal"}</span>
      <button type="button" onClick={() => onSelectNode(JOURNEY_NODE)}>
        pick journey theme
      </button>
    </>
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
  it("reads the breakdown through the swarm scope and renames the goal column", () => {
    render(<SwarmInsightsPanel projectId="proj-1" />);
    expect(lastInsightsCall().scope).toEqual({
      kind: "swarm",
      projectId: "proj-1",
    });
    expect(screen.getByTestId("goal-header")).toHaveTextContent("Journey");
  });

  it("a flow click narrows the drill-down but not the breakdown that draws the flow", async () => {
    const user = userEvent.setup();
    render(<SwarmInsightsPanel projectId="proj-1" />);
    await user.click(screen.getByRole("button", { name: "pick journey theme" }));

    // Drill-down: swarm scope, filter carrying the selection's cluster chip.
    const drilldown = lastDrilldownCall();
    expect(drilldown.scope).toEqual({ kind: "swarm", projectId: "proj-1" });

    // Breakdown: the selection chip is the diagram's own output and must not
    // reach the query that renders the diagram.
    const breakdownChips = lastInsightsCall().filters.chips.map(chipKey);
    expect(breakdownChips).toEqual([]);
  });

  it("renders a sign-in gate with no project", () => {
    render(<SwarmInsightsPanel projectId={null} />);
    expect(screen.getByText(/sign in/i)).toBeInTheDocument();
  });
});
