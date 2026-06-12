/**
 * WebMCP UI tools round-trip through the MCPJam agent hook:
 * the transport body ships the registry snapshot, a streamed `ui_*` tool
 * call is fulfilled in-page via `handleUiToolCall` → `addToolOutput`, and
 * the turn is configured to auto-resume once every tool call has output.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  lastUseChatOptions: null as any,
  lastTransportOptions: null as any,
  addToolOutput: vi.fn(),
  sendMessage: vi.fn(),
  stop: vi.fn(),
  setMessages: vi.fn(),
  sendAutomaticallyWhenSentinel: vi.fn(),
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: vi.fn((options: unknown) => {
    mockState.lastUseChatOptions = options;
    return {
      messages: [],
      sendMessage: mockState.sendMessage,
      status: "ready",
      error: undefined,
      stop: mockState.stop,
      setMessages: mockState.setMessages,
      addToolOutput: mockState.addToolOutput,
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
import {
  useUiToolsRegistry,
  type UiToolDefinition,
} from "@/lib/webmcp/ui-tools-registry";

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
    mockState.lastUseChatOptions = null;
    mockState.lastTransportOptions = null;
    useUiToolsRegistry.setState({
      tools: new Map(),
      nativeDisposers: new Map(),
      shippedNamesBySession: new Map(),
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

  it("ships the registry snapshot in the transport body", async () => {
    registerTool();
    render();

    await waitFor(() => expect(mockState.lastTransportOptions).not.toBeNull());
    const body = mockState.lastTransportOptions.body();
    expect(body.chatSessionId).toBe(SESSION_ID);
    expect(body.uiTools).toEqual([
      {
        name: "ui_navigate",
        description: "Navigate the MCPJam inspector",
        inputSchema: { type: "object", properties: {} },
        readOnly: false,
      },
    ]);
    // Snapshotting marks the name as shipped for THIS session.
    expect(
      useUiToolsRegistry.getState().wasShipped("ui_navigate", SESSION_ID)
    ).toBe(true);
  });

  it("fulfills streamed ui_* tool calls via addToolOutput and auto-resumes", async () => {
    const def = registerTool();
    render();

    await waitFor(() => expect(mockState.lastUseChatOptions).not.toBeNull());
    // The turn resumes automatically once every tool call has an output —
    // the predicate identity is the contract with the AI SDK.
    expect(mockState.lastUseChatOptions.sendAutomaticallyWhen).toBe(
      mockState.sendAutomaticallyWhenSentinel
    );

    await mockState.lastUseChatOptions.onToolCall({
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

  it("answers shipped-then-unregistered tools with an error so the stream resumes", async () => {
    registerTool();
    render();
    await waitFor(() => expect(mockState.lastTransportOptions).not.toBeNull());
    mockState.lastTransportOptions.body(); // snapshot → marks shipped
    useUiToolsRegistry.getState().unregisterUiTool("ui_navigate");

    await mockState.lastUseChatOptions.onToolCall({
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
    await waitFor(() => expect(mockState.lastUseChatOptions).not.toBeNull());

    await mockState.lastUseChatOptions.onToolCall({
      toolCall: { toolName: "search_docs", toolCallId: "tc-3", input: {} },
    });

    expect(mockState.addToolOutput).not.toHaveBeenCalled();
  });
});
