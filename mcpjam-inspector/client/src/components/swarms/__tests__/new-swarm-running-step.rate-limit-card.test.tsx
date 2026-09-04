/**
 * BB-172: a 429 on the user's OWN provider key, surfaced per session.
 *
 * Two failures look identical here and need opposite advice. MCPJam's account
 * limit is lifted by credit or BYOK; a provider throttling the user's own key
 * is lifted by waiting or switching model, and no MCPJam purchase touches it.
 * Only the second gets this card — offering a billing CTA for the first would
 * be a false promise, which is the whole reason the ticket rejects a modal.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  chatSessionId: "",
  status: "rate_limited" as const,
  errorCode: null as string | null,
  errorMessage: null as string | null,
};

const sessionRow = {
  id: "s-1",
  chatSessionId: "",
  projectId: "proj-1",
  hostId: "host-1",
  journeyRunId: "run-1",
  status: "rate_limited",
  modelId: "anthropic/claude-opus-5",
  startedAt: 1,
};

const HOST_ENV_1 = {
  hostId: "host-1",
  hostName: "MCPJam",
  targetId: "environment:env-1",
  environmentRef: { environmentId: "env-1", name: "Prod-like", revision: 1 },
};

const SUMMARY_ENV_1 = {
  hostId: "host-1",
  targetId: "environment:env-1",
  total: 1,
  succeeded: 0,
  failed: 0,
  rateLimited: 1,
};

/** Mutable so a test can describe more than one target on the same host. */
let attempts: Record<string, unknown>[] = [attempt];
let sessionRows: Record<string, unknown>[] = [sessionRow];
let snapshotHosts: Record<string, unknown>[] = [HOST_ENV_1];
let hostSummaries: Record<string, unknown>[] = [SUMMARY_ENV_1];

const runFixture = {
  _id: "run-1",
  status: "completed",
  summary: { total: 1, succeeded: 0, failed: 0, rateLimited: 1 },
  get hostSummaries() {
    return hostSummaries;
  },
  snapshot: {
    sessionsPerTarget: 1,
    maxTurns: 6,
    get hosts() {
      return snapshotHosts;
    },
  },
  get attempts() {
    return attempts;
  },
  createdAt: 1,
} as unknown as JourneyRun;

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
    results: sessionRows,
    status: "Exhausted",
    loadMore: vi.fn(),
    isLoading: false,
  }),
}));

import { NewSwarmRunningStep } from "../new-swarm-running-step";
import { swarmAttemptChatSessionId } from "@/lib/swarm-api";

const CHAT_SESSION_ID = swarmAttemptChatSessionId(
  "run-1",
  { hostId: "host-1", environmentId: "env-1" },
  0,
);

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
    </div>,
  );
}

async function openTheSession() {
  const chips = await screen.findAllByTestId("new-swarm-running-session");
  fireEvent.click(chips[0]!);
  await waitFor(() => {
    expect(screen.getByTestId("swarm-live-pane")).toBeInTheDocument();
  });
}

describe("NewSwarmRunningStep — provider rate-limit card", () => {
  beforeEach(() => {
    attempts = [attempt];
    sessionRows = [sessionRow];
    snapshotHosts = [HOST_ENV_1];
    hostSummaries = [SUMMARY_ENV_1];
    attempt.chatSessionId = CHAT_SESSION_ID;
    sessionRow.chatSessionId = CHAT_SESSION_ID;
    sessionRow.modelId = "anthropic/claude-opus-5";
    attempt.status = "rate_limited";
    attempt.errorCode = null;
    attempt.errorMessage = null;
    streamState.cellStatus = { "environment:env-1:0": "rate_limited" };
    streamState.sessions = {
      [CHAT_SESSION_ID]: {
        envelope: {
          runId: "run-1",
          hostId: "host-1",
          targetId: "environment:env-1",
          chatSessionId: CHAT_SESSION_ID,
          sessionIndex: 0,
        },
        attemptStatus: "rate_limited",
        errorMessage: "429 Too Many Requests",
        notices: [],
        stream: {},
      },
    };
  });

  it("names the provider from the session's model, using the ticket's copy", async () => {
    renderStep();
    await openTheSession();

    const card = await screen.findByTestId("swarm-live-pane-rate-limit");
    expect(card).toHaveTextContent("Your provider hit its limit");
    expect(card).toHaveTextContent(
      "Anthropic rate-limited this key. Retry again later or switch models.",
    );
  });

  it("stays generic when the model id does not name a provider", async () => {
    // A bare id is how Ollama BYOK models are stored, so the classifier
    // defaults there. Printing "Ollama" would blame the wrong vendor.
    sessionRow.modelId = "some-internal-model";
    renderStep();
    await openTheSession();

    const card = await screen.findByTestId("swarm-live-pane-rate-limit");
    expect(card).toHaveTextContent("Your provider rate-limited this key.");
    expect(card).not.toHaveTextContent(/ollama/i);
  });

  it("does NOT show the provider card for MCPJam's own account limit", async () => {
    // Same amber cell, opposite advice — this one IS lifted by credit or BYOK,
    // so the provider copy would send the user to the wrong place.
    (
      streamState.sessions[CHAT_SESSION_ID] as { errorMessage: string }
    ).errorMessage = "Daily credit limit reached. (user_rate_limit, HTTP 429)";
    renderStep();
    await openTheSession();

    expect(
      screen.queryByTestId("swarm-live-pane-rate-limit"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("swarm-live-pane")).toHaveTextContent(
      "Daily credit limit reached.",
    );
  });

  it("points at the limited sessions from above the table, without a click", async () => {
    // Three of twelve sessions can 429 while the swarm keeps working. Nobody
    // finds that by clicking every amber chip.
    renderStep();

    const summary = await screen.findByTestId("new-swarm-running-rate-limit");
    expect(summary).toHaveTextContent("Anthropic rate-limited this key.");
    expect(summary).toHaveTextContent("1 session stopped.");
    expect(summary.className).toContain("amber");
  });

  it("says nothing when no session was rate-limited", async () => {
    attempt.status = "succeeded" as never;
    streamState.cellStatus = { "environment:env-1:0": "succeeded" };
    renderStep();

    await screen.findAllByTestId("new-swarm-running-session");
    expect(
      screen.queryByTestId("new-swarm-running-rate-limit"),
    ).not.toBeInTheDocument();
  });
  it("names the throttled target's provider, not another one on the same host", async () => {
    // Two environments can share a host and pin different models — the column
    // labels are "#n"-suffixed precisely because that collides. Matching an
    // attempt to a session by hostId alone can therefore name a provider that
    // throttled nothing.
    const otherChatSessionId = swarmAttemptChatSessionId(
      "run-1",
      { hostId: "host-1", environmentId: "env-2" },
      0,
    );
    snapshotHosts = [
      HOST_ENV_1,
      {
        hostId: "host-1",
        hostName: "MCPJam",
        targetId: "environment:env-2",
        environmentRef: {
          environmentId: "env-2",
          name: "Staging",
          revision: 1,
        },
      },
    ];
    hostSummaries = [
      { ...SUMMARY_ENV_1, succeeded: 1, rateLimited: 0 },
      { ...SUMMARY_ENV_1, targetId: "environment:env-2" },
    ];
    attempts = [
      { ...attempt, chatSessionId: CHAT_SESSION_ID, status: "succeeded" },
      {
        ...attempt,
        chatSessionId: otherChatSessionId,
        targetId: "environment:env-2",
        status: "rate_limited",
      },
    ];
    sessionRows = [
      { ...sessionRow, modelId: "anthropic/claude-opus-5" },
      {
        ...sessionRow,
        id: "s-2",
        chatSessionId: otherChatSessionId,
        modelId: "openai/gpt-5",
      },
    ];

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
            { key: "environment:env-2", label: "Staging" },
          ]}
          environments={[
            {
              environmentId: "env-1",
              projectId: "proj-1",
              name: "Prod-like",
              hostId: "host-1",
              revision: 1,
            },
            {
              environmentId: "env-2",
              projectId: "proj-1",
              name: "Staging",
              hostId: "host-1",
              revision: 1,
            },
          ]}
          onLeave={vi.fn()}
          onOpenSession={vi.fn()}
        />
      </div>,
    );

    const summary = await screen.findByTestId("new-swarm-running-rate-limit");
    expect(summary).toHaveTextContent("OpenAI rate-limited this key.");
    expect(summary).not.toHaveTextContent(/Anthropic/);
  });

  it("shows the card when only the attempt row knows the session was throttled", async () => {
    // The shape a real run produces: the chat-session lifecycle completes and
    // the live cell reports done, while the attempt row holds the refusal. The
    // pane has to read the same authority the table's chip does.
    sessionRow.status = "completed";
    streamState.cellStatus = { "environment:env-1:0": "succeeded" };
    streamState.sessions[CHAT_SESSION_ID].attemptStatus = "succeeded";
    streamState.sessions[CHAT_SESSION_ID].errorMessage =
      "Failed after 3 attempts. Last error: Too Many Requests";

    renderStep();
    await openTheSession();

    const card = await screen.findByTestId("swarm-live-pane-rate-limit");
    expect(card).toHaveTextContent("Your provider hit its limit");
    expect(card).toHaveTextContent("Anthropic rate-limited this key.");
  });
});
