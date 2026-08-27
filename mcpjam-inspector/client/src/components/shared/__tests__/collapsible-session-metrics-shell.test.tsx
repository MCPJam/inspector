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
});
