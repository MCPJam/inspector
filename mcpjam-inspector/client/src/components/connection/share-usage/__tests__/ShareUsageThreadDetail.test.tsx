import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareUsageThreadDetail } from "../ShareUsageThreadDetail";

const {
  mockMessageView,
  mockAdaptTraceToUiMessages,
  mockThreadState,
  mockBrowserArtifactsState,
} = vi.hoisted(() => ({
  mockMessageView: vi.fn(),
  mockAdaptTraceToUiMessages: vi.fn(),
  mockThreadState: {
    sourceType: "chatbox",
  },
  mockBrowserArtifactsState: {
    artifacts: undefined as unknown,
  },
}));

vi.mock("@/hooks/useSharedChatThreads", () => ({
  useSharedChatThread: () => ({
    thread: {
      sourceType: mockThreadState.sourceType,
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

describe("ShareUsageThreadDetail", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    mockThreadState.sourceType = "chatbox";
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
      expect(
        screen.getByRole("button", { name: "Chat" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Trace" }),
      ).toBeInTheDocument();
      expect(mockAdaptTraceToUiMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          toolResultDisplay: "attached-to-tool",
        }),
      );
      expect(mockMessageView).toHaveBeenCalledWith(
        expect.objectContaining({
          reasoningDisplayMode: "collapsible",
          interactive: false,
          minimalMode: false,
        }),
      );
    });
  });

  it("renders chatbox threads with collapsible reasoning in chat mode", async () => {
    render(<ShareUsageThreadDetail threadId="thread-1" />);

    await waitFor(() => {
      expect(mockMessageView).toHaveBeenCalledWith(
        expect.objectContaining({
          minimalMode: false,
          reasoningDisplayMode: "collapsible",
        }),
      );
    });
  });

  it("hides the Browser tab when the session has no browser artifacts", async () => {
    render(<ShareUsageThreadDetail threadId="thread-1" />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Chat" })).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: "Browser" }),
    ).not.toBeInTheDocument();
  });

  it("shows the Browser tab and renders the artifacts view when artifacts exist", async () => {
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

    const browserTab = await screen.findByRole("button", { name: "Browser" });
    await userEvent.click(browserTab);

    // Render-observation card + the Computer Use timeline from
    // BrowserArtifactsView (the same component the eval replay uses).
    expect(
      await screen.findByTestId("browser-artifacts-view"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("render-observation-card")).toBeInTheDocument();
    expect(screen.getByText("Computer Use timeline")).toBeInTheDocument();
    expect(screen.getByText("Left click (10, 20)")).toBeInTheDocument();
  });
});
