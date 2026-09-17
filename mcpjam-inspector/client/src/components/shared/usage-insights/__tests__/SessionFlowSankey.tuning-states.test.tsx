/**
 * Re-clustering is hidden for now (`SHOW_RECLUSTERING_UI`), including on the
 * sankey's two early returns. These pin that the Balanced control stays off
 * in every state, not only when a flow is already on screen.
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
  it("hides the settings before anything has been clustered", () => {
    renderSankey(EMPTY_BREAKDOWN);
    expect(screen.getByText("No session flow yet")).toBeInTheDocument();
    expect(
      screen.queryByTestId("cluster-tuning-trigger"),
    ).not.toBeInTheDocument();
  });

  it("hides the settings while the breakdown is still loading", () => {
    renderSankey(undefined);
    expect(
      screen.queryByTestId("cluster-tuning-trigger"),
    ).not.toBeInTheDocument();
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
