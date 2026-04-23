import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSharedChatWidgetCapture } from "../useSharedChatWidgetCapture";
import { useWidgetDebugStore } from "@/stores/widget-debug-store";

const mockGenerateSnapshotUploadUrl = vi.fn();
const mockCreateWidgetSnapshot = vi.fn();
const mockGenerateWidgetSnapshotUploadUrlFromWeb = vi.fn();
const mockCreateChatHistoryWidgetSnapshot = vi.fn();

vi.mock("convex/react", () => ({
  useMutation: (name: string) => {
    if (name === "chatSessions:generateSnapshotUploadUrl") {
      return mockGenerateSnapshotUploadUrl;
    }
    if (name === "chatSessions:createWidgetSnapshot") {
      return mockCreateWidgetSnapshot;
    }
    throw new Error(`Unexpected mutation: ${name}`);
  },
}));

vi.mock("@/lib/apis/web/chat-history-api", () => ({
  generateWidgetSnapshotUploadUrl: (...args: unknown[]) =>
    mockGenerateWidgetSnapshotUploadUrlFromWeb(...args),
  createChatHistoryWidgetSnapshot: (...args: unknown[]) =>
    mockCreateChatHistoryWidgetSnapshot(...args),
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
    mockGenerateWidgetSnapshotUploadUrlFromWeb.mockImplementation(async () => ({
      ok: true,
      uploadUrl: "https://upload.example.com/web",
    }));
    mockCreateChatHistoryWidgetSnapshot.mockResolvedValue({
      ok: true,
      snapshotId: "snapshot-web-1",
    });

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
                  _meta: {
                    "openai/outputTemplate": "ui://widget.html",
                    _serverId: "server-1",
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
      serverId: "server-1",
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

  it("waits until persistence is ready before uploading widget snapshots", async () => {
    const { rerender, unmount } = renderHook(
      ({
        readyToPersist,
      }: {
        readyToPersist: boolean;
      }) =>
        useSharedChatWidgetCapture({
          enabled: true,
          readyToPersist,
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
                  output: { result: "world", _serverId: "server-1" },
                },
              ],
            } as any,
          ],
        }),
      {
        initialProps: {
          readyToPersist: false,
        },
      },
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
      vi.advanceTimersByTime(5000);
    });

    await flushMicrotasks();

    expect(mockGenerateSnapshotUploadUrl).not.toHaveBeenCalled();
    expect(mockCreateWidgetSnapshot).not.toHaveBeenCalled();

    rerender({ readyToPersist: true });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    await flushMicrotasks();

    expect(mockCreateWidgetSnapshot).toHaveBeenCalledTimes(1);
    expect(mockGenerateSnapshotUploadUrl).toHaveBeenCalledTimes(3);

    unmount();
  });

  it("dedupes identical widget html and retries when the thread is not ready yet", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    mockCreateWidgetSnapshot
      .mockRejectedValueOnce(new Error("Session not found for chat session"))
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
                  output: { result: "world", _serverId: "server-1" },
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

  it("retries when the snapshot mutation returns null while the session is still pending", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    mockCreateWidgetSnapshot
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("snapshot-1");

    try {
      const { unmount } = renderHook(() =>
        useSharedChatWidgetCapture({
          enabled: true,
          chatSessionId: "chat-session-pending",
          hostedShareToken: "share-token",
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              parts: [
                {
                  type: "tool-search",
                  toolCallId: "call-pending",
                  input: { q: "hello" },
                  output: { result: "world", _serverId: "server-1" },
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
              "call-pending",
              {
                toolCallId: "call-pending",
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

      act(() => {
        vi.advanceTimersByTime(1000);
      });

      await flushMicrotasks();
      expect(mockCreateWidgetSnapshot).toHaveBeenCalledTimes(2);
      unmount();
    } finally {
      randomSpy.mockRestore();
    }
  });

  it("uploads chatbox widget snapshots with the originating server id", async () => {
    const { unmount } = renderHook(() =>
      useSharedChatWidgetCapture({
        enabled: true,
        chatSessionId: "chat-session-2",
        hostedChatboxToken: "chatbox-token",
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            parts: [
              {
                type: "tool-search",
                toolCallId: "call-2",
                input: { q: "chatbox" },
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
              widgetHtml: "<div>Chatbox widget</div>",
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
      chatboxToken: "chatbox-token",
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

  it("uses the web chat-history snapshot endpoints for direct guests", async () => {
    const { unmount } = renderHook(() =>
      useSharedChatWidgetCapture({
        enabled: true,
        directGuestMode: true,
        chatSessionId: "guest-chat-1",
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            parts: [
              {
                type: "tool-search",
                toolCallId: "guest-call-1",
                input: { q: "guest" },
                output: {
                  result: "ok",
                  _meta: { _serverId: "guest-server-1" },
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
            "guest-call-1",
            {
              toolCallId: "guest-call-1",
              toolName: "search",
              protocol: "mcp-apps",
              widgetState: null,
              globals: {
                theme: "dark",
                displayMode: "inline",
              },
              widgetHtml: "<div>Guest widget</div>",
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

    expect(mockGenerateWidgetSnapshotUploadUrlFromWeb).toHaveBeenCalledTimes(3);
    expect(mockCreateChatHistoryWidgetSnapshot).toHaveBeenCalledTimes(1);
    expect(mockGenerateSnapshotUploadUrl).not.toHaveBeenCalled();
    expect(mockCreateWidgetSnapshot).not.toHaveBeenCalled();
    expect(mockCreateChatHistoryWidgetSnapshot).toHaveBeenCalledWith({
      chatSessionId: "guest-chat-1",
      serverId: "guest-server-1",
      toolCallId: "guest-call-1",
      toolName: "search",
      widgetHtmlBlobId: expect.any(String),
      uiType: "mcp-apps",
      resourceUri: undefined,
      toolInputBlobId: expect.any(String),
      toolOutputBlobId: expect.any(String),
      widgetCsp: undefined,
      widgetPermissions: undefined,
      widgetPermissive: false,
      prefersBorder: undefined,
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

  it("skips widget capture for tool calls that already have persisted snapshots", async () => {
    const { unmount } = renderHook(() =>
      useSharedChatWidgetCapture({
        enabled: true,
        chatSessionId: "chat-session-history",
        persistedSnapshotToolCallIds: ["call-existing"],
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            parts: [
              {
                type: "tool-search",
                toolCallId: "call-existing",
                input: { q: "history" },
                output: {
                  result: "ok",
                  _meta: { _serverId: "server-1" },
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
            "call-existing",
            {
              toolCallId: "call-existing",
              toolName: "search",
              protocol: "mcp-apps",
              widgetState: null,
              globals: {
                theme: "dark",
                displayMode: "inline",
              },
              widgetHtml: "<div>Existing widget</div>",
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

    expect(mockGenerateSnapshotUploadUrl).not.toHaveBeenCalled();
    expect(mockCreateWidgetSnapshot).not.toHaveBeenCalled();
    expect(mockGenerateWidgetSnapshotUploadUrlFromWeb).not.toHaveBeenCalled();
    expect(mockCreateChatHistoryWidgetSnapshot).not.toHaveBeenCalled();

    unmount();
  });
});
