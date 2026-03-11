import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSharedChatWidgetCapture } from "../useSharedChatWidgetCapture";
import { useWidgetDebugStore } from "@/stores/widget-debug-store";

const mockGenerateSnapshotUploadUrl = vi.fn();
const mockCreateWidgetSnapshot = vi.fn();

vi.mock("convex/react", () => ({
  useMutation: (name: string) => {
    if (name === "sharedChatThreads:generateSnapshotUploadUrl") {
      return mockGenerateSnapshotUploadUrl;
    }
    if (name === "sharedChatThreads:createWidgetSnapshot") {
      return mockCreateWidgetSnapshot;
    }
    throw new Error(`Unexpected mutation: ${name}`);
  },
}));

const originalFetch = global.fetch;

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useSharedChatWidgetCapture", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useWidgetDebugStore.setState({ widgets: new Map() });

    let uploadCounter = 0;
    mockGenerateSnapshotUploadUrl.mockImplementation(async () => {
      uploadCounter += 1;
      return `https://upload.example.com/${uploadCounter}`;
    });
    mockCreateWidgetSnapshot.mockResolvedValue("snapshot-1");

    global.fetch = vi.fn(async () => {
      uploadCounter += 1;
      return new Response(
        JSON.stringify({ storageId: `blob-${uploadCounter}` }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it("uploads widget html and tool payloads for shared chat widgets", async () => {
    const { unmount } = renderHook(() =>
      useSharedChatWidgetCapture({
        enabled: true,
        chatSessionId: "chat-session-1",
        hostedShareToken: "share-token",
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            parts: [
              {
                type: "tool-search",
                toolCallId: "call-1",
                input: { q: "hello" },
                output: {
                  result: "world",
                  _meta: { "openai/outputTemplate": "ui://widget.html" },
                },
              },
            ],
          } as any,
        ],
      }),
    );

    act(() => {
      useWidgetDebugStore.setState({
        widgets: new Map([
          [
            "call-1",
            {
              toolCallId: "call-1",
              toolName: "search",
              protocol: "openai-apps",
              widgetState: null,
              prefersBorder: false,
              globals: {
                theme: "light",
                displayMode: "inline",
                locale: "en-US",
                timeZone: "America/Los_Angeles",
                userAgent: {
                  device: { type: "desktop" },
                  capabilities: { hover: true, touch: false },
                },
                safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
              },
              csp: {
                mode: "widget-declared",
                connectDomains: ["https://api.example.com"],
                resourceDomains: ["https://cdn.example.com"],
                violations: [],
              },
              widgetHtml: "<div>Widget</div>",
              updatedAt: Date.now(),
            },
          ],
        ]),
      });
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    await flushMicrotasks();

    expect(mockCreateWidgetSnapshot).toHaveBeenCalledTimes(1);
    expect(mockGenerateSnapshotUploadUrl).toHaveBeenCalledTimes(3);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(mockCreateWidgetSnapshot).toHaveBeenCalledWith({
      shareToken: "share-token",
      chatSessionId: "chat-session-1",
      toolCallId: "call-1",
      toolName: "search",
      widgetHtmlBlobId: expect.stringMatching(/^blob-/),
      uiType: "openai-apps",
      resourceUri: "ui://widget.html",
      toolInputBlobId: expect.stringMatching(/^blob-/),
      toolOutputBlobId: expect.stringMatching(/^blob-/),
      widgetCsp: {
        connectDomains: ["https://api.example.com"],
        resourceDomains: ["https://cdn.example.com"],
        frameDomains: undefined,
        baseUriDomains: undefined,
      },
      widgetPermissions: undefined,
      widgetPermissive: false,
      prefersBorder: false,
      displayContext: {
        theme: "light",
        displayMode: "inline",
        deviceType: "desktop",
        viewport: undefined,
        locale: "en-US",
        timeZone: "America/Los_Angeles",
        capabilities: { hover: true, touch: false },
        safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      },
    });

    unmount();
  });

  it("dedupes identical widget html and retries when the thread is not ready yet", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    mockCreateWidgetSnapshot
      .mockRejectedValueOnce(new Error("Thread not found for chat session"))
      .mockResolvedValueOnce("snapshot-1");

    try {
      const { unmount } = renderHook(() =>
        useSharedChatWidgetCapture({
          enabled: true,
          chatSessionId: "chat-session-1",
          hostedShareToken: "share-token",
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              parts: [
                {
                  type: "tool-search",
                  toolCallId: "call-1",
                  input: { q: "hello" },
                  output: { result: "world" },
                },
              ],
            } as any,
          ],
        }),
      );

      act(() => {
        useWidgetDebugStore.setState({
          widgets: new Map([
            [
              "call-1",
              {
                toolCallId: "call-1",
                toolName: "search",
                protocol: "mcp-apps",
                widgetState: null,
                globals: {
                  theme: "dark",
                  displayMode: "inline",
                },
                widgetHtml: "<div>Widget</div>",
                updatedAt: Date.now(),
              },
            ],
          ]),
        });
      });

      act(() => {
        vi.advanceTimersByTime(500);
      });

      await flushMicrotasks();
      expect(mockCreateWidgetSnapshot).toHaveBeenCalledTimes(1);

      // Blobs were uploaded on the first attempt
      const uploadsAfterFirstAttempt = (
        global.fetch as ReturnType<typeof vi.fn>
      ).mock.calls.length;
      expect(uploadsAfterFirstAttempt).toBe(3);

      act(() => {
        vi.advanceTimersByTime(1000);
      });

      await flushMicrotasks();
      expect(mockCreateWidgetSnapshot).toHaveBeenCalledTimes(2);

      // Retry reuses cached blobs — no new uploads
      expect(global.fetch).toHaveBeenCalledTimes(uploadsAfterFirstAttempt);
      expect(mockGenerateSnapshotUploadUrl).toHaveBeenCalledTimes(3);

      // Same blob IDs should be passed on the retry
      const firstCall = mockCreateWidgetSnapshot.mock.calls[0][0];
      const retryCall = mockCreateWidgetSnapshot.mock.calls[1][0];
      expect(retryCall.widgetHtmlBlobId).toBe(firstCall.widgetHtmlBlobId);
      expect(retryCall.toolInputBlobId).toBe(firstCall.toolInputBlobId);
      expect(retryCall.toolOutputBlobId).toBe(firstCall.toolOutputBlobId);

      act(() => {
        useWidgetDebugStore.setState((state) => ({
          widgets: new Map(state.widgets).set("call-1", {
            ...state.widgets.get("call-1")!,
            csp: {
              mode: "permissive",
              connectDomains: [],
              resourceDomains: [],
              violations: [],
            },
          }),
        }));
      });

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(mockCreateWidgetSnapshot).toHaveBeenCalledTimes(2);
      unmount();
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("uploads sandbox widget snapshots with the originating server id", async () => {
    const { unmount } = renderHook(() =>
      useSharedChatWidgetCapture({
        enabled: true,
        chatSessionId: "chat-session-2",
        hostedSandboxToken: "sandbox-token",
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            parts: [
              {
                type: "tool-search",
                toolCallId: "call-2",
                input: { q: "sandbox" },
                output: {
                  result: "ok",
                  _meta: {
                    "openai/outputTemplate": "ui://widget.html",
                    _serverId: "srv_123",
                  },
                },
              },
            ],
          } as any,
        ],
      }),
    );

    act(() => {
      useWidgetDebugStore.setState({
        widgets: new Map([
          [
            "call-2",
            {
              toolCallId: "call-2",
              toolName: "search",
              protocol: "openai-apps",
              widgetState: null,
              prefersBorder: true,
              globals: {
                theme: "dark",
                displayMode: "inline",
              },
              widgetHtml: "<div>Sandbox widget</div>",
              updatedAt: Date.now(),
            },
          ],
        ]),
      });
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    await flushMicrotasks();

    expect(mockCreateWidgetSnapshot).toHaveBeenCalledWith({
      sandboxToken: "sandbox-token",
      chatSessionId: "chat-session-2",
      serverId: "srv_123",
      toolCallId: "call-2",
      toolName: "search",
      widgetHtmlBlobId: expect.stringMatching(/^blob-/),
      uiType: "openai-apps",
      resourceUri: "ui://widget.html",
      toolInputBlobId: expect.stringMatching(/^blob-/),
      toolOutputBlobId: expect.stringMatching(/^blob-/),
      widgetCsp: undefined,
      widgetPermissions: undefined,
      widgetPermissive: false,
      prefersBorder: true,
      displayContext: {
        theme: "dark",
        displayMode: "inline",
        deviceType: undefined,
        viewport: undefined,
        locale: undefined,
        timeZone: undefined,
        capabilities: undefined,
        safeAreaInsets: undefined,
      },
    });

    unmount();
  });
});
