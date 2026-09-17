/**
 * Tuning wiring for the swarm Insights view.
 *
 * Re-clustering is hidden for now (`SHOW_RECLUSTERING_UI`). The workbench
 * still knows the topic-map knob exists; it just does not offer a handler
 * that would start another run.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InsightsWorkbench } from "../InsightsWorkbench";
import type { ClusterTuning } from "@/lib/cluster-tuning";

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

vi.mock("@/components/shared/usage-insights/TopicMapPanel", () => ({
  TopicMapPanel: () => <div data-testid="topic-map-panel" />,
}));

// Stubbed to the one prop under test plus a trigger, so this file exercises the
// panel's forwarding rather than re-testing the control (which has its own).
vi.mock("@/components/shared/usage-insights/SessionFlowSankey", () => ({
  SessionFlowSankey: ({
    onApplyTuning,
    showLinkThreshold,
    headerActions,
  }: {
    onApplyTuning?: (t: ClusterTuning, o?: { force?: boolean }) => void;
    showLinkThreshold?: boolean;
    headerActions?: React.ReactNode;
  }) => (
    <>
      {headerActions}
      <span data-testid="show-link-threshold">{String(showLinkThreshold)}</span>
      <span data-testid="has-apply-tuning">
        {String(Boolean(onApplyTuning))}
      </span>
    </>
  ),
}));

let rebuild: ReturnType<typeof vi.fn>;

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
  rebuild = vi.fn().mockResolvedValue({
    runId: "run-1",
    status: "queued",
    alreadyRunning: false,
  });
  mockUseUsageInsights.mockReset().mockReturnValue({
    threads: undefined,
    breakdown: null,
    rebuild,
  });
  mockUseGoalOutcomeDrilldown
    .mockReset()
    .mockReturnValue({ drilldown: undefined, isLoading: false });
});

describe("InsightsWorkbench tuning", () => {
  it("offers the topic-map link-threshold knob", () => {
    renderSwarmWorkbench({ projectId: "proj-1" });
    expect(screen.getByTestId("show-link-threshold")).toHaveTextContent(
      "true",
    );
  });

  it("does not forward a re-clustering handler while the control is hidden", () => {
    renderSwarmWorkbench({ projectId: "proj-1" });
    expect(screen.getByTestId("has-apply-tuning")).toHaveTextContent("false");
  });
});
