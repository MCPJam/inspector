/**
 * Running-step session click → live stream pane.
 *
 * The create-flow matrix is the place to watch a just-launched swarm. Clicking
 * a session chip must open the shared SwarmLiveStreamPane on the right with
 * that session's selection — not leave the wizard.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JourneyRun } from "@/lib/swarm-api";

const streamState = {
  sessions: {} as Record<string, unknown>,
  cellStatus: {} as Record<string, string>,
  runComplete: false,
  connected: true,
  error: null as string | null,
};

vi.mock("@/components/swarms/use-journey-run-stream", () => ({
  useJourneyRunStream: () => streamState,
  liveSessionTrace: () => null,
  swarmCellKey: (targetKey: string, sessionIndex: number) =>
    `${targetKey}:${sessionIndex}`,
}));

vi.mock("@/components/swarms/use-persisted-session-trace", () => ({
  usePersistedSessionTrace: () => ({
    trace: null,
    loading: false,
    error: null,
    pluginVersions: [],
  }),
}));

vi.mock("@/components/evals/trace-viewer", () => ({
  TraceViewer: () => <div data-testid="trace-viewer-stub" />,
}));

vi.mock("@/components/evals/trace-view-mode-tabs", () => ({
  TraceViewModeTabs: () => null,
}));

const runFixture: JourneyRun = {
  _id: "run-1",
  status: "running",
  summary: { total: 2, succeeded: 0, failed: 0, rateLimited: 0 },
  hostSummaries: [
    {
      hostId: "host-1",
      targetId: "environment:env-1",
      total: 2,
      succeeded: 0,
      failed: 0,
      rateLimited: 0,
    },
  ],
  snapshot: {
    sessionsPerTarget: 2,
    maxTurns: 6,
    hosts: [
      {
        hostId: "host-1",
        hostName: "MCPJam",
        targetId: "environment:env-1",
        environmentRef: {
          environmentId: "env-1",
          name: "Prod-like",
          revision: 1,
        },
      },
    ],
  },
  createdAt: 1,
} as JourneyRun;

const emptySessions: unknown[] = [];
const hostsFixture = [{ hostId: "host-1", name: "MCPJam" }];

vi.mock("convex/react", () => ({
  useQuery: (name: string) => {
    switch (name) {
      case "journeyRuns:getJourneyRun":
        return runFixture;
      case "hosts:listHosts":
        return hostsFixture;
      default:
        return undefined;
    }
  },
  usePaginatedQuery: () => ({
    results: emptySessions,
    status: "Exhausted",
    loadMore: vi.fn(),
    isLoading: false,
  }),
}));

import { NewSwarmRunningStep } from "../new-swarm-running-step";

describe("NewSwarmRunningStep — session stream pane", () => {
  beforeEach(() => {
    streamState.sessions = {};
    streamState.cellStatus = {
      "environment:env-1:0": "running",
      "environment:env-1:1": "pending",
    };
    streamState.connected = true;
    streamState.error = null;
    streamState.runComplete = false;
  });

  it("shows an empty stream pane until a session is clicked", async () => {
    render(
      <div className="h-[40rem]">
        <NewSwarmRunningStep
          projectId="proj-1"
          runs={[
            {
              runId: "run-1",
              journeyId: "j-1",
              personaId: "p-1",
              personaName: "Async Documentation Writer",
              personaRole: "Writer",
              label: "run",
            },
          ]}
          fallbackColumns={[
            { key: "environment:env-1", label: "Prod-like" },
          ]}
          environments={[
            {
              environmentId: "env-1",
              projectId: "proj-1",
              name: "Prod-like",
              hostId: "host-1",
              revision: 1,
            },
          ]}
          onLeave={vi.fn()}
        />
      </div>
    );

    await screen.findByTestId("new-swarm-running-step");
    expect(screen.getByTestId("new-swarm-running-stream")).toBeInTheDocument();
    expect(screen.getByTestId("swarm-live-pane-empty")).toBeInTheDocument();
    expect(
      await screen.findAllByTestId("new-swarm-running-session")
    ).toHaveLength(2);
  });

  it("opens the live stream pane when a session chip is clicked", async () => {
    render(
      <div className="h-[40rem]">
        <NewSwarmRunningStep
          projectId="proj-1"
          runs={[
            {
              runId: "run-1",
              journeyId: "j-1",
              personaId: "p-1",
              personaName: "Async Documentation Writer",
              personaRole: "Writer",
              label: "run",
            },
          ]}
          fallbackColumns={[
            { key: "environment:env-1", label: "Prod-like" },
          ]}
          environments={[
            {
              environmentId: "env-1",
              projectId: "proj-1",
              name: "Prod-like",
              hostId: "host-1",
              revision: 1,
            },
          ]}
          onLeave={vi.fn()}
        />
      </div>
    );

    const chips = await screen.findAllByTestId("new-swarm-running-session");
    fireEvent.click(chips[0]!);

    await waitFor(() => {
      expect(screen.getByTestId("swarm-live-pane")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("swarm-live-pane-empty")).not.toBeInTheDocument();
    expect(screen.getByText(/Session #1/i)).toBeInTheDocument();
    expect(chips[0]).toHaveAttribute("aria-pressed", "true");
  });
});
