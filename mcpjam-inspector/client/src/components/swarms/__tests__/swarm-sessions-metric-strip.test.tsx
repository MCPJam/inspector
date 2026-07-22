import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * CONTRACT: the Sessions metric strip must subscribe to the backend query
 * `journeyRuns:getSwarmSessionMetrics` with `{ projectId }` (and add
 * `personaRefId` only when a persona filter is active). These are string-keyed
 * `as any` reads — no codegen catches a typo — so we intercept `useQuery` and
 * assert the exact (name, args) dispatched. We also assert the strip renders
 * null-safely: "—" for a missing token average, and nothing at all when there
 * are no sessions or the query is still loading.
 */

const queryCalls: Array<{ name: string; args: unknown }> = [];
let metricsFixture: unknown;

vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) => {
    queryCalls.push({ name, args });
    if (args === "skip") return undefined;
    return metricsFixture;
  },
}));

import { SwarmSessionsMetricStrip } from "../swarm-sessions-metric-strip";
import { SWARM_QUERIES, type SwarmSessionMetrics } from "@/lib/swarm-api";

function fullMetrics(
  overrides: Partial<SwarmSessionMetrics> = {},
): SwarmSessionMetrics {
  return {
    sessionCount: 12,
    analyzedCount: 12,
    truncated: false,
    toolCallCount: 100,
    toolErrorCount: 8,
    toolErrorRate: 0.08,
    sessionsWithToolErrors: 5,
    topFailingTool: { toolName: "search_web", errorCount: 4 },
    avgToolCallsPerSession: 8.3,
    latencyP50Ms: 10500,
    latencyP95Ms: 18500,
    avgTokensPerSession: 3200,
    tokenSampleCount: 12,
    trend: [
      {
        dayStartMs: 0,
        sessionCount: 6,
        toolErrorRate: 0.1,
        avgToolCallsPerSession: 8,
        latencyP50Ms: 10000,
        latencyP95Ms: 18000,
        avgTokensPerSession: 3000,
      },
      {
        dayStartMs: 86_400_000,
        sessionCount: 6,
        toolErrorRate: 0.06,
        avgToolCallsPerSession: 9,
        latencyP50Ms: 11000,
        latencyP95Ms: 19000,
        avgTokensPerSession: 3400,
      },
    ],
    ...overrides,
  };
}

afterEach(() => {
  queryCalls.length = 0;
  metricsFixture = undefined;
  cleanup();
});

const metricsCall = () =>
  queryCalls.find((c) => c.name === SWARM_QUERIES.getSwarmSessionMetrics);

describe("SwarmSessionsMetricStrip", () => {
  it("dispatches the metrics query with { projectId } when unfiltered", () => {
    metricsFixture = fullMetrics();
    render(<SwarmSessionsMetricStrip projectId="proj-1" personaRefId={null} />);
    expect(metricsCall()).toBeTruthy();
    expect(metricsCall()!.args).toEqual({ projectId: "proj-1" });
  });

  it("adds personaRefId to the args when a persona filter is active", () => {
    metricsFixture = fullMetrics();
    render(
      <SwarmSessionsMetricStrip projectId="proj-1" personaRefId="persona-9" />,
    );
    expect(metricsCall()!.args).toEqual({
      projectId: "proj-1",
      personaRefId: "persona-9",
    });
  });

  it("renders all four metric tiles including both latency percentiles", () => {
    metricsFixture = fullMetrics();
    render(<SwarmSessionsMetricStrip projectId="proj-1" personaRefId={null} />);
    expect(screen.getByTestId("swarm-sessions-metric-strip")).toBeTruthy();
    expect(screen.getByText("Tool errors")).toBeTruthy();
    expect(screen.getByText("Latency")).toBeTruthy();
    expect(screen.getByText("Tool calls")).toBeTruthy();
    expect(screen.getByText("Tokens")).toBeTruthy();
    expect(screen.getByText("P50")).toBeTruthy();
    expect(screen.getByText("P95")).toBeTruthy();
    expect(screen.getByText(/^8(\.0)?%$/)).toBeTruthy();
    expect(screen.getByText(/search_web/)).toBeTruthy();
  });

  it("surfaces a partial token sample as 'n of m sessions'", () => {
    metricsFixture = fullMetrics({ tokenSampleCount: 8, sessionCount: 12 });
    render(<SwarmSessionsMetricStrip projectId="proj-1" personaRefId={null} />);
    expect(screen.getByText("8 of 12 sessions")).toBeTruthy();
  });

  it("renders an em dash for a missing token average (backfill gap)", () => {
    metricsFixture = fullMetrics({
      avgTokensPerSession: null,
      tokenSampleCount: 0,
    });
    render(<SwarmSessionsMetricStrip projectId="proj-1" personaRefId={null} />);
    const strip = screen.getByTestId("swarm-sessions-metric-strip");
    expect(within(strip).getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });

  it("renders nothing when there are no sessions", () => {
    metricsFixture = fullMetrics({ sessionCount: 0 });
    const { container } = render(
      <SwarmSessionsMetricStrip projectId="proj-1" personaRefId={null} />,
    );
    expect(
      container.querySelector("[data-testid='swarm-sessions-metric-strip']"),
    ).toBeNull();
  });

  it("renders nothing while the query is loading (undefined)", () => {
    metricsFixture = undefined;
    const { container } = render(
      <SwarmSessionsMetricStrip projectId="proj-1" personaRefId={null} />,
    );
    expect(
      container.querySelector("[data-testid='swarm-sessions-metric-strip']"),
    ).toBeNull();
  });

  it("omits sparklines when the trend has fewer than two points", () => {
    metricsFixture = fullMetrics({ trend: [fullMetrics().trend[0]!] });
    render(<SwarmSessionsMetricStrip projectId="proj-1" personaRefId={null} />);
    expect(
      screen.queryByTestId("swarm-metric-sparkline-tool-errors"),
    ).toBeNull();
  });
});
