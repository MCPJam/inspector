import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSharedChatWidgetCapture } from "../useSharedChatWidgetCapture";
import { useWidgetDebugStore } from "@/stores/widget-debug-store";

const mockCreateWidgetSnapshot = vi.fn();
const mockGetConvexAccessToken = vi.fn();

vi.mock("convex/react", () => ({
  useMutation: (name: string) => {
    if (name === "chatSessions:createWidgetSnapshot") {
      return mockCreateWidgetSnapshot;
    }
    throw new Error(`Unexpected mutation: ${name}`);
  },
}));

// Snapshot bytes go to the backend's upload route as the current actor.
vi.mock("@/lib/convex-site-url", () => ({
  getConvexSiteUrl: () => "https://demo.convex.site",
}));
vi.mock("@/hooks/use-convex-access-token", () => ({
  useConvexAccessToken: () => mockGetConvexAccessToken,
}));

const originalFetch = global.fetch;

function refusedUpload(
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
) {
  return new Response(
    JSON.stringify({
      ok: false,
      code,
      error: "The upload was refused.",
      ...extra,
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

/** How the upload route answers a scenario grant whose version moved. */
function staleGrantUpload() {
  return refusedUpload(403, "FORBIDDEN", {
    reason: "scenario_access_stale",
    currentAccessVersion: 7,
  });
}

function uploadCalls() {
  return vi.mocked(global.fetch).mock.calls as unknown as Array<
    [string, RequestInit]
  >;
}

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
    mockGetConvexAccessToken.mockResolvedValue("bearer-1");
    mockCreateWidgetSnapshot.mockResolvedValue("snapshot-1");

    global.fetch = vi.fn(async () => {
      uploadCounter += 1;
      return new Response(
        JSON.stringify({ ok: true, storageId: `blob-${uploadCounter}` }),
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
        hostedScenarioId: "cbx_1", hostedAccessVersion: 1,
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
    expect(global.fetch).toHaveBeenCalledTimes(3);
    // Every blob goes to the upload route, scoped to this chat and to the
    // redeemed scenario access, with the actor's bearer.
    for (const [url, init] of uploadCalls()) {
      const parsed = new URL(url);
      expect(`${parsed.origin}${parsed.pathname}`).toBe(
        "https://demo.convex.site/web/uploads/blob",
      );
      expect(Object.fromEntries(parsed.searchParams)).toEqual({
        purpose: "widget-snapshot",
        chatSessionId: "chat-session-1",
        scenarioId: "cbx_1",
        accessVersion: "1",
      });
      expect(init.method).toBe("POST");
      expect(init.headers).toMatchObject({
        Authorization: "Bearer bearer-1",
      });
    }
    // Widget HTML is uploaded as text so storage never serves it as a page;
    // the tool payloads stay JSON.
    const uploadedTypes = vi
      .mocked(global.fetch)
      .mock.calls.map(([, init]) => (init?.body as Blob).type)
      .sort();
    expect(uploadedTypes).toEqual([
      "application/json",
      "application/json",
      "text/plain; charset=utf-8",
    ]);
    expect(mockCreateWidgetSnapshot).toHaveBeenCalledWith({
      scenarioId: "cbx_1", accessVersion: 1,
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
          hostedScenarioId: "cbx_1", hostedAccessVersion: 1,
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

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockCreateWidgetSnapshot).not.toHaveBeenCalled();

    rerender({ readyToPersist: true });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    await flushMicrotasks();

    expect(mockCreateWidgetSnapshot).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledTimes(3);

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
          hostedScenarioId: "cbx_1", hostedAccessVersion: 1,
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
          hostedScenarioId: "cbx_1", hostedAccessVersion: 1,
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

  it("uploads scenario widget snapshots with the originating server id", async () => {
    const { unmount } = renderHook(() =>
      useSharedChatWidgetCapture({
        enabled: true,
        chatSessionId: "chat-session-2",
        hostedScenarioId: "cbx_1", hostedAccessVersion: 1,
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            parts: [
              {
                type: "tool-search",
                toolCallId: "call-2",
                input: { q: "scenario" },
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
              widgetHtml: "<div>Scenario widget</div>",
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
      scenarioId: "cbx_1", accessVersion: 1,
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

  it("requests a hosted-access refresh on scenario_access_stale and skips the local retry", async () => {
    const onStaleHostedAccess = vi.fn();
    global.fetch = vi.fn(async () => staleGrantUpload()) as typeof fetch;

    const { unmount } = renderHook(() =>
      useSharedChatWidgetCapture({
        enabled: true,
        chatSessionId: "chat-session-stale",
        hostedScenarioId: "cbx_1",
        hostedAccessVersion: 1,
        onStaleHostedAccess,
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            parts: [
              {
                type: "tool-search",
                toolCallId: "call-stale",
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
            "call-stale",
            {
              toolCallId: "call-stale",
              toolName: "search",
              protocol: "mcp-apps",
              widgetState: null,
              globals: { theme: "dark", displayMode: "inline" },
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

    // One initial upload flight (three concurrent uploadBlob calls, one
    // per blob) — Promise.all rejects on the first stale error and
    // suppresses the local snapshot-retry path.
    const generateCallsAfterFlight = uploadCalls().length;
    expect(generateCallsAfterFlight).toBeGreaterThanOrEqual(1);
    expect(onStaleHostedAccess).toHaveBeenCalled();
    expect(mockCreateWidgetSnapshot).not.toHaveBeenCalled();

    // No local *snapshot* retry should be scheduled — the upload call
    // count must stay flat even as the
    // refresh-backoff timer fires repeatedly. (The refresh callback
    // itself is allowed to be re-invoked on a bounded backoff; that
    // behaviour is covered by a dedicated test.)
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    await flushMicrotasks();

    expect(uploadCalls().length).toBe(generateCallsAfterFlight);

    unmount();
  });

  it("retries stale snapshots even after the first refresh callback fails to advance accessVersion", async () => {
    // P2 from review: if the parent's /redeem fetch fails, hostedAccessVersion
    // never bumps, so the reset effect never runs. The hook must still fire
    // onStaleHostedAccess on subsequent stale errors instead of latching
    // permanently.
    const onStaleHostedAccess = vi.fn();
    global.fetch = vi.fn(async () => staleGrantUpload()) as typeof fetch;

    const { unmount } = renderHook(() =>
      useSharedChatWidgetCapture({
        enabled: true,
        chatSessionId: "chat-session-refresh-fail",
        hostedScenarioId: "cbx_1",
        hostedAccessVersion: 1,
        onStaleHostedAccess,
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            parts: [
              {
                type: "tool-search",
                toolCallId: "call-a",
                input: { q: "a" },
                output: { result: "a", _serverId: "server-1" },
              },
              {
                type: "tool-search",
                toolCallId: "call-b",
                input: { q: "b" },
                output: { result: "b", _serverId: "server-1" },
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
            "call-a",
            {
              toolCallId: "call-a",
              toolName: "search",
              protocol: "mcp-apps",
              widgetState: null,
              globals: { theme: "dark", displayMode: "inline" },
              widgetHtml: "<div>A</div>",
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
    expect(onStaleHostedAccess).toHaveBeenCalledTimes(1);

    // Parent's /redeem call failed silently — hostedAccessVersion did not
    // advance. A second widget showing up later must still trigger another
    // refresh, not get blocked by a stuck latch.
    act(() => {
      useWidgetDebugStore.setState({
        widgets: new Map([
          [
            "call-b",
            {
              toolCallId: "call-b",
              toolName: "search",
              protocol: "mcp-apps",
              widgetState: null,
              globals: { theme: "dark", displayMode: "inline" },
              widgetHtml: "<div>B</div>",
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
    expect(onStaleHostedAccess.mock.calls.length).toBeGreaterThanOrEqual(2);

    unmount();
  });

  it("re-fires the refresh callback on a backoff while the queue is non-empty", async () => {
    // Codex P2: if the parent's redeem fails (accessVersion never bumps),
    // the queued stale snapshot must not be stranded — the hook should
    // retry the refresh on a bounded backoff so the parent gets another
    // chance.
    const onStaleHostedAccess = vi.fn();
    global.fetch = vi.fn(async () => staleGrantUpload()) as typeof fetch;

    const { unmount } = renderHook(() =>
      useSharedChatWidgetCapture({
        enabled: true,
        chatSessionId: "chat-session-backoff",
        hostedScenarioId: "cbx_1",
        hostedAccessVersion: 1,
        onStaleHostedAccess,
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            parts: [
              {
                type: "tool-search",
                toolCallId: "call-backoff",
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
            "call-backoff",
            {
              toolCallId: "call-backoff",
              toolName: "search",
              protocol: "mcp-apps",
              widgetState: null,
              globals: { theme: "dark", displayMode: "inline" },
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
    expect(onStaleHostedAccess).toHaveBeenCalledTimes(1);

    // Parent's redeem failed: accessVersion never advanced. The backoff
    // timer should re-fire the callback after ~1s.
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    await flushMicrotasks();
    expect(onStaleHostedAccess.mock.calls.length).toBeGreaterThanOrEqual(2);

    // And again after ~2s more (next backoff tick).
    act(() => {
      vi.advanceTimersByTime(2100);
    });
    await flushMicrotasks();
    expect(onStaleHostedAccess.mock.calls.length).toBeGreaterThanOrEqual(3);

    unmount();
  });

  it("does not write to the new scope when chatSessionId changes mid-upload", async () => {
    // CodeRabbit Major: an in-flight uploadAttemptRef started for chat A
    // must not call createWidgetSnapshot against chat B's refs after a
    // chatSessionId change.
    let resolveCreateWidgetSnapshot: ((value: unknown) => void) | null = null;
    mockCreateWidgetSnapshot.mockReset();
    mockCreateWidgetSnapshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreateWidgetSnapshot = resolve;
        }),
    );

    const { rerender, unmount } = renderHook(
      ({ chatSessionId }: { chatSessionId: string }) =>
        useSharedChatWidgetCapture({
          enabled: true,
          chatSessionId,
          hostedScenarioId: "cbx_1",
          hostedAccessVersion: 1,
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              parts: [
                {
                  type: "tool-search",
                  toolCallId: "call-race",
                  input: { q: "race" },
                  output: { result: "ok", _serverId: "server-1" },
                },
              ],
            } as any,
          ],
        }),
      { initialProps: { chatSessionId: "chat-A" } },
    );

    act(() => {
      useWidgetDebugStore.setState({
        widgets: new Map([
          [
            "call-race",
            {
              toolCallId: "call-race",
              toolName: "search",
              protocol: "mcp-apps",
              widgetState: null,
              globals: { theme: "dark", displayMode: "inline" },
              widgetHtml: "<div>Race</div>",
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

    // createWidgetSnapshot is awaiting; identity now changes.
    expect(mockCreateWidgetSnapshot).toHaveBeenCalledTimes(1);
    rerender({ chatSessionId: "chat-B" });
    await flushMicrotasks();

    // Resolve the pending mutation as if it succeeded for chat A.
    act(() => {
      resolveCreateWidgetSnapshot?.("snapshot-A");
    });
    await flushMicrotasks();

    // The hook must not have written into chat B's bookkeeping refs. The
    // observable signal: re-supplying the same widget after the rerender
    // should NOT be treated as a duplicate. Bump the widget so the capture
    // loop kicks again under chat-B.
    act(() => {
      useWidgetDebugStore.setState({
        widgets: new Map([
          [
            "call-race",
            {
              toolCallId: "call-race",
              toolName: "search",
              protocol: "mcp-apps",
              widgetState: null,
              globals: { theme: "dark", displayMode: "inline" },
              widgetHtml: "<div>Race v2</div>",
              updatedAt: Date.now() + 1,
            },
          ],
        ]),
      });
    });

    // Swap the createWidgetSnapshot mock to resolve immediately for the
    // chat-B attempt.
    mockCreateWidgetSnapshot.mockImplementation(async () => "snapshot-B");

    act(() => {
      vi.advanceTimersByTime(500);
    });
    await flushMicrotasks();

    // A second createWidgetSnapshot call should have happened under chat-B
    // — proving the leaked chat-A success did not poison the
    // uploadedHashes / cachedBlobs maps.
    expect(mockCreateWidgetSnapshot).toHaveBeenCalledTimes(2);
    expect(mockCreateWidgetSnapshot.mock.calls[1][0].chatSessionId).toBe(
      "chat-B",
    );

    unmount();
  });

  it("replays stale-failed snapshots when a fresh accessVersion arrives", async () => {
    const onStaleHostedAccess = vi.fn();

    let uploadCounter = 0;
    global.fetch = vi.fn(async () => {
      uploadCounter += 1;
      return staleGrantUpload();
    }) as typeof fetch;

    const { rerender, unmount } = renderHook(
      ({ hostedAccessVersion }: { hostedAccessVersion: number }) =>
        useSharedChatWidgetCapture({
          enabled: true,
          chatSessionId: "chat-session-replay",
          hostedScenarioId: "cbx_1",
          hostedAccessVersion,
          onStaleHostedAccess,
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              parts: [
                {
                  type: "tool-search",
                  toolCallId: "call-replay",
                  input: { q: "hello" },
                  output: { result: "world", _serverId: "server-1" },
                },
              ],
            } as any,
          ],
        }),
      { initialProps: { hostedAccessVersion: 1 } },
    );

    act(() => {
      useWidgetDebugStore.setState({
        widgets: new Map([
          [
            "call-replay",
            {
              toolCallId: "call-replay",
              toolName: "search",
              protocol: "mcp-apps",
              widgetState: null,
              globals: { theme: "dark", displayMode: "inline" },
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
    const generateCallsAfterFirstFlight = uploadCalls().length;
    expect(generateCallsAfterFirstFlight).toBeGreaterThanOrEqual(1);
    expect(onStaleHostedAccess).toHaveBeenCalledTimes(1);
    expect(mockCreateWidgetSnapshot).not.toHaveBeenCalled();

    // Parent's silent re-redeem hands back a fresh accessVersion. Swap the
    // mock to resolve so the replay actually succeeds end-to-end.
    vi.mocked(global.fetch).mockImplementation(async () => {
      uploadCounter += 1;
      return new Response(
        JSON.stringify({ ok: true, storageId: `blob-${uploadCounter}` }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    rerender({ hostedAccessVersion: 2 });

    await flushMicrotasks();

    expect(uploadCalls().length).toBeGreaterThan(generateCallsAfterFirstFlight);
    expect(mockCreateWidgetSnapshot).toHaveBeenCalledTimes(1);
    expect(mockCreateWidgetSnapshot.mock.calls[0][0]).toMatchObject({
      scenarioId: "cbx_1",
      accessVersion: 2,
      chatSessionId: "chat-session-replay",
      toolCallId: "call-replay",
    });
    // The replayed uploads carry the fresh access version too.
    const [replayUrl] = uploadCalls()[uploadCalls().length - 1]!;
    expect(new URL(replayUrl).searchParams.get("accessVersion")).toBe("2");

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

    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockCreateWidgetSnapshot).not.toHaveBeenCalled();

    unmount();
  });
  describe("upload route answers", () => {
    function renderWithOneWidget(options: {
      hostedScenarioId?: string;
      onStaleHostedAccess?: () => void;
    }) {
      const hook = renderHook(() =>
        useSharedChatWidgetCapture({
          enabled: true,
          chatSessionId: "chat-direct",
          ...(options.hostedScenarioId
            ? {
                hostedScenarioId: options.hostedScenarioId,
                hostedAccessVersion: 1,
              }
            : {}),
          onStaleHostedAccess: options.onStaleHostedAccess,
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
                globals: { theme: "dark", displayMode: "inline" },
                widgetHtml: "<div>Widget</div>",
                updatedAt: Date.now(),
              },
            ],
          ]),
        });
      });
      return hook;
    }

    async function settle(ms: number) {
      act(() => {
        vi.advanceTimersByTime(ms);
      });
      await flushMicrotasks();
    }

    it("scopes a direct chat's uploads to the chat alone", async () => {
      const { unmount } = renderWithOneWidget({});
      await settle(500);

      expect(uploadCalls()).toHaveLength(3);
      for (const [url] of uploadCalls()) {
        expect(Object.fromEntries(new URL(url).searchParams)).toEqual({
          purpose: "widget-snapshot",
          chatSessionId: "chat-direct",
        });
      }
      expect(mockCreateWidgetSnapshot).toHaveBeenCalledTimes(1);
      expect(mockCreateWidgetSnapshot.mock.calls[0][0]).toMatchObject({
        chatSessionId: "chat-direct",
        widgetHtmlBlobId: expect.stringMatching(/^blob-/),
      });
      expect(mockCreateWidgetSnapshot.mock.calls[0][0]).not.toHaveProperty(
        "scenarioId",
      );
      unmount();
    });

    it("treats a refused direct-chat upload as final", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const onStaleHostedAccess = vi.fn();
      global.fetch = vi.fn(async () =>
        refusedUpload(403, "FORBIDDEN"),
      ) as typeof fetch;

      const { unmount } = renderWithOneWidget({ onStaleHostedAccess });
      await settle(500);
      const uploadsAfterFirstAttempt = uploadCalls().length;
      await settle(60_000);

      expect(uploadsAfterFirstAttempt).toBeGreaterThanOrEqual(1);
      expect(uploadCalls()).toHaveLength(uploadsAfterFirstAttempt);
      expect(onStaleHostedAccess).not.toHaveBeenCalled();
      expect(mockCreateWidgetSnapshot).not.toHaveBeenCalled();
      unmount();
      warn.mockRestore();
    });

    it.each([
      [403, "FORBIDDEN"],
      [413, "PAYLOAD_TOO_LARGE"],
      [415, "UNSUPPORTED_MEDIA_TYPE"],
    ])(
      "gives up on a %i without a refresh or a local retry",
      async (status, code) => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const onStaleHostedAccess = vi.fn();
        global.fetch = vi.fn(async () =>
          refusedUpload(status, code),
        ) as typeof fetch;

        const { unmount } = renderWithOneWidget({
          hostedScenarioId: "cbx_1",
          onStaleHostedAccess,
        });
        await settle(500);
        const uploadsAfterFirstAttempt = uploadCalls().length;
        await settle(60_000);

        expect(uploadCalls()).toHaveLength(uploadsAfterFirstAttempt);
        expect(onStaleHostedAccess).not.toHaveBeenCalled();
        expect(mockCreateWidgetSnapshot).not.toHaveBeenCalled();
        unmount();
        warn.mockRestore();
      },
    );

    it.each([
      [401, "UNAUTHORIZED"],
      [429, "RATE_LIMITED"],
    ])(
      "retries a %i on the bounded backoff, then gives up",
      async (status, code) => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const onStaleHostedAccess = vi.fn();
        global.fetch = vi.fn(async () =>
          refusedUpload(status, code),
        ) as typeof fetch;

        const { unmount } = renderWithOneWidget({
          hostedScenarioId: "cbx_1",
          onStaleHostedAccess,
        });
        await settle(500);
        for (let tick = 0; tick < 12; tick += 1) {
          await settle(11_000);
        }

        // One attempt plus five retries, three blobs each, and a bearer
        // resolved afresh for every upload.
        expect(uploadCalls()).toHaveLength(18);
        expect(mockGetConvexAccessToken).toHaveBeenCalledTimes(18);
        expect(onStaleHostedAccess).not.toHaveBeenCalled();
        expect(mockCreateWidgetSnapshot).not.toHaveBeenCalled();
        unmount();
        warn.mockRestore();
      },
    );

    it("uploads nothing when no bearer resolves", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockGetConvexAccessToken.mockResolvedValue(null);

      const { unmount } = renderWithOneWidget({});
      await settle(500);

      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockCreateWidgetSnapshot).not.toHaveBeenCalled();
      unmount();
      warn.mockRestore();
    });
  });
});
