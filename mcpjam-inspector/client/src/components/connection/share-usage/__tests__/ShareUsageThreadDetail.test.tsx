import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareUsageThreadDetail } from "../ShareUsageThreadDetail";

const {
  mockMessageView,
  mockReadOnlyTranscript,
  mockAdaptTraceToUiMessages,
  mockRequestJudge,
  mockNavigateApp,
  mockThreadState,
  mockBrowserArtifactsState,
} = vi.hoisted(() => ({
  mockMessageView: vi.fn(),
  mockReadOnlyTranscript: vi.fn(),
  mockAdaptTraceToUiMessages: vi.fn(),
  mockRequestJudge: vi.fn().mockResolvedValue(null),
  mockNavigateApp: vi.fn(),
  mockThreadState: {
    sourceType: "chatbox",
    synthetic: false as boolean,
    readiness: undefined as unknown,
    goalScore: undefined as unknown,
  },
  mockBrowserArtifactsState: {
    artifacts: undefined as unknown,
  },
}));

vi.mock("convex/react", () => ({
  useAction: () => mockRequestJudge,
}));

vi.mock("@/hooks/useSharedChatThreads", () => ({
  useSharedChatThread: () => ({
    thread: {
      sourceType: mockThreadState.sourceType,
      synthetic: mockThreadState.synthetic,
      readiness: mockThreadState.readiness,
      goalScore: mockThreadState.goalScore,
      messagesBlobUrl: "https://storage.example.com/thread.json",
      modelId: "openai/gpt-oss-120b",
      visitorDisplayName: "Marcelo Jimenez",
      messageCount: 2,
      startedAt: Date.now() - 1000,
      lastActivityAt: Date.now(),
    },
  }),
  useSharedChatWidgetSnapshots: () => ({
    snapshots: [],
  }),
  useSharedChatTurnTraces: () => ({
    traces: [],
  }),
  useSessionBrowserArtifacts: () => ({
    artifacts: mockBrowserArtifactsState.artifacts,
  }),
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: vi.fn() }),
}));

vi.mock("@/components/evals/trace-viewer-adapter", () => ({
  adaptTraceToUiMessages: (...args: unknown[]) =>
    mockAdaptTraceToUiMessages(...args),
  snapshotsToTraceWidgetSnapshots: (snapshots: unknown[]) => snapshots,
}));

vi.mock("@/components/chat-v2/thread/message-view", () => ({
  MessageView: (props: Record<string, unknown>) => {
    mockMessageView(props);
    return <div data-testid="message-view" />;
  },
}));

vi.mock("@mcpjam/chat-ui", () => ({
  ReadOnlyTranscript: (props: Record<string, unknown>) => {
    mockReadOnlyTranscript(props);
    return <div data-testid="read-only-transcript" />;
  },
}));

vi.mock(
  "@/components/chat-v2/history/convert-promotable-session-dialog",
  () => ({
    ConvertPromotableSessionDialog: ({
      open,
      sessionId,
      onImported,
    }: {
      open: boolean;
      sessionId: string | null;
      onImported: (r: { suiteId: string; testCaseId: string }) => void;
    }) => (
      <div
        data-testid="promote-dialog"
        data-open={String(open)}
        data-session-id={sessionId ?? ""}
      >
        <button
          type="button"
          onClick={() =>
            onImported({ suiteId: "suite-1", testCaseId: "case-1" })
          }
        >
          simulate import
        </button>
      </div>
    ),
  })
);

vi.mock("@/lib/app-navigation", () => ({
  navigateApp: (...args: unknown[]) => mockNavigateApp(...args),
  buildEvalsPath: (route: Record<string, unknown>) =>
    `/evals/${route.suiteId}/${route.testId}`,
}));

describe("ShareUsageThreadDetail", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mockThreadState.sourceType = "chatbox";
    mockThreadState.synthetic = false;
    mockThreadState.readiness = undefined;
    mockThreadState.goalScore = undefined;
    mockBrowserArtifactsState.artifacts = undefined;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ role: "assistant", content: [] }],
    } as Response);
    mockAdaptTraceToUiMessages.mockReturnValue({
      messages: [
        {
          id: "assistant-1",
          role: "assistant",
          parts: [
            {
              type: "reasoning",
              text: "Collapsed in share usage traces",
              state: "done",
            },
          ],
        },
      ],
      toolRenderOverrides: {},
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("renders formatted share traces with collapsed reasoning", async () => {
    render(<ShareUsageThreadDetail threadId="thread-1" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Chat" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Trace" })).toBeInTheDocument();
      expect(mockAdaptTraceToUiMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          toolResultDisplay: "attached-to-tool",
        })
      );
      expect(mockReadOnlyTranscript).toHaveBeenCalledWith(
        expect.objectContaining({
          reasoningDisplayMode: "collapsible",
          widgetPolicy: "placeholder",
        })
      );
    });
  });

  it("renders chatbox threads with collapsible reasoning in chat mode", async () => {
    render(<ShareUsageThreadDetail threadId="thread-1" />);

    await waitFor(() => {
      expect(mockReadOnlyTranscript).toHaveBeenCalledWith(
        expect.objectContaining({
          reasoningDisplayMode: "collapsible",
        })
      );
    });
  });

  it("offers an initial judge action for an ungraded swarm session", async () => {
    mockThreadState.sourceType = "swarm";
    const user = userEvent.setup();

    render(<ShareUsageThreadDetail threadId="thread-1" />);

    await user.click(await screen.findByRole("button", { name: /run judge/i }));
    expect(mockRequestJudge).toHaveBeenCalledWith({ sessionId: "thread-1" });
  });

  it("hides the Replay tab when the session has no browser artifacts", async () => {
    render(<ShareUsageThreadDetail threadId="thread-1" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Chat" })).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: "Replay" })
    ).not.toBeInTheDocument();
  });

  it("shows the Replay tab and renders the artifacts view when artifacts exist", async () => {
    mockBrowserArtifactsState.artifacts = {
      widgetRenderObservations: [
        {
          toolCallId: "tc-1",
          toolName: "create_view",
          serverId: "server-1",
          promptIndex: 0,
          status: "rendered",
          screenshotUrl: null,
          elapsedMs: 1200,
          ts: 1,
        },
      ],
      browserInteractionSteps: [
        {
          toolCallId: "tc-1",
          stepIndex: 0,
          promptIndex: 0,
          action: "left_click",
          coordinateX: 10,
          coordinateY: 20,
          screenshotUrl: null,
          elapsedMs: 80,
          ts: 2,
        },
      ],
    };

    render(<ShareUsageThreadDetail threadId="thread-1" />);

    const appTab = await screen.findByRole("button", { name: "Replay" });
    await userEvent.click(appTab);

    // Render-observation card from BrowserArtifactsView (the same component the
    // eval replay uses). The per-step interaction timeline now lives on the
    // Trace tab (`Interact · …` spans), not in the Replay tab.
    expect(
      await screen.findByTestId("browser-artifacts-view")
    ).toBeInTheDocument();
    expect(screen.getByTestId("render-observation-card")).toBeInTheDocument();
    expect(screen.queryByText("Computer Use timeline")).toBeNull();
  });

  it("shows readiness findings for synthetic sessions", async () => {
    mockThreadState.synthetic = true;
    mockThreadState.readiness = {
      status: "completed",
      verdict: "needs_attention",
      issueCount: 1,
      coverageRatio: 0.2,
      advertisedToolCount: 5,
      usedToolCount: 1,
      toolCallCount: 0,
      toolErrorCount: 0,
      issues: [],
    };

    render(<ShareUsageThreadDetail threadId="thread-1" />);

    expect(
      await screen.findByText(/Only 20% of advertised tools were used/i)
    ).toBeInTheDocument();
  });

  it("falls back to Chat when the active browser view loses its artifacts (session switch)", async () => {
    // Cursor Bugbot (PR 2610): viewMode is component state that survives a
    // threadId switch; with the Browser tab hidden, a stale "browser" mode
    // must not strand the user on an orphaned empty panel.
    mockBrowserArtifactsState.artifacts = {
      widgetRenderObservations: [
        {
          toolCallId: "tc-1",
          toolName: "create_view",
          serverId: "server-1",
          promptIndex: 0,
          status: "rendered",
          screenshotUrl: null,
          elapsedMs: 1200,
          ts: 1,
        },
      ],
      browserInteractionSteps: [],
    };

    const { rerender } = render(<ShareUsageThreadDetail threadId="thread-1" />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Replay" })
    );
    expect(
      await screen.findByTestId("browser-artifacts-view")
    ).toBeInTheDocument();

    // The next session has no artifacts (same mounted component instance).
    mockBrowserArtifactsState.artifacts = {
      widgetRenderObservations: [],
      browserInteractionSteps: [],
    };
    rerender(<ShareUsageThreadDetail threadId="thread-2" />);

    await waitFor(() => {
      expect(
        screen.queryByTestId("browser-artifacts-view")
      ).not.toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: "Replay" })
    ).not.toBeInTheDocument();
    // Chat content renders instead of a blank panel. findBy: the messages
    // blob re-fetch on thread switch is async — don't depend on the previous
    // thread's messages state being retained (CodeRabbit, PR 2610).
    expect(
      await screen.findByTestId("read-only-transcript")
    ).toBeInTheDocument();
  });
});

describe("ShareUsageThreadDetail — promote affordance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockThreadState.sourceType = "chatbox";
    mockThreadState.synthetic = false;
    mockThreadState.readiness = undefined;
    mockThreadState.goalScore = undefined;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ role: "assistant", content: [] }],
    } as Response);
    mockAdaptTraceToUiMessages.mockReturnValue({
      messages: [{ id: "assistant-1", role: "assistant", parts: [] }],
      toolRenderOverrides: {},
    });
  });

  const PROMOTE = { projectId: "proj-1", canPromote: true };

  it("renders for a member on a User Testing session", async () => {
    render(<ShareUsageThreadDetail threadId="thread-1" promote={PROMOTE} />);
    expect(
      await screen.findByTestId("share-usage-promote-to-test-case")
    ).toBeInTheDocument();
  });

  it("is absent for a project guest", async () => {
    render(
      <ShareUsageThreadDetail
        threadId="thread-1"
        promote={{ ...PROMOTE, canPromote: false }}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Chat/ })).toBeInTheDocument()
    );
    expect(
      screen.queryByTestId("share-usage-promote-to-test-case")
    ).not.toBeInTheDocument();
  });

  it("is absent entirely when the surface passes no capability", async () => {
    // The host share-usage dialog: no project scope, no promote UI.
    render(<ShareUsageThreadDetail threadId="thread-1" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Chat/ })).toBeInTheDocument()
    );
    expect(screen.queryByTestId("promote-dialog")).not.toBeInTheDocument();
  });

  it("is absent on a direct session, which keeps its own adapter", async () => {
    mockThreadState.sourceType = "direct";
    render(<ShareUsageThreadDetail threadId="thread-1" promote={PROMOTE} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Chat/ })).toBeInTheDocument()
    );
    expect(
      screen.queryByTestId("share-usage-promote-to-test-case")
    ).not.toBeInTheDocument();
  });

  it("opens the dialog on this thread and navigates to the created case", async () => {
    const user = userEvent.setup();
    render(<ShareUsageThreadDetail threadId="thread-1" promote={PROMOTE} />);

    const dialog = await screen.findByTestId("promote-dialog");
    expect(dialog.getAttribute("data-open")).toBe("false");
    expect(dialog.getAttribute("data-session-id")).toBe("thread-1");

    await user.click(screen.getByTestId("share-usage-promote-to-test-case"));
    await waitFor(() =>
      expect(
        screen.getByTestId("promote-dialog").getAttribute("data-open")
      ).toBe("true")
    );

    // Default behavior lands the user on the artifact they just created.
    await user.click(screen.getByText("simulate import"));
    await waitFor(() =>
      expect(mockNavigateApp).toHaveBeenCalledWith("/evals/suite-1/case-1")
    );
  });
});

describe("ShareUsageThreadDetail — readiness gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockThreadState.sourceType = "chatbox";
    mockThreadState.goalScore = undefined;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ role: "assistant", content: [] }],
    } as Response);
    mockAdaptTraceToUiMessages.mockReturnValue({
      messages: [{ id: "assistant-1", role: "assistant", parts: [] }],
      toolRenderOverrides: {},
    });
  });

  it("shows readiness for a REAL session that carries a verdict", async () => {
    // The whole point of the backend flip: real tester sessions now get
    // graded, and the UI must follow the data rather than the population.
    mockThreadState.synthetic = false;
    // A verdict with something to say — the bar deliberately renders nothing
    // for a clean `ready` session, so a "ready" fixture would pass vacuously.
    mockThreadState.readiness = {
      status: "completed",
      verdict: "needs_attention",
      issues: [
        {
          code: "tool_errors",
          severity: "warning",
          message: "1 of 3 tool calls failed.",
        },
      ],
      toolCallCount: 3,
      toolErrorCount: 1,
      turnCount: 1,
    };
    render(<ShareUsageThreadDetail threadId="thread-1" />);
    await waitFor(() =>
      expect(screen.getByTestId("session-insight-bar")).toBeInTheDocument()
    );
  });

  it("shows nothing when the session has no verdict yet", async () => {
    mockThreadState.synthetic = false;
    mockThreadState.readiness = undefined;
    render(<ShareUsageThreadDetail threadId="thread-1" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Chat/ })).toBeInTheDocument()
    );
    expect(screen.queryByTestId("session-insight-bar")).not.toBeInTheDocument();
  });
});
