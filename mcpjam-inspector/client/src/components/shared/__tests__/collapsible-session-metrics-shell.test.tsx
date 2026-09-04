import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMetricsAggregate } from "@/components/shared/session-metric-strip";
import { CollapsibleSessionMetricsShell } from "@/components/shared/collapsible-session-metrics-shell";

const metricsFixture: SessionMetricsAggregate = {
  sessionCount: 8,
  analyzedCount: 8,
  truncated: false,
  toolCallCount: 40,
  toolErrorCount: 20,
  toolErrorRate: 0.5,
  sessionsWithToolErrors: 4,
  topFailingTool: { toolName: "create_automation", errorCount: 1 },
  avgToolCallsPerSession: 0.5,
  latencyP50Ms: 42_200,
  latencyP95Ms: 88_700,
  avgTokensPerSession: 153_600,
  tokenSampleCount: 8,
  trend: [],
};

afterEach(() => {
  cleanup();
});

describe("CollapsibleSessionMetricsShell", () => {
  it("shows the full strip when expanded and hides it when collapsed", async () => {
    const user = userEvent.setup();
    const onExpandedChange = vi.fn();
    const { rerender } = render(
      <CollapsibleSessionMetricsShell
        expanded
        onExpandedChange={onExpandedChange}
        metrics={metricsFixture}
        testIdPrefix="swarm"
      >
        <div data-testid="strip-body">metrics grid</div>
      </CollapsibleSessionMetricsShell>,
    );

    expect(screen.getByTestId("strip-body")).toBeInTheDocument();
    expect(screen.getByText(/8 sessions in scope/i)).toBeInTheDocument();

    await user.click(screen.getByTestId("swarm-sessions-metric-toggle"));
    expect(onExpandedChange).toHaveBeenCalledWith(false);

    rerender(
      <CollapsibleSessionMetricsShell
        expanded={false}
        onExpandedChange={onExpandedChange}
        metrics={metricsFixture}
        testIdPrefix="swarm"
      >
        <div data-testid="strip-body">metrics grid</div>
      </CollapsibleSessionMetricsShell>,
    );

    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("42.2s")).toBeInTheDocument();
    expect(screen.getByTestId("swarm-sessions-metric-shell")).toHaveAttribute(
      "data-expanded",
      "false",
    );
  });

  it("renders an em dash for every nullable metric when collapsed", () => {
    render(
      <CollapsibleSessionMetricsShell
        expanded={false}
        onExpandedChange={vi.fn()}
        metrics={{
          ...metricsFixture,
          toolErrorRate: null,
          latencyP50Ms: null,
          avgToolCallsPerSession: null,
          avgTokensPerSession: null,
        }}
        testIdPrefix="swarm"
      >
        <div data-testid="strip-body">metrics grid</div>
      </CollapsibleSessionMetricsShell>,
    );

    // One chip per nullable metric: Errors, P50, Calls, Tokens.
    expect(screen.getAllByText("—")).toHaveLength(4);
  });

  it("takes the collapsed panel out of the accessibility tree", () => {
    const { rerender } = render(
      <CollapsibleSessionMetricsShell
        expanded
        onExpandedChange={vi.fn()}
        metrics={metricsFixture}
        testIdPrefix="swarm"
      >
        <div data-testid="strip-body">metrics grid</div>
      </CollapsibleSessionMetricsShell>,
    );
    const panel = document.getElementById("swarm-sessions-metric-panel")!;
    expect(panel).toHaveAttribute("aria-hidden", "false");

    rerender(
      <CollapsibleSessionMetricsShell
        expanded={false}
        onExpandedChange={vi.fn()}
        metrics={metricsFixture}
        testIdPrefix="swarm"
      >
        <div data-testid="strip-body">metrics grid</div>
      </CollapsibleSessionMetricsShell>,
    );
    expect(
      document.getElementById("swarm-sessions-metric-panel"),
    ).toHaveAttribute("aria-hidden", "true");
  });
});
