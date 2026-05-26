import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareUsageThreadDetail } from "../ShareUsageThreadDetail";

const { mockMessageView, mockAdaptTraceToUiMessages, mockThreadState } =
  vi.hoisted(() => ({
    mockMessageView: vi.fn(),
    mockAdaptTraceToUiMessages: vi.fn(),
    mockThreadState: {
      sourceType: "chatbox",
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
  // SessionClientConfigChip destructures `.config` from this hook; return
  // `{ config: null }` so it short-circuits to the "no audit-pin
  // available" branch and renders nothing (chip is noisy when empty).
  useSessionHistoricalHostConfig: () => ({ config: null }),
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

});
