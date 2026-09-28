/**
 * The Monitoring pane serves TWO features on two flags, and gating only the
 * rail item leaks one through the other.
 *
 * A suite with both a schedule and a widget-probe case earns the pane from
 * EITHER flag (`suite-dashboard.tsx` ORs them). So with only `synthetic-
 * monitors` on, the pane opens — and without these props it would render its
 * "Scheduled runs" strip, its last-failure card and its "enable a schedule"
 * empty state, which is the whole surface `scheduled-evals-enabled` exists to
 * keep dark.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MonitoringTab } from "../monitoring-tab";

const state = vi.hoisted(() => ({
  stats: [] as Array<Record<string, unknown>>,
}));
vi.mock("convex/react", () => ({
  useQuery: () => state.stats,
}));

/** Two terminal scheduled runs, one failed, both carrying probe latency. */
function withStats() {
  state.stats = [
    {
      runId: "run_2",
      status: "completed",
      result: "failed",
      createdAt: 2,
      completedAt: 2,
      meanRenderLatencyMs: 120,
      probeIterations: 1,
      summary: { passed: 0, total: 1 },
    },
    {
      runId: "run_1",
      status: "completed",
      result: "passed",
      createdAt: 1,
      completedAt: 1,
      meanRenderLatencyMs: 90,
      probeIterations: 1,
      summary: { passed: 1, total: 1 },
    },
  ];
}

describe("MonitoringTab — one flag per half", () => {
  it("hides every scheduled-run section when only the probe half is allowed", () => {
    withStats();
    render(
      <MonitoringTab
        suiteId="suite-1"
        onRunClick={() => {}}
        showScheduledRuns={false}
        showProbeLatency
      />,
    );
    expect(screen.queryByText("Scheduled runs")).toBeNull();
    expect(screen.queryByText("Last failure")).toBeNull();
    expect(screen.getByText("Render latency")).toBeTruthy();
  });

  it("hides the probe latency trend when only the schedule half is allowed", () => {
    withStats();
    render(
      <MonitoringTab
        suiteId="suite-1"
        onRunClick={() => {}}
        showScheduledRuns
        showProbeLatency={false}
      />,
    );
    expect(screen.getByText("Scheduled runs")).toBeTruthy();
    expect(screen.getByText("Last failure")).toBeTruthy();
    expect(screen.queryByText("Render latency")).toBeNull();
  });

  // The empty state names the schedule and points at the row that enables one,
  // so it is schedule UI even with no run data behind it.
  it("renders no empty state for the probe half alone", () => {
    state.stats = [];
    const { container } = render(
      <MonitoringTab
        suiteId="suite-1"
        onRunClick={() => {}}
        showScheduledRuns={false}
        showProbeLatency
      />,
    );
    expect(screen.queryByText("No scheduled runs yet")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("still renders both halves when both flags are on", () => {
    withStats();
    render(
      <MonitoringTab
        suiteId="suite-1"
        onRunClick={() => {}}
        showScheduledRuns
        showProbeLatency
      />,
    );
    expect(screen.getByText("Scheduled runs")).toBeTruthy();
    expect(screen.getByText("Render latency")).toBeTruthy();
    expect(screen.getByText("Last failure")).toBeTruthy();
  });
});
