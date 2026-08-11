/**
 * The tuning control has to survive the sankey's two early returns.
 *
 * A swarm that has never clustered is the state where choosing HOW it should
 * cluster matters most, and it is also the state that renders no flow — so
 * gating the settings on "there is a flow to look at" hid them exactly when
 * they were needed. These pin all three states.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionFlowSankey } from "../SessionFlowSankey";
import type { UsageBreakdown } from "@/hooks/useUsageInsights";

const EMPTY_BREAKDOWN = {
  sankey: { nodes: [], links: [] },
  latestRun: null,
} as unknown as UsageBreakdown;

function renderSankey(breakdown: UsageBreakdown | null | undefined) {
  return render(
    <SessionFlowSankey
      breakdown={breakdown}
      selection={null}
      onSelectNode={vi.fn()}
      onSelectLink={vi.fn()}
      onRebuild={vi.fn()}
      rebuildBusy={false}
      onApplyTuning={vi.fn()}
    />,
  );
}

describe("SessionFlowSankey tuning control placement", () => {
  it("offers the settings before anything has been clustered", () => {
    renderSankey(EMPTY_BREAKDOWN);
    expect(screen.getByText("No session flow yet")).toBeInTheDocument();
    expect(screen.getByTestId("cluster-tuning-trigger")).toBeInTheDocument();
  });

  it("offers the settings while the breakdown is still loading", () => {
    renderSankey(undefined);
    expect(screen.getByTestId("cluster-tuning-trigger")).toBeInTheDocument();
  });

  it("omits the control entirely when the surface passes no handler", () => {
    render(
      <SessionFlowSankey
        breakdown={EMPTY_BREAKDOWN}
        selection={null}
        onSelectNode={vi.fn()}
        onSelectLink={vi.fn()}
        onRebuild={vi.fn()}
        rebuildBusy={false}
      />,
    );
    expect(
      screen.queryByTestId("cluster-tuning-trigger"),
    ).not.toBeInTheDocument();
  });
});
