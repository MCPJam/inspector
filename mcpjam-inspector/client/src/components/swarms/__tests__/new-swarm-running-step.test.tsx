/**
 * Running-step session click → live stream pane.
 *
 * The create-flow matrix is the place to watch a just-launched swarm. Clicking
 * a session chip must open the shared SwarmLiveStreamPane on the right with
 * that session's selection — not leave the wizard.
 *
 * Findings is the other half: "Open findings" is always available, and
 * "Look now" on the first-finding ping leaves for Findings — not the session.
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

/** Mutable so one test can hand the pane a persisted, clock-anchored trace. */
const persistedState = {
  trace: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  spanError: null as string | null,
  pluginVersions: [] as unknown[],
};

vi.mock("@/components/swarms/use-persisted-session-trace", () => ({
  usePersistedSessionTrace: () => persistedState,
}));

const traceViewerProps = vi.fn();

vi.mock("@/components/evals/trace-viewer", () => ({
  TraceViewer: (props: Record<string, unknown>) => {
    traceViewerProps(props);
    return <div data-testid="trace-viewer-stub" />;
  },
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

import {
  NewSwarmRunningStep,
  swarmCellHeadline,
  swarmRunGoalLabel,
  swarmRunningTitle,
} from "../new-swarm-running-step";

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
    runFixture.status = "running";
    runFixture.summary = { total: 2, succeeded: 0, failed: 0, rateLimited: 0 };
    persistedState.trace = null;
    persistedState.loading = false;
    persistedState.error = null;
    persistedState.spanError = null;
    traceViewerProps.mockClear();
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
              label: "Async Documentation Writer · Refund a charge",
              goalLabel: "Refund a charge",
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
          onLeave={vi.fn()}
          onOpenSession={vi.fn()}
        />
      </div>
    );

    await screen.findByTestId("new-swarm-running-step");
    expect(screen.getByTestId("new-swarm-running-title")).toHaveTextContent(
      "Swarm running 0 of 2 sessions"
    );
    expect(
      screen.getByTestId("new-swarm-running-open-findings")
    ).toHaveTextContent("Open findings");
    expect(
      screen.queryByTestId("new-swarm-running-done"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^stop$/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("new-swarm-running-progress")).toHaveAttribute(
      "aria-valuenow",
      "0"
    );
    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(
      screen.queryByText(/select multiple environments/i)
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("new-swarm-running-stream")).toBeInTheDocument();
    expect(screen.getByTestId("swarm-live-pane-empty")).toBeInTheDocument();
    expect(screen.getByTestId("swarm-running-hero")).toBeInTheDocument();
    expect(
      screen.getByTestId("swarm-running-hero").querySelectorAll("img"),
    ).toHaveLength(3);
    const chips = await screen.findAllByTestId("new-swarm-running-session");
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent("Running: Refund a charge");
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
              label: "Async Documentation Writer · Refund a charge",
              goalLabel: "Refund a charge",
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
    expect(
      screen.queryByTestId("swarm-live-pane-empty"),
    ).not.toBeInTheDocument();
    const pane = screen.getByTestId("swarm-live-pane");
    expect(pane).toHaveTextContent(/Session #1/i);
    expect(pane).not.toHaveTextContent(/synth_/);
    expect(pane).not.toHaveTextContent(/Readiness:/i);
    expect(chips[0]).toHaveAttribute("aria-pressed", "true");
  });

  /**
   * BB-153's other half: re-anchored offsets tell you a prompt landed 8s in,
   * and only the wall-clock anchor tells you WHEN. `ShareUsageThreadDetail`
   * always passed one; this pane passed nothing, so the swarm view of a
   * session could say strictly less than the User Testing view of it.
   *
   * Read off the DISPLAYED trace, not off `persisted`, so a live stream's own
   * contiguously packed spans are never labelled with the persisted session's
   * clock.
   */
  it("hands the trace viewer the session's wall-clock anchor", async () => {
    persistedState.trace = {
      traceVersion: 1,
      messages: [],
      traceStartedAtMs: 1_000_000,
      traceEndedAtMs: 1_012_000,
    };

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
              label: "Async Documentation Writer · Refund a charge",
              goalLabel: "Refund a charge",
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
          onLeave={vi.fn()}
          onOpenSession={vi.fn()}
        />
      </div>,
    );

    const chips = await screen.findAllByTestId("new-swarm-running-session");
    fireEvent.click(chips[0]!);

    await waitFor(() => expect(traceViewerProps).toHaveBeenCalled());
    expect(traceViewerProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        traceStartedAtMs: 1_000_000,
        traceEndedAtMs: 1_012_000,
      }),
    );
  });

  /**
   * The ping is a notification, not the only door. "Look now" leaves for
   * Findings — the claim — not the session. Session evidence stays on the
   * swarm page. "Open findings" is already on the frame before any ping.
   */
  it("'Look now' and 'Open findings' leave for Findings, not the session", async () => {
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
              label: "Async Documentation Writer · Refund a charge",
              goalLabel: "Refund a charge",
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
    // Ping sits with the title, not under the matrix.
    expect(
      screen
        .getByTestId("new-swarm-running-title")
        .compareDocumentPosition(finding) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      finding.compareDocumentPosition(
        screen.getAllByTestId("new-swarm-running-session")[0]!
      ) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("new-swarm-running-finding-open"));
    // The criterion rides along with the session (BB-74): the wizard's line
    // says what was found, and the run page this leaves for has to be able to
    // repeat it rather than presenting an unexplained transcript.
    expect(onOpenSession).toHaveBeenCalledWith("thread-fail", "crit-refund");
    expect(onLeave).not.toHaveBeenCalled();

    // The button beside it is the one that goes to Findings, and it is a
    // DIFFERENT destination — that separation is the point of the pair.
    fireEvent.click(screen.getByTestId("new-swarm-running-open-findings"));
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(onOpenSession).toHaveBeenCalledTimes(1);
  });

  it("shows Done next to Open findings when the wave has finished", async () => {
    runFixture.status = "completed";
    runFixture.summary = { total: 2, succeeded: 2, failed: 0, rateLimited: 0 };
    const onLeave = vi.fn();

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
              label: "Async Documentation Writer · Refund a charge",
              goalLabel: "Refund a charge",
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
          onOpenSession={vi.fn()}
        />
      </div>
    );

    await screen.findByTestId("new-swarm-running-done");
    expect(
      screen.getByTestId("new-swarm-running-open-findings"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("new-swarm-running-done"));
    expect(onLeave).toHaveBeenCalledTimes(1);
  });
});

describe("NewSwarmRunningStep — frame copy", () => {
  it("titles the wave the way the running and finished frames do", () => {
    expect(
      swarmRunningTitle({
        allTerminal: false,
        succeeded: 0,
        rateLimited: 0,
        done: 0,
        total: 30,
      })
    ).toBe("Swarm running 0 of 30 sessions");
    expect(
      swarmRunningTitle({
        allTerminal: true,
        succeeded: 30,
        rateLimited: 0,
        done: 30,
        total: 30,
      })
    ).toBe("Swarm finished 30 of 30 sessions");
    expect(
      swarmRunningTitle({
        allTerminal: true,
        succeeded: 0,
        rateLimited: 0,
        done: 15,
        total: 15,
      })
    ).toBe("Swarm failed 0 of 15 sessions");
  });

  it("leads each cell with the goal, not a score chip", () => {
    expect(swarmRunGoalLabel({ label: "Ada · Refund a charge" })).toBe(
      "Refund a charge"
    );
    expect(
      swarmCellHeadline({
        outcome: "running",
        primary: "running",
        goal: "Refund a charge",
      })
    ).toBe("Running: Refund a charge");
    expect(
      swarmCellHeadline({
        outcome: "succeeded",
        primary: "3/3 pass",
        goal: "Refund a charge",
      })
    ).toBe("Run completed: All checks passed");
    expect(
      swarmCellHeadline({
        outcome: "rate_limited",
        primary: "2/3 pass",
        goal: "Refund a charge",
      })
    ).toBe("Run completed: Goal completion had mixed results");
  });
});
