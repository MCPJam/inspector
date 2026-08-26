/**
 * Running-step session click → live stream pane.
 *
 * The create-flow matrix is the place to watch a just-launched swarm. Clicking
 * a session chip must open the shared SwarmLiveStreamPane on the right with
 * that session's selection — not leave the wizard.
 *
 * The finding rail is the other half: "Look now" has to hand the caller the
 * SESSION that produced the finding, not the generic leave callback.
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

/**
 * Sessions the run-live bridge sees. Empty by default: the matrix tests assert
 * the chip grid, which comes from the run snapshot, not from graded rows.
 */
let sessionsFixture: unknown[] = [];
const hostsFixture = [{ hostId: "host-1", name: "MCPJam" }];

/** One graded session with a failing check — the finding rail's only input. */
const failedSessionFixture = {
  id: "thread-fail",
  chatSessionId: "synth_run-1_host-1_0",
  projectId: "proj-1",
  hostId: "host-1",
  journeyRunId: "run-1",
  startedAt: 1,
  goalScore: { reason: "never called the refund tool" },
  criteria: {
    status: "completed" as const,
    generation: 1,
    results: [{ criterionId: "crit-refund", passed: false }],
  },
};

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
    results: sessionsFixture,
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
    sessionsFixture = [];
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
          onOpenSession={vi.fn()}
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
          onOpenSession={vi.fn()}
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

  /**
   * The bug this guards: "Look now" was wired to `onLeave`, so a finding
   * dumped the viewer on Overview with nothing identifying the session that
   * produced it. A finding you cannot trace back to a session is a claim, so the
   * assertion is on the session ID reaching the caller — not on navigation,
   * which the caller owns.
   */
  it("'Look now' opens the session that produced the finding, not a generic leave", async () => {
    sessionsFixture = [failedSessionFixture];
    const onLeave = vi.fn();
    const onOpenSession = vi.fn();

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
          fallbackColumns={[{ key: "environment:env-1", label: "Prod-like" }]}
          environments={[
            {
              environmentId: "env-1",
              projectId: "proj-1",
              name: "Prod-like",
              hostId: "host-1",
              revision: 1,
            },
          ]}
          onLeave={onLeave}
          onOpenSession={onOpenSession}
        />
      </div>
    );

    const finding = await screen.findByTestId("new-swarm-running-finding");
    expect(finding.textContent).toMatch(/never called the refund tool/);

    fireEvent.click(screen.getByTestId("new-swarm-running-finding-open"));
    // The criterion rides along with the session (BB-74): the wizard's line
    // says what was found, and the run page this leaves for has to be able to
    // repeat it rather than presenting an unexplained transcript.
    expect(onOpenSession).toHaveBeenCalledWith("thread-fail", "crit-refund");
    expect(onLeave).not.toHaveBeenCalled();
  });
});
