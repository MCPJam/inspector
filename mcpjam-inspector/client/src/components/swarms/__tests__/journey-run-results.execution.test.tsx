import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwarmLiveStreamPane } from "../journey-run-results";
import type { JourneySessionRow } from "@/lib/swarm-api";
import type { JourneyRunStreamState } from "../use-journey-run-stream";

const { sessionHost, targetHost, viewer, persisted } = vi.hoisted(() => ({
  persisted: { error: null as string | null },
  sessionHost: vi.fn(),
  targetHost: vi.fn(),
  viewer: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useQuery: () => null,
  useConvexAuth: () => ({ isAuthenticated: true }),
}));
vi.mock("@/hooks/use-host-snapshot", () => ({
  useHostSnapshotForSession: sessionHost,
  useHostSnapshotForHost: targetHost,
}));
vi.mock("../use-persisted-session-trace", () => ({
  usePersistedSessionTrace: () => ({
    trace: null,
    loading: false,
    error: persisted.error,
    spanError: null,
    pluginVersions: [],
  }),
}));
vi.mock("@/components/evals/trace-viewer", () => ({
  TraceViewer: (props: {
    hostSnapshot: { hostStyle: string };
    model: { name: string };
  }) => {
    viewer(props);
    return (
      <div
        data-testid="transcript"
        data-host-style={props.hostSnapshot.hostStyle}
      >
        {props.model.name}
      </div>
    );
  },
}));
vi.mock("@/components/evals/trace-view-mode-tabs", () => ({
  TraceViewModeTabs: () => null,
}));

const session: JourneySessionRow = {
  id: "convex-session",
  chatSessionId: "runtime-session",
  projectId: "project",
  hostId: "host",
  modelId: "claude-sonnet-4-5",
  startedAt: 1,
};
const props = {
  selection: {
    targetKey: "host",
    hostId: "host",
    sessionIndex: 0,
    chatSessionId: "runtime-session",
  },
  stream: {
    sessions: {},
    cellStatus: {},
    runComplete: false,
    connected: true,
    error: null,
  } as JourneyRunStreamState,
  convexSession: session,
  fallbackTrace: { messages: [{ role: "user", content: "Hello" }] },
  runStatus: "running",
  onOpenCompleted: vi.fn(),
};

const execution = {
  requested: { source: "legacy", modelId: "anthropic/claude-sonnet-4.5" },
  resolved: {
    rail: "openrouter",
    wireModelId: "anthropic/claude-sonnet-4.5",
    offering: { rail: "openrouter", providerKey: "openrouter" },
  },
  effectiveSettings: { maxOutputTokens: 0 },
  attempts: [],
  deviation: {
    kind: "provider_fallback",
    reason:
      "This model routes to the Vercel AI Gateway, which is not configured on this deployment; it was served through the OpenRouter fallback.",
  },
};

describe("swarm session execution provenance", () => {
  beforeEach(() => {
    sessionHost.mockReturnValue({
      status: "ready",
      snapshot: { hostStyle: "claude" },
    });
    targetHost.mockReturnValue({
      status: "ready",
      snapshot: { hostStyle: "chatgpt" },
    });
  });
  afterEach(() => {
    cleanup();
  });

  it("shows what the session's model ran on, with the deviation banner", () => {
    render(
      <SwarmLiveStreamPane
        {...props}
        attempt={{ status: "succeeded", execution }}
      />,
    );
    expect(
      screen.getByTestId("swarm-live-pane-execution-provenance-line"),
    ).toHaveTextContent(
      "Ran on anthropic/claude-sonnet-4.5 via OpenRouter (MCPJam key), max output provider default",
    );
    expect(
      screen.getByTestId("swarm-live-pane-execution-deviation-banner"),
    ).toHaveTextContent("Deviation: Provider fallback");
  });

  it("shows nothing for a session recorded before records existed", () => {
    render(
      <SwarmLiveStreamPane {...props} attempt={{ status: "succeeded" }} />,
    );
    expect(
      screen.queryByTestId("swarm-live-pane-execution-provenance"),
    ).not.toBeInTheDocument();
  });
});
