import { ERROR_MESSAGES } from "@/lib/error-messages";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe("swarm transcript host resolution", () => {
  beforeEach(() => {
    sessionHost
      .mockReset()
      .mockReturnValue({ status: "ready", snapshot: { hostStyle: "claude" } });
    targetHost
      .mockReset()
      .mockReturnValue({ status: "ready", snapshot: { hostStyle: "chatgpt" } });
    viewer.mockClear();
    persisted.error = null;
  });

  it.each([false, true])("keeps one transcript frame in fillHeight=%s", (fillHeight) => {
    render(<SwarmLiveStreamPane {...props} fillHeight={fillHeight} />);
    const pane = screen.getByTestId("swarm-live-pane");
    expect(pane.classList.contains("border")).toBe(!fillHeight);
    expect(pane.classList.contains("p-3")).toBe(!fillHeight);
    expect(screen.getByTestId("transcript").parentElement).toHaveClass("border", "flex-1");
    expect(viewer).toHaveBeenCalledWith(expect.objectContaining({ frame: "none", fillContent: true }));
  });

  it("keeps transcript fetch failure distinct from streaming or an absent recording", () => {
    persisted.error = "Transcript download failed";
    render(<SwarmLiveStreamPane {...props} fallbackTrace={null} />);
    expect(screen.getByRole("alert")).toHaveTextContent(ERROR_MESSAGES.unexpected);
    expect(screen.queryByText("No transcript recorded")).not.toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Waiting for transcript" })).not.toBeInTheDocument();
  });

  it("uses the pinned session and its recorded model, querying by Convex id", () => {
    render(<SwarmLiveStreamPane {...props} />);
    expect(sessionHost).toHaveBeenLastCalledWith("convex-session");
    expect(targetHost).toHaveBeenLastCalledWith(null, true);
    expect(screen.getByTestId("transcript")).toHaveAttribute(
      "data-host-style",
      "claude",
    );
    expect(screen.getByTestId("transcript")).toHaveTextContent(
      "claude-sonnet-4-5",
    );
  });

  it("uses the selected target before the persisted session exists", () => {
    render(<SwarmLiveStreamPane {...props} convexSession={null} />);
    expect(targetHost).toHaveBeenLastCalledWith("host", true);
    expect(screen.getByTestId("transcript")).toHaveAttribute(
      "data-host-style",
      "chatgpt",
    );
  });

  it("waits for a new selection's config instead of showing its target or the previous host", () => {
    const { rerender } = render(<SwarmLiveStreamPane {...props} />);
    sessionHost.mockReturnValue({ status: "loading" });
    const next = {
      ...props,
      convexSession: {
        ...session,
        id: "next-convex-session",
        chatSessionId: "next-runtime-session",
      },
      selection: { ...props.selection, chatSessionId: "next-runtime-session" },
    };
    rerender(<SwarmLiveStreamPane {...next} />);
    expect(sessionHost).toHaveBeenLastCalledWith("next-convex-session");
    expect(screen.queryByTestId("transcript")).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading transcript" })).toBeInTheDocument();
    sessionHost.mockReturnValue({
      status: "ready",
      snapshot: { hostStyle: "codex" },
    });
    rerender(<SwarmLiveStreamPane {...next} />);
    expect(screen.getByTestId("transcript")).toHaveAttribute(
      "data-host-style",
      "codex",
    );
  });

  it("surfaces an unexpected missing required config without defaulting to MCPJam", () => {
    sessionHost.mockReturnValue({ status: "unavailable" });
    render(<SwarmLiveStreamPane {...props} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not load this session's host configuration.",
    );
    expect(viewer).not.toHaveBeenCalled();
  });

  it("can transition from no selection to a selected session without changing hook order", () => {
    const { rerender } = render(
      <SwarmLiveStreamPane {...props} selection={null} convexSession={null} />,
    );
    expect(sessionHost).toHaveBeenLastCalledWith(null);
    expect(targetHost).toHaveBeenLastCalledWith(null, true);
    rerender(<SwarmLiveStreamPane {...props} />);
    expect(screen.getByTestId("transcript")).toHaveAttribute(
      "data-host-style",
      "claude",
    );
  });
});
