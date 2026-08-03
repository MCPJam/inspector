/**
 * Criterion facet cards in the swarm Insights view.
 *
 * What these pin is the thing the shared components cannot: criterion chips
 * are ORDINARY filter chips, not flow-owned, so clicking one DOES narrow the
 * breakdown query. That is the opposite of a sankey selection, which is the
 * diagram's own output and is deliberately withheld from the query that draws
 * it — mixing the two up would either collapse the diagram or make the facet
 * click do nothing.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SwarmInsightsPanel } from "../SwarmInsightsPanel";
import { chipKey, type UsageFilterState } from "@/hooks/chatbox-usage-filters";
import type { CriterionFacet } from "@/hooks/useUsageInsights";

const { mockUseUsageInsights, mockUseGoalOutcomeDrilldown } = vi.hoisted(() => ({
  mockUseUsageInsights: vi.fn(),
  mockUseGoalOutcomeDrilldown: vi.fn(),
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

vi.mock("@/components/chatboxes/ChatboxInsightsSankey", () => ({
  ChatboxInsightsSankey: () => <div data-testid="sankey" />,
}));

const FACETS: CriterionFacet[] = [
  {
    criterionId: "crit-quick",
    label: "Quick resolution",
    kind: "turnCountUnder",
    passCount: 4,
    failCount: 6,
    ungradedCount: 2,
  },
  {
    criterionId: "crit-search",
    kind: "toolCalledAtLeastOnce",
    passCount: 9,
    failCount: 1,
    ungradedCount: 0,
  },
];

function withFacets(facets: CriterionFacet[] | undefined) {
  mockUseUsageInsights.mockReturnValue({
    threads: undefined,
    breakdown: facets === undefined ? null : { criterionBreakdown: facets },
    rebuild: vi.fn().mockResolvedValue({ alreadyRunning: false }),
  });
}

function lastBreakdownFilters(): UsageFilterState {
  return (mockUseUsageInsights.mock.calls.at(-1)?.[0] as { filters: UsageFilterState })
    .filters;
}

beforeEach(() => {
  mockUseUsageInsights.mockReset();
  mockUseGoalOutcomeDrilldown
    .mockReset()
    .mockReturnValue({ drilldown: undefined, isLoading: false });
  withFacets(FACETS);
});

describe("SwarmInsightsPanel — criterion facets", () => {
  it("renders one card per criterion, named by label then by predicate kind", () => {
    render(<SwarmInsightsPanel projectId="proj-1" />);
    expect(screen.getByText("Quick resolution")).toBeInTheDocument();
    // No author label ⇒ the predicate kind's label, never the raw uuid.
    expect(screen.getByText("Tool was called at least once")).toBeInTheDocument();
  });

  it("reports ungraded separately instead of folding it into the fail count", () => {
    render(<SwarmInsightsPanel projectId="proj-1" />);
    // 6 failed out of the 10 GRADED — the 2 ungraded are named, not summed in.
    expect(screen.getByText(/6\/10 sessions failed/)).toBeInTheDocument();
    expect(screen.getByText(/2 not graded/)).toBeInTheDocument();
  });

  it("a fail click NARROWS the breakdown — criterion chips are not flow-owned", async () => {
    const user = userEvent.setup();
    render(<SwarmInsightsPanel projectId="proj-1" />);
    expect(lastBreakdownFilters().chips).toEqual([]);

    // The fail count is the primary affordance.
    await user.click(
      screen.getByRole("button", { name: "Quick resolution: 6 failed" }),
    );

    expect(lastBreakdownFilters().chips.map(chipKey)).toEqual([
      "criterion:crit-quick:fail",
    ]);
  });

  it("chips for two DIFFERENT criteria stack, so the cohort narrows", async () => {
    const user = userEvent.setup();
    render(<SwarmInsightsPanel projectId="proj-1" />);
    await user.click(
      screen.getByRole("button", { name: "Quick resolution: 6 failed" }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Tool was called at least once: 1 failed",
      }),
    );

    expect(lastBreakdownFilters().chips.map(chipKey)).toEqual([
      "criterion:crit-quick:fail",
      "criterion:crit-search:fail",
    ]);
  });

  it("clicking the same chip again removes it", async () => {
    const user = userEvent.setup();
    render(<SwarmInsightsPanel projectId="proj-1" />);
    await user.click(
      screen.getByRole("button", { name: "Quick resolution: 6 failed" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Quick resolution: 6 failed" }),
    );
    expect(lastBreakdownFilters().chips).toEqual([]);
  });

  it("makes the ungraded count clickable — it is the question the number provokes", async () => {
    const user = userEvent.setup();
    render(<SwarmInsightsPanel projectId="proj-1" />);
    await user.click(
      screen.getByRole("button", { name: /Quick resolution: 2 not graded/ }),
    );
    expect(lastBreakdownFilters().chips.map(chipKey)).toEqual([
      "criterion:crit-quick:ungraded",
    ]);
  });

  it("names each button with its criterion so identical counts stay distinguishable", () => {
    render(<SwarmInsightsPanel projectId="proj-1" />);
    // Both cards would otherwise expose bare "N failed" / "N passed" names.
    expect(
      screen.getByRole("button", { name: "Quick resolution: 6 failed" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Tool was called at least once: 1 failed",
      }),
    ).toBeInTheDocument();
  });

  it("renders nothing at all when no run in the window carried a rubric", () => {
    withFacets([]);
    render(<SwarmInsightsPanel projectId="proj-1" />);
    expect(screen.queryByText("Pass criteria")).not.toBeInTheDocument();
  });

  it("renders nothing when the server predates criterionBreakdown", () => {
    withFacets(undefined);
    render(<SwarmInsightsPanel projectId="proj-1" />);
    expect(screen.queryByText("Pass criteria")).not.toBeInTheDocument();
  });
});
