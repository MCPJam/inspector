/**
 * Run-banner tone for a terminal run that produced no sessions.
 *
 * The banner is the only thing most people read about a failed swarm, so what
 * it SAYS and how loudly it says it are both behaviour. A connect-time XAA
 * failure whose fix is "sign in again" must arrive as the server-named sentence
 * the server wrote, in the calm treatment — the dramatic red is reserved for
 * failures the user has to go and repair.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JourneyRun } from "@/lib/swarm-api";

const streamState = {
  sessions: {} as Record<string, unknown>,
  cellStatus: {} as Record<string, string>,
  runComplete: true,
  connected: false,
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

const attempt = {
  hostId: "host-1",
  targetId: "environment:env-1",
  sessionIdx: 0,
  status: "failed" as const,
  errorCode: null as string | null,
  errorMessage: null as string | null,
};

const runFixture = {
  _id: "run-1",
  status: "failed",
  summary: { total: 1, succeeded: 0, failed: 1, rateLimited: 0 },
  hostSummaries: [
    {
      hostId: "host-1",
      targetId: "environment:env-1",
      total: 1,
      succeeded: 0,
      failed: 1,
      rateLimited: 0,
    },
  ],
  snapshot: {
    sessionsPerTarget: 1,
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
  attempts: [attempt],
  createdAt: 1,
} as unknown as JourneyRun;

/** The counts a test can reshape — one terminal run's worth. */
const mutableRun = runFixture as unknown as {
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    rateLimited: number;
  };
  hostSummaries: Array<Record<string, unknown>>;
  snapshot: { sessionsPerTarget: number };
  attempts: unknown[];
};

vi.mock("convex/react", () => ({
  useQuery: (name: string) => {
    switch (name) {
      case "journeyRuns:getJourneyRun":
        return runFixture;
      case "hosts:listHosts":
        return [{ hostId: "host-1", name: "MCPJam" }];
      default:
        return undefined;
    }
  },
  usePaginatedQuery: () => ({
    results: [] as unknown[],
    status: "Exhausted",
    loadMore: vi.fn(),
    isLoading: false,
  }),
}));

import { NewSwarmRunningStep } from "../new-swarm-running-step";

const REAUTH_SENTENCE =
  'Your sign-in no longer proves your identity to "Billing MCP", so its enterprise access token couldn\'t be issued — sign in again, then re-run.';

function renderStep() {
  return render(
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
        onLeave={vi.fn()}
        onOpenSession={vi.fn()}
      />
    </div>
  );
}

describe("NewSwarmRunningStep — XAA failure banner", () => {
  beforeEach(() => {
    streamState.sessions = {};
    streamState.cellStatus = { "environment:env-1:0": "failed" };
    attempt.status = "failed";
    attempt.errorCode = null;
    attempt.errorMessage = null;
    mutableRun.summary = { total: 1, succeeded: 0, failed: 1, rateLimited: 0 };
    mutableRun.hostSummaries = [
      {
        hostId: "host-1",
        targetId: "environment:env-1",
        total: 1,
        succeeded: 0,
        failed: 1,
        rateLimited: 0,
      },
    ];
    mutableRun.snapshot.sessionsPerTarget = 1;
    mutableRun.attempts = [attempt];
  });

  it("renders a re-runnable auth failure calmly, naming the server and the fix", async () => {
    attempt.errorCode = "xaa_reauth_required";
    attempt.errorMessage = REAUTH_SENTENCE;

    renderStep();

    const banner = await screen.findByTestId("new-swarm-running-failure");
    expect(banner).toHaveTextContent(
      "No sessions ran — this run's authorization needs re-running."
    );
    expect(banner).toHaveTextContent("Billing MCP");
    expect(banner).toHaveTextContent("sign in again");
    // Calm, not catastrophic: amber, never the destructive treatment.
    expect(banner.className).toContain("amber");
    expect(banner.className).not.toContain("destructive");
  });

  it("keeps the destructive treatment for a failure the user must repair", async () => {
    attempt.errorCode = "xaa_configuration_invalid";
    attempt.errorMessage =
      'Server "Billing MCP" isn\'t fully configured for enterprise-managed authorization: Client ID is required.';

    renderStep();

    const banner = await screen.findByTestId("new-swarm-running-failure");
    expect(banner).toHaveTextContent("No sessions ran.");
    expect(banner).toHaveTextContent("Billing MCP");
    expect(banner.className).toContain("destructive");
  });

  it("stays quiet on a mixed run, where sessions did run", async () => {
    // Every line of this banner asserts that nothing ran. With one session
    // throttled and one clean it contradicted the title right above it, which
    // reads "Swarm finished 2 of 2 sessions".
    mutableRun.summary = { total: 2, succeeded: 1, failed: 0, rateLimited: 1 };
    mutableRun.hostSummaries = [
      {
        hostId: "host-1",
        targetId: "environment:env-1",
        total: 2,
        succeeded: 1,
        failed: 0,
        rateLimited: 1,
      },
    ];
    mutableRun.snapshot.sessionsPerTarget = 2;
    mutableRun.attempts = [
      {
        ...attempt,
        status: "rate_limited",
        errorMessage: "Failed after 3 attempts. Last error: Too Many Requests",
      },
      { ...attempt, sessionIdx: 1, status: "succeeded" },
    ];
    streamState.cellStatus = {
      "environment:env-1:0": "rate_limited",
      "environment:env-1:1": "succeeded",
    };

    renderStep();

    expect(await screen.findByTestId("new-swarm-running-title")).toHaveTextContent(
      "Swarm finished 2 of 2 sessions",
    );
    expect(screen.queryByTestId("new-swarm-running-failure")).toBeNull();
  });
});
