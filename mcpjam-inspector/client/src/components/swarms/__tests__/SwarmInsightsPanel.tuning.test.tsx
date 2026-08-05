/**
 * Tuning wiring for the swarm Insights view.
 *
 * The swarm scope is the one that can get this wrong in a way the chatbox
 * scope cannot: it builds no topic map, so the mutation rejects
 * `linkThreshold` outright. A control that offered the knob — or a panel that
 * forwarded it — would turn every rebuild into a validator error.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SwarmInsightsPanel } from "../SwarmInsightsPanel";
import { CLUSTER_TUNING_PRESETS, type ClusterTuning } from "@/lib/cluster-tuning";

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

vi.mock("@/hooks/useUsageInsights", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useUsageInsights: (...args: unknown[]) => mockUseUsageInsights(...args),
    useGoalOutcomeDrilldown: (...args: unknown[]) =>
      mockUseGoalOutcomeDrilldown(...args),
  };
});

// Stubbed to the one prop under test plus a trigger, so this file exercises the
// panel's forwarding rather than re-testing the control (which has its own).
vi.mock("@/components/chatboxes/ChatboxInsightsSankey", () => ({
  ChatboxInsightsSankey: ({
    onApplyTuning,
    showLinkThreshold,
  }: {
    onApplyTuning?: (t: ClusterTuning, o?: { force?: boolean }) => void;
    showLinkThreshold?: boolean;
  }) => (
    <>
      <span data-testid="show-link-threshold">{String(showLinkThreshold)}</span>
      <button
        type="button"
        onClick={() =>
          onApplyTuning?.({
            maxClusters: CLUSTER_TUNING_PRESETS.broad.maxClusters,
            minSeparation: CLUSTER_TUNING_PRESETS.broad.minSeparation,
          })
        }
      >
        apply tuning
      </button>
    </>
  ),
}));

let rebuild: ReturnType<typeof vi.fn>;

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

describe("SwarmInsightsPanel tuning", () => {
  it("does not offer the topic-map knob to a scope with no topic map", () => {
    render(<SwarmInsightsPanel projectId="proj-1" />);
    expect(screen.getByTestId("show-link-threshold")).toHaveTextContent(
      "false",
    );
  });

  it("forwards the applied tuning to the rebuild", async () => {
    const user = userEvent.setup();
    render(<SwarmInsightsPanel projectId="proj-1" />);
    await user.click(screen.getByRole("button", { name: "apply tuning" }));

    expect(rebuild).toHaveBeenCalledWith({
      tuning: {
        maxClusters: CLUSTER_TUNING_PRESETS.broad.maxClusters,
        minSeparation: CLUSTER_TUNING_PRESETS.broad.minSeparation,
      },
    });
    expect(toastMock.success).toHaveBeenCalledWith("Rebuild queued");
  });

  it("warns when a differently-tuned rebuild was already running", async () => {
    const user = userEvent.setup();
    rebuild.mockResolvedValue({
      runId: "run-1",
      status: "running",
      alreadyRunning: true,
      tuningMismatch: true,
    });
    render(<SwarmInsightsPanel projectId="proj-1" />);
    await user.click(screen.getByRole("button", { name: "apply tuning" }));

    expect(toastMock.warning).toHaveBeenCalledWith(
      expect.stringMatching(/not applied/i),
    );
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});
