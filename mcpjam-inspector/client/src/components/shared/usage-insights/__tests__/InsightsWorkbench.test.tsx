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
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InsightsWorkbench } from "../InsightsWorkbench";
import {
  chipKey,
  type InsightsSelection,
  type UsageFilterState,
} from "@/hooks/scenario-usage-filters";

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

// The workbench's freshness chip reads Convex directly. These suites render it
// outside a provider, and the chip's own query is scenario-scoped (skipped on a
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

const JOURNEY_NODE: InsightsSelection = {
  themes: [
    { dimension: "goal", clusterId: "journey-1", label: "Draw a diagram" },
  ],
};

vi.mock("@/components/shared/usage-insights/SessionFlowSankey", () => ({
  SessionFlowSankey: ({
    onSelectNode,
    selection,
    stageTitles,
    headerActions,
    fillHeight,
  }: {
    onSelectNode: (selection: InsightsSelection) => void;
    selection?: InsightsSelection | null;
    stageTitles?: Partial<Record<string, string>>;
    headerActions?: React.ReactNode;
    fillHeight?: boolean;
  }) => (
    // Mirror the real component's `data-fill-height` marker so the workbench's
    // bodyLayout -> fillHeight wiring is assertable here.
    <div
      data-testid="mock-sankey"
      data-fill-height={fillHeight ? "true" : undefined}
    >
      <span data-testid="goal-header">{stageTitles?.goal ?? "Goal"}</span>
      <span data-testid="selected-themes">
        {(selection?.themes ?? []).map((theme) => theme.clusterId).join(",")}
      </span>
      {headerActions}
      <button type="button" onClick={() => onSelectNode(JOURNEY_NODE)}>
        pick journey theme
      </button>
    </div>
  ),
}));

vi.mock("@/components/shared/usage-insights/TopicMapPanel", () => ({
  TopicMapPanel: ({
    journeyRunIds,
    headerActions,
    filter,
  }: {
    journeyRunIds?: readonly string[];
    headerActions?: React.ReactNode;
    filter?: UsageFilterState;
  }) => (
    <div
      data-testid="topic-map-panel"
      data-filter-chips={(filter?.chips ?? []).map(chipKey).join(",")}
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
  bodyLayout?: "fill" | "scroll";
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
  vi.clearAllMocks();
  mockUseUsageInsights.mockReset().mockReturnValue({
    threads: undefined,
    breakdown: null,
    rebuild: vi.fn().mockResolvedValue({ alreadyRunning: false }),
  });
  mockUseGoalOutcomeDrilldown
    .mockReset()
    .mockReturnValue({ drilldown: undefined, isLoading: false });
});

describe("InsightsWorkbench", () => {
  it("reads the breakdown through the swarm scope with the shared Goal column", () => {
    renderSwarmWorkbench({ projectId: "proj-1" });
    expect(lastInsightsCall().scope).toEqual({
      kind: "swarm",
      projectId: "proj-1",
    });
    expect(screen.getByTestId("goal-header")).toHaveTextContent("Goal");
  });

  // bodyLayout is the contract this surface adds: "fill" (default) locks the
  // body to the viewport (Sankey fills + clips), "scroll" lets it grow to
  // content height so the swarm tab owns the scroll. The wiring under test is
  // that bodyLayout maps to the Sankey's fillHeight.
  it("fills the Sankey height in the default (fill) body layout", () => {
    renderSwarmWorkbench({ projectId: "proj-1" });
    expect(screen.getByTestId("mock-sankey")).toHaveAttribute(
      "data-fill-height",
      "true",
    );
  });

  it("lets the Sankey grow to content height when bodyLayout is scroll", () => {
    renderSwarmWorkbench({ projectId: "proj-1", bodyLayout: "scroll" });
    expect(screen.getByTestId("mock-sankey")).not.toHaveAttribute(
      "data-fill-height",
    );
  });

  it("does not render the retired criterion scorecard", () => {
    mockUseUsageInsights.mockReturnValue({
      threads: undefined,
      breakdown: {
        criterionBreakdown: [
          {
            criterionId: "criterion-1",
            label: "Quick resolution",
            passCount: 1,
            failCount: 1,
            ungradedCount: 0,
          },
        ],
        totalSessions: 2,
      },
      rebuild: vi.fn().mockResolvedValue({ alreadyRunning: false }),
    });

    renderSwarmWorkbench({ projectId: "proj-1" });

    expect(screen.queryByTestId("swarm-insights-scorecard")).toBeNull();
    expect(screen.queryByText("Scorecard")).toBeNull();
    expect(screen.getByTestId("goal-header")).toBeInTheDocument();
  });

  it("forwards journeyRunIds onto the swarm scope for a wave-scoped Sankey", () => {
    renderSwarmWorkbench({ projectId: "proj-1", journeyRunIds: ["run-a", "run-b"] });
    expect(lastInsightsCall().scope).toEqual({
      kind: "swarm",
      projectId: "proj-1",
      journeyRunIds: ["run-a", "run-b"],
    });
  });

  it("a flow click narrows the drill-down but not the breakdown that draws the flow", async () => {
    const user = userEvent.setup();
    renderSwarmWorkbench({ projectId: "proj-1", journeyRunIds: ["run-a"] });
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

  it("restores a URL selection and keeps it beside the Sankey", async () => {
    renderSwarmWorkbench({ projectId: "proj-1", urlSelection: [{ dimension: "goal", clusterId: "journey-1" }] });

    await waitFor(() =>
      expect(screen.getByTestId("selected-themes")).toHaveTextContent(
        "journey-1",
      ),
    );
    expect(screen.getByTestId("swarm-insights-drill-panel")).toBeInTheDocument();
    expect(lastDrilldownCall().enabled !== false).toBe(true);
  });

  it("persists click and close changes, including Escape", async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    renderSwarmWorkbench({ projectId: "proj-1", onSelectionChange });

    await user.click(screen.getByRole("button", { name: "pick journey theme" }));
    expect(onSelectionChange).toHaveBeenLastCalledWith([
      { dimension: "goal", clusterId: "journey-1", label: "Draw a diagram" },
    ]);
    await user.keyboard("{Escape}");
    expect(onSelectionChange).toHaveBeenLastCalledWith(null);
    // Hidden, not unmounted: the workbench adopts the User Testing contract,
    // where closing toggles the drill-down query's `enabled` instead of
    // tearing the component down and refetching on reopen.
    expect(screen.getByTestId("swarm-insights-drill-panel")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("fillViewport keeps the diagram visible beside the drill-down", async () => {
    const user = userEvent.setup();
    renderSwarmWorkbench({ projectId: "proj-1", journeyRunIds: ["run-a"] });
    const panel = screen.getByTestId("swarm-insights-panel");
    expect(panel.className).toContain("flex-col");
    expect(screen.queryByTestId("swarm-insights-statline")).toBeNull();
    expect(screen.queryByTestId("swarm-insights-rail")).toBeNull();
    expect(screen.getByTestId("goal-header")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "pick journey theme" }));
    expect(screen.getByTestId("swarm-insights-drill-panel")).toBeInTheDocument();
    expect(screen.getByTestId("goal-header")).toBeInTheDocument();
    expect(lastDrilldownCall().enabled !== false).toBe(true);
  });

  it("renders a sign-in gate with no project", () => {
    renderSwarmWorkbench({ projectId: null });
    expect(screen.getByText(/sign in/i)).toBeInTheDocument();
  });

  it("shows the empty state for a cohort with no sessions and no filter", () => {
    mockUseUsageInsights.mockReturnValue({
      threads: undefined,
      breakdown: { totalSessions: 0 },
      rebuild: vi.fn(),
    });
    renderSwarmWorkbench({ projectId: "proj-1" });
    expect(screen.getByText(/sign in/i)).toBeInTheDocument();
    expect(screen.queryByTestId("goal-header")).toBeNull();
  });

  it("keeps the workbench when a filter — not the cohort — empties the view", async () => {
    // Two criteria that never co-occur intersect to nothing. Swapping the
    // body for the empty state would take the chip row with it, leaving no
    // way to undo the filter that emptied the view.
    let totalSessions = 3;
    mockUseUsageInsights.mockImplementation(() => ({
      threads: undefined,
      breakdown: { totalSessions },
      rebuild: vi.fn(),
    }));
    const user = userEvent.setup();
    renderSwarmWorkbench({ projectId: "proj-1" });

    totalSessions = 0;
    await user.click(screen.getByRole("button", { name: "pick journey theme" }));

    expect(screen.queryByText(/sign in/i)).toBeNull();
    expect(screen.queryByTestId("swarm-insights-statline")).toBeNull();
    expect(screen.getByTestId("goal-header")).toBeInTheDocument();
  });

  it("does not carry a flow selection into the Clusters map", async () => {
    // The chip row hides flow-owned chips and the drill-down that explains
    // them is a flow-view affordance, so leaving them in the map's filter
    // would dim it from a selection with nothing on screen to name or clear —
    // including on a shared `?view=clusters&sel=…` link.
    const user = userEvent.setup();
    renderSwarmWorkbench({ projectId: "proj-1" });
    await user.click(screen.getByRole("button", { name: "pick journey theme" }));
    await user.click(screen.getByRole("button", { name: "Clusters" }));

    expect(screen.getByTestId("topic-map-panel")).toHaveAttribute(
      "data-filter-chips",
      "",
    );
  });

  it("toggles between Session flow and Clusters", async () => {
    const user = userEvent.setup();
    renderSwarmWorkbench({ projectId: "proj-1", journeyRunIds: ["run-a", "run-b"] });
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

  it("silently backfills once when Clusters opens and the done run has no map blob", async () => {
    const user = userEvent.setup();
    const rebuild = vi.fn().mockResolvedValue({
      runId: "run-2",
      status: "queued",
      alreadyRunning: false,
    });
    mockUseUsageInsights.mockReturnValue({
      threads: undefined,
      breakdown: {
        latestRun: {
          _id: "run-1",
          status: "done",
          startedAt: 1,
          finishedAt: 2,
          sessionCount: 10,
          clusterCount: 3,
          errorMessage: null,
          topicMapReady: false,
          isStale: false,
        },
      },
      rebuild,
    });

    renderSwarmWorkbench({ projectId: "proj-legacy" });
    expect(rebuild).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Clusters" }));
    await waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.info).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Session flow" }));
    await user.click(screen.getByRole("button", { name: "Clusters" }));
    await waitFor(() => expect(rebuild).toHaveBeenCalledTimes(1));
  });

  it("does not auto-backfill when the map blob is already ready", async () => {
    const user = userEvent.setup();
    const rebuild = vi.fn().mockResolvedValue({ alreadyRunning: false });
    mockUseUsageInsights.mockReturnValue({
      threads: undefined,
      breakdown: {
        latestRun: {
          _id: "run-1",
          status: "done",
          startedAt: 1,
          finishedAt: 2,
          sessionCount: 10,
          clusterCount: 3,
          errorMessage: null,
          topicMapReady: true,
          isStale: false,
        },
      },
      rebuild,
    });

    renderSwarmWorkbench({ projectId: "proj-ready" });
    await user.click(screen.getByRole("button", { name: "Clusters" }));
    await waitFor(() => {
      expect(screen.getByTestId("topic-map-panel")).toBeInTheDocument();
    });
    expect(rebuild).not.toHaveBeenCalled();
  });
});
