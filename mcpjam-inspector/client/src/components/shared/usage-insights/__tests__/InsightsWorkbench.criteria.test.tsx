/**
 * Criterion scorecard in the Insights workbench.
 *
 * What these pin is the thing the shared components cannot: criterion chips
 * are ORDINARY filter chips, not flow-owned, so clicking one DOES narrow the
 * breakdown query. That is the opposite of a sankey selection, which is the
 * diagram's own output and is deliberately withheld from the query that draws
 * it — mixing the two up would either collapse the diagram or make the facet
 * click do nothing.
 *
 * The scorecard is its own section above the session flow — not behind a
 * Checks chip popover.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InsightsWorkbench } from "../InsightsWorkbench";
import { chipKey, type UsageFilterState } from "@/hooks/chatbox-usage-filters";
import type { CriterionFacet } from "@/hooks/useUsageInsights";

const { mockUseUsageInsights, mockUseGoalOutcomeDrilldown } = vi.hoisted(() => ({
  mockUseUsageInsights: vi.fn(),
  mockUseGoalOutcomeDrilldown: vi.fn(),
}));

// The workbench's freshness chip reads Convex directly. These suites render it
// outside a provider, and the chip's own query is chatbox-scoped (skipped on a
// swarm scope), so a stub client is the whole requirement.
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

vi.mock("@/components/shared/usage-insights/SessionFlowSankey", () => ({
  SessionFlowSankey: () => <div data-testid="sankey" />,
}));

vi.mock("@/components/shared/usage-insights/TopicMapPanel", () => ({
  TopicMapPanel: () => <div data-testid="topic-map-panel" />,
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

/**
 * Render the workbench the way `swarm-run-detail` mounts it, so these tests
 * keep asserting the swarm surface's wiring rather than the shared body's
 * defaults.
 */
function renderSwarmWorkbench(props: {
  projectId: string | null;
  journeyRunIds?: string[];
  urlSelection?: ReadonlyArray<{ dimension: string; clusterId: string }> | null;
  onSelectionChange?: (themes: unknown) => void;
  recommendationsSlot?: ReactNode;
} = { projectId: "proj-1" }) {
  const { projectId, journeyRunIds, ...rest } = props;
  return render(
    <InsightsWorkbench
      scope={
        projectId
          ? {
              kind: "swarm",
              projectId,
              ...(journeyRunIds?.length ? { journeyRunIds } : {}),
            }
          : null
      }
      cohortKey={`${projectId ?? ""}\0${(journeyRunIds ?? []).join("\0")}`}
      autoBackfillTopicMap
      emptyState={<div>Sign in to view swarm insights.</div>}
      testIdPrefix="swarm-insights"
      {...(rest as Record<string, unknown>)}
    />,
  );
}

beforeEach(() => {
  mockUseUsageInsights.mockReset();
  mockUseGoalOutcomeDrilldown
    .mockReset()
    .mockReturnValue({ drilldown: undefined, isLoading: false });
  withFacets(FACETS);
});

describe("InsightsWorkbench — criterion scorecard", () => {
  it("renders the scorecard as its own section above the session flow", () => {
    renderSwarmWorkbench({ projectId: "proj-1" });
    expect(screen.getByTestId("swarm-insights-scorecard")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Checks/ })).toBeNull();
    expect(screen.getByTestId("sankey")).toBeInTheDocument();
  });

  it("renders one row per criterion, named by label then by predicate kind", () => {
    renderSwarmWorkbench({ projectId: "proj-1" });
    expect(screen.getByText("Quick resolution")).toBeInTheDocument();
    // No author label ⇒ the predicate kind's label, never the raw uuid.
    expect(screen.getByText("Tool was called at least once")).toBeInTheDocument();
  });

  it("headlines a verdict-weighted score across every graded session", () => {
    renderSwarmWorkbench({ projectId: "proj-1" });
    // 13 passed of 20 graded verdicts — the 2 ungraded are outside the
    // denominator, and the score is per-verdict, not per-criterion.
    expect(screen.getByText("Score 65%")).toBeInTheDocument();
    // Neither criterion has a clean sheet (6 fails and 1 fail respectively).
    expect(
      screen.getByText(/0 \/ 2 criteria passing · 7\/20 graded checks failed/),
    ).toBeInTheDocument();
  });

  it("reports ungraded separately instead of folding it into the fail count", () => {
    renderSwarmWorkbench({ projectId: "proj-1" });
    // 6 failed out of the 10 GRADED — the 2 ungraded are named, not summed in.
    expect(screen.getByText(/6\/10 sessions failed/)).toBeInTheDocument();
    expect(screen.getByText(/2 not graded/)).toBeInTheDocument();
  });

  it("a fail click NARROWS the breakdown — criterion chips are not flow-owned", async () => {
    const user = userEvent.setup();
    renderSwarmWorkbench({ projectId: "proj-1" });
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
    renderSwarmWorkbench({ projectId: "proj-1" });
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
    renderSwarmWorkbench({ projectId: "proj-1" });
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
    renderSwarmWorkbench({ projectId: "proj-1" });
    await user.click(
      screen.getByRole("button", { name: /Quick resolution: 2 not graded/ }),
    );
    expect(lastBreakdownFilters().chips.map(chipKey)).toEqual([
      "criterion:crit-quick:ungraded",
    ]);
  });

  it("names each button with its criterion so identical counts stay distinguishable", () => {
    renderSwarmWorkbench({ projectId: "proj-1" });
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
    renderSwarmWorkbench({ projectId: "proj-1" });
    expect(screen.queryByTestId("swarm-insights-scorecard")).not.toBeInTheDocument();
    expect(screen.queryByText("Scorecard")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Findings" })).toBeNull();
  });

  it("renders nothing when the server predates criterionBreakdown", () => {
    withFacets(undefined);
    renderSwarmWorkbench({ projectId: "proj-1" });
    expect(screen.queryByTestId("swarm-insights-scorecard")).not.toBeInTheDocument();
    expect(screen.queryByText("Scorecard")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Findings" })).toBeNull();
  });
});

describe("InsightsWorkbench — Findings", () => {
  it("shows Findings when the scorecard renders", () => {
    renderSwarmWorkbench({ projectId: "proj-1" });
    expect(screen.getByRole("heading", { name: "Findings" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Scorecard" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Findings" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("shows Findings when only recommendations render", () => {
    withFacets([]);
    renderSwarmWorkbench({
      projectId: "proj-1",
      recommendationsSlot: (
        <div data-testid="run-insights-recommendations">
          <h3>Recommendations</h3>
          <p>Patterns to investigate across sessions</p>
        </div>
      ),
    });
    expect(screen.getByRole("heading", { name: "Findings" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recommendations" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Scorecard" })).toBeNull();
  });

  it("puts scorecard and recommendations in one Findings card", () => {
    renderSwarmWorkbench({
      projectId: "proj-1",
      recommendationsSlot: (
        <div data-testid="run-insights-recommendations">
          <h3>Recommendations</h3>
        </div>
      ),
    });
    const body = screen
      .getByTestId("swarm-insights-findings")
      .querySelector("[data-slot=findings-body]");
    expect(body).not.toBeNull();
    expect(body).toHaveClass("rounded-lg", "border", "divide-y", "overflow-y-auto");
    expect(body).toContainElement(
      screen.getByRole("heading", { name: "Scorecard" }),
    );
    expect(body).toContainElement(
      screen.getByRole("heading", { name: "Recommendations" }),
    );
  });

  it("is expanded by default so scorecard and recommendations are visible", () => {
    renderSwarmWorkbench({
      projectId: "proj-1",
      recommendationsSlot: (
        <div data-testid="run-insights-recommendations">
          <h3>Recommendations</h3>
        </div>
      ),
    });
    expect(screen.getByRole("button", { name: "Findings" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByRole("heading", { name: "Scorecard" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Recommendations" })).toBeVisible();
  });

  it("collapses and expands from the keyboard-accessible toggle", async () => {
    const user = userEvent.setup();
    renderSwarmWorkbench({
      projectId: "proj-1",
      recommendationsSlot: (
        <div data-testid="run-insights-recommendations">
          <h3>Recommendations</h3>
        </div>
      ),
    });
    const toggle = screen.getByRole("button", { name: "Findings" });

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("heading", { name: "Scorecard" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Recommendations" })).toBeNull();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("heading", { name: "Scorecard" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Recommendations" }),
    ).toBeInTheDocument();
  });
});
