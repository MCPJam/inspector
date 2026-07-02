/**
 * WebMCP UI tools round-trip through the MCPJam agent hook:
 * the transport body ships the registry snapshot, a streamed `ui_*` tool
 * call is fulfilled in-page via `handleUiToolCall` → `addToolOutput`, and
 * the turn is configured to auto-resume once every tool call has output.
 *
 * The `Chat` instance is hoisted OUTSIDE React (agent-chat-instances.ts) so
 * an in-flight stream survives the hook unmounting — e.g. `ui_navigate`
 * leaving the Home takeover mid-turn. Transport/onToolCall/
 * sendAutomaticallyWhen are therefore asserted on the captured Chat init,
 * not on `useChat` options (the hook attaches via `useChat({ chat })`).
 */
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  lastChatInit: null as any,
  lastChatInstance: null as any,
  lastUseChatOptions: null as any,
  lastTransportOptions: null as any,
  addToolOutput: vi.fn(),
  sendMessage: vi.fn(),
  stop: vi.fn(),
  setMessages: vi.fn(),
  sendAutomaticallyWhenSentinel: vi.fn(),
  approvalsCompleteSentinel: vi.fn(),
}));

vi.mock("@ai-sdk/react", () => ({
  Chat: class MockChat {
    id: string;
    messages: unknown[] = [];
    status = "ready";
    addToolOutput = mockState.addToolOutput;
    constructor(init: { id: string }) {
      mockState.lastChatInit = init;
      mockState.lastChatInstance = this;
      this.id = init.id;
    }
  },
  useChat: vi.fn((options: unknown) => {
    mockState.lastUseChatOptions = options;
    return {
      messages: [],
      sendMessage: mockState.sendMessage,
      status: "ready",
      error: undefined,
      stop: mockState.stop,
      setMessages: mockState.setMessages,
    };
  }),
}));

vi.mock("ai", () => ({
  DefaultChatTransport: class MockTransport {
    constructor(options: unknown) {
      mockState.lastTransportOptions = options;
    }
  },
  generateId: vi.fn(() => "generated-session"),
  lastAssistantMessageIsCompleteWithToolCalls:
    mockState.sendAutomaticallyWhenSentinel,
  lastAssistantMessageIsCompleteWithApprovalResponses:
    mockState.approvalsCompleteSentinel,
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: vi.fn() }),
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: vi.fn(),
}));

vi.mock("@/hooks/use-hosted-org-model-config", () => ({
  useHostedOrgModelConfig: () => null,
}));

vi.mock("@/hooks/use-persisted-model", () => ({
  usePersistedModel: () => ({ selectedModelId: "gpt-4.1-mini" }),
}));

vi.mock("@/components/chat-v2/shared/model-helpers", () => ({
  buildAvailableModelsFromOrgConfig: vi.fn(() => []),
  getDefaultModel: vi.fn(() => undefined),
}));

vi.mock("@/lib/transcript-to-ui-messages", () => ({
  preserveHydratedMessageIds: vi.fn((_current: unknown, next: unknown) => next),
  transcriptToUIMessages: vi.fn(() => []),
}));

vi.mock("@/lib/apis/web/chat-history-api", () => ({
  getChatHistoryDetail: vi.fn(async () => null),
}));

vi.mock("@/lib/webmcp/native-mirror", () => ({
  mirrorUiToolToNative: vi.fn(() => null),
}));

import { useMcpjamAgentSession } from "../use-mcpjam-agent-session";
import { __resetAgentChatInstancesForTests } from "@/lib/mcpjam-agent/agent-chat-instances";
import {
  useUiToolsRegistry,
  type UiToolDefinition,
} from "@/lib/webmcp/ui-tools-registry";
import { getChatHistoryDetail } from "@/lib/apis/web/chat-history-api";
import { transcriptToUIMessages } from "@/lib/transcript-to-ui-messages";

const SESSION_ID = "agent-session-1";

function registerTool(extra?: Partial<UiToolDefinition>): UiToolDefinition {
  const def: UiToolDefinition = {
    name: "ui_navigate",
    description: "Navigate the MCPJam inspector",
    inputSchema: { type: "object", properties: {} },
    readOnly: false,
    execute: vi.fn(async () => ({
      content: [{ type: "text" as const, text: '{"ok":true}' }],
    })),
    ...extra,
  };
  useUiToolsRegistry.getState().registerUiTool(def);
  return def;
}

describe("useMcpjamAgentSession — WebMCP UI tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.lastChatInit = null;
    mockState.lastChatInstance = null;
    mockState.lastUseChatOptions = null;
    mockState.lastTransportOptions = null;
    __resetAgentChatInstancesForTests();
    useUiToolsRegistry.setState({
      tools: new Map(),
      nativeDisposers: new Map(),
      shippedNames: new Set(),
    });
  });

  function render() {
    return renderHook(() =>
      useMcpjamAgentSession({
        chatSessionId: SESSION_ID,
        projectId: "project-1",
      })
    );
  }

  it("attaches useChat to the hoisted Chat instance", async () => {
    render();
    await waitFor(() => expect(mockState.lastUseChatOptions).not.toBeNull());
    expect(mockState.lastUseChatOptions.chat).toBe(mockState.lastChatInstance);
  });

  it("ships the registry snapshot in the transport body", async () => {
    registerTool();
    render();

    await waitFor(() => expect(mockState.lastTransportOptions).not.toBeNull());
    const body = mockState.lastTransportOptions.body();
    expect(body.chatSessionId).toBe(SESSION_ID);
    expect(body.projectId).toBe("project-1");
    expect(body.uiTools).toEqual([
      {
        name: "ui_navigate",
        description: "Navigate the MCPJam inspector",
        inputSchema: { type: "object", properties: {} },
        readOnly: false,
      },
    ]);
    // Snapshotting marks the name as shipped (page-lifetime, no eviction).
    expect(useUiToolsRegistry.getState().wasShipped("ui_navigate")).toBe(true);
  });

  it("fulfills streamed ui_* tool calls via addToolOutput and auto-resumes", async () => {
    const def = registerTool();
    render();

    await waitFor(() => expect(mockState.lastChatInit).not.toBeNull());
    // The composed auto-resume predicate delegates to the SDK's
    // tool-calls-complete helper; with approval OFF (default) the
    // approval-responses branch never fires.
    const predicate = mockState.lastChatInit.sendAutomaticallyWhen;
    mockState.sendAutomaticallyWhenSentinel.mockReturnValueOnce(true);
    expect(predicate({ messages: [] })).toBe(true);
    mockState.sendAutomaticallyWhenSentinel.mockReturnValueOnce(false);
    mockState.approvalsCompleteSentinel.mockReturnValue(true);
    expect(predicate({ messages: [] })).toBe(false);
    expect(mockState.approvalsCompleteSentinel).not.toHaveBeenCalled();

    await mockState.lastChatInit.onToolCall({
      toolCall: {
        toolName: "ui_navigate",
        toolCallId: "tc-1",
        input: { target: "playground" },
      },
    });

    expect(def.execute).toHaveBeenCalledWith({ target: "playground" });
    expect(mockState.addToolOutput).toHaveBeenCalledWith({
      tool: "ui_navigate",
      toolCallId: "tc-1",
      output: { content: [{ type: "text", text: '{"ok":true}' }] },
    });
  });

  it("delivers the tool output even when the surface unmounts mid-execute", async () => {
    // The headline regression: `ui_navigate` from the Home takeover commits
    // the route (unmounting the hook) INSIDE execute. With the instance
    // hoisted, `addToolOutput` targets the instance — not the dead hook —
    // so the paused stream still resumes.
    let releaseExecute!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseExecute = resolve;
    });
    const def = registerTool({
      execute: vi.fn(async () => {
        await gate;
        return { content: [{ type: "text" as const, text: '{"ok":true}' }] };
      }),
    });
    const { unmount } = render();
    await waitFor(() => expect(mockState.lastChatInit).not.toBeNull());

    const callPromise = mockState.lastChatInit.onToolCall({
      toolCall: {
        toolName: "ui_navigate",
        toolCallId: "tc-unmount",
        input: { target: "servers" },
      },
    });
    unmount();
    releaseExecute();
    await callPromise;

    expect(def.execute).toHaveBeenCalled();
    expect(mockState.addToolOutput).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "tc-unmount" })
    );
  });

  it("never seeds hydrated history over a live instance", async () => {
    // Panel adoption during a navigation handoff mounts a second hook on an
    // instance that already holds the in-flight conversation. Hydration
    // must not setMessages() over it.
    vi.mocked(getChatHistoryDetail).mockResolvedValue({
      session: { messagesBlobUrl: "https://blob.example/transcript" },
    } as any);
    const hydrated = [{ id: "m1", role: "user", parts: [] }];
    vi.mocked(transcriptToUIMessages).mockReturnValue(hydrated as any);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, json: async () => [{}] } as any);
    try {
      // Pre-create the instance and make it look live before the hook mounts.
      const { getOrCreateAgentChat } = await import(
        "@/lib/mcpjam-agent/agent-chat-instances"
      );
      const entry = getOrCreateAgentChat(SESSION_ID);
      (entry.chat as any).messages = [{ id: "live", role: "user", parts: [] }];
      (entry.chat as any).status = "streaming";

      render();
      // Give hydration a chance to complete; the guard must have skipped it.
      await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 0));
      expect(mockState.setMessages).not.toHaveBeenCalled();
      expect(entry.config.seeded).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("seeds hydrated history into a fresh idle instance", async () => {
    vi.mocked(getChatHistoryDetail).mockResolvedValue({
      session: { messagesBlobUrl: "https://blob.example/transcript" },
    } as any);
    const hydrated = [{ id: "m1", role: "user", parts: [] }];
    vi.mocked(transcriptToUIMessages).mockReturnValue(hydrated as any);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: true, json: async () => [{}] } as any);
    try {
      render();
      await waitFor(() =>
        expect(mockState.setMessages).toHaveBeenCalledWith(hydrated)
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("answers shipped-then-unregistered tools with an error so the stream resumes", async () => {
    registerTool();
    render();
    await waitFor(() => expect(mockState.lastTransportOptions).not.toBeNull());
    mockState.lastTransportOptions.body(); // snapshot → marks shipped
    useUiToolsRegistry.getState().unregisterUiTool("ui_navigate");

    await mockState.lastChatInit.onToolCall({
      toolCall: { toolName: "ui_navigate", toolCallId: "tc-2", input: {} },
    });

    expect(mockState.addToolOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "tc-2",
        output: expect.objectContaining({ isError: true }),
      })
    );
  });

  it("leaves non-UI tool calls untouched (docs-server tools resolve server-side)", async () => {
    render();
    await waitFor(() => expect(mockState.lastChatInit).not.toBeNull());

    await mockState.lastChatInit.onToolCall({
      toolCall: { toolName: "search_docs", toolCallId: "tc-3", input: {} },
    });

    expect(mockState.addToolOutput).not.toHaveBeenCalled();
  });
});
