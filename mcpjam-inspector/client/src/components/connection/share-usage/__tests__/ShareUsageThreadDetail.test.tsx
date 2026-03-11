import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareUsageThreadDetail } from "../ShareUsageThreadDetail";

const { mockMessageView, mockAdaptTraceToUiMessages } = vi.hoisted(() => ({
  mockMessageView: vi.fn(),
  mockAdaptTraceToUiMessages: vi.fn(),
}));

vi.mock("@/hooks/useSharedChatThreads", () => ({
  useSharedChatThread: () => ({
    thread: {
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
      expect(mockMessageView).toHaveBeenCalledWith(
        expect.objectContaining({
          reasoningDisplayMode: "collapsed",
          interactive: false,
          minimalMode: true,
        }),
      );
    });
  });
});
