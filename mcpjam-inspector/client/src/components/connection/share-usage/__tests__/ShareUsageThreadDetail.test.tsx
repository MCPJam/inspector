import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareUsageThreadDetail } from "../ShareUsageThreadDetail";

const { mockMessageView, mockAdaptTraceToUiMessages, mockThreadState } =
  vi.hoisted(() => ({
    mockMessageView: vi.fn(),
    mockAdaptTraceToUiMessages: vi.fn(),
    mockThreadState: {
      sourceType: "sandbox",
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
}));

vi.mock("@/components/evals/trace-viewer-adapter", () => ({
  adaptTraceToUiMessages: (...args: unknown[]) =>
    mockAdaptTraceToUiMessages(...args),
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
    mockThreadState.sourceType = "sandbox";
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
        screen.queryByRole("button", { name: "Chat" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Trace" }),
      ).not.toBeInTheDocument();
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

  it("keeps sandbox threads in chat mode without a toggle", async () => {
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

  it("keeps server share threads in trace mode without a toggle", async () => {
    mockThreadState.sourceType = "serverShare";

    render(<ShareUsageThreadDetail threadId="thread-1" />);

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Chat" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Trace" }),
      ).not.toBeInTheDocument();
      expect(mockAdaptTraceToUiMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          toolResultDisplay: "sibling-text",
        }),
      );
      expect(mockMessageView).toHaveBeenCalledWith(
        expect.objectContaining({
          minimalMode: true,
          reasoningDisplayMode: "collapsed",
        }),
      );
    });
  });
});
