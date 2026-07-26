import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createElement } from "react";

import { classifySelectedTool, useToolExecution } from "../useToolExecution";
import {
  useAppToolsRegistry,
  type AppInstance,
  type AppToolDescriptor,
} from "@/components/chat-v2/thread/mcp-apps/app-tools-registry";
import { AppStateProvider } from "@/state/app-state-context";
import type { AppState, ServerWithName } from "@/state/app-types";

// --- Mocks ------------------------------------------------------------------

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({
    capture: vi.fn(),
  }),
}));

vi.mock("@/lib/PosthogUtils", () => ({
  detectEnvironment: vi.fn().mockReturnValue("test"),
  detectPlatform: vi.fn().mockReturnValue("web"),
}));

const mockExecuteToolApi = vi.fn();
vi.mock("@/lib/apis/mcp-tools-api", () => ({
  executeToolApi: (...args: unknown[]) => mockExecuteToolApi(...args),
}));

const mockReadResource = vi.fn();
vi.mock("@/lib/apis/mcp-resources-api", () => ({
  readResource: (...args: unknown[]) => mockReadResource(...args),
}));

const mockApplyToolCallStepUp = vi.fn();
const mockResetToolCallStepUp = vi.fn();
vi.mock("@/state/oauth-orchestrator", () => ({
  applyToolCallStepUp: (...args: unknown[]) =>
    mockApplyToolCallStepUp(...args),
  resetToolCallStepUp: (...args: unknown[]) =>
    mockResetToolCallStepUp(...args),
}));

// --- Helpers ----------------------------------------------------------------

function tool(
  name: string,
  extra?: Partial<AppToolDescriptor>
): AppToolDescriptor {
  return {
    name,
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
    ...extra,
  };
}

function makeInstance(
  bridgeId: string,
  tools: AppToolDescriptor[],
  callTool: AppInstance["bridge"]["callTool"]
): AppInstance {
  return {
    bridgeId,
    parentToolCallId: "call-1",
    serverId: "srv-1",
    appName: "Demo",
    appVersion: "1.0.0",
    surface: "inline",
    bridge: { callTool } as unknown as AppInstance["bridge"],
    tools,
    registeredAtMs: Date.now(),
  };
}

function makeHookOptions(overrides?: {
  serverName?: string;
  selectedTool?: string | null;
}) {
  return {
    serverName: overrides?.serverName ?? "srv-1",
    selectedTool: overrides?.selectedTool ?? null,
    toolsMetadata: {},
    formFields: [],
    setIsExecuting: vi.fn(),
    setExecutionError: vi.fn(),
    setToolOutput: vi.fn(),
    setToolResponseMetadata: vi.fn(),
  };
}

beforeEach(() => {
  useAppToolsRegistry.setState({
    instancesByBridgeId: new Map(),
    aliases: new Map(),
    activeBridgeByParent: new Map(),
    pendingControllers: new Map(),
  });
  mockExecuteToolApi.mockReset();
  mockReadResource.mockReset();
  mockApplyToolCallStepUp.mockReset();
  mockApplyToolCallStepUp.mockResolvedValue({ action: "throw" });
  mockResetToolCallStepUp.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- Tests ------------------------------------------------------------------

describe("classifySelectedTool", () => {
  it("returns null when no tool is selected", () => {
    expect(classifySelectedTool(null)).toBeNull();
  });

  it("classifies a name not in the alias registry as a server tool", () => {
    expect(classifySelectedTool("get_weather")).toEqual({
      kind: "server",
      name: "get_weather",
    });
  });

  it("classifies a registered alias as an app tool", async () => {
    await useAppToolsRegistry
      .getState()
      .registerInstance(makeInstance("b-1", [tool("ping")], vi.fn()));
    const alias = [...useAppToolsRegistry.getState().aliases.keys()][0];
    expect(classifySelectedTool(alias)).toEqual({ kind: "app", alias });
  });

  it("classifies an alias-shaped handle as app even when registry forgot it", () => {
    // Mimics the post-iframe-teardown case: the alias survives in
    // `selectedTool` but the registry no longer carries it.
    expect(classifySelectedTool("app_deadbeef")).toEqual({
      kind: "app",
      alias: "app_deadbeef",
    });
  });
});

describe("useToolExecution app-tool routing", () => {
  it("server tool still calls executeToolApi and never touches the bridge", async () => {
    const callTool = vi.fn();
    await useAppToolsRegistry
      .getState()
      .registerInstance(makeInstance("b-1", [tool("ping")], callTool));

    mockExecuteToolApi.mockResolvedValueOnce({
      status: "completed",
      result: { content: [{ type: "text", text: "ok" }] },
    });

    const { result } = renderHook(() =>
      useToolExecution(makeHookOptions({ selectedTool: "get_weather" }))
    );

    let outcome:
      | Awaited<ReturnType<typeof result.current.executeTool>>
      | undefined;
    await act(async () => {
      outcome = await result.current.executeTool({
        parameters: { city: "NYC" },
      });
    });

    expect(mockExecuteToolApi).toHaveBeenCalledWith("srv-1", "get_weather", {
      city: "NYC",
    });
    expect(callTool).not.toHaveBeenCalled();
    expect(outcome?.ok).toBe(true);
    expect(result.current.pendingExecution?.toolMeta?._serverId).toBe("srv-1");
  });

  it("resolves linked image resources into model output for manual server tool runs", async () => {
    const rawResult = {
      content: [
        {
          type: "resource_link",
          uri: "example://linked-image.png",
          name: "Linked PNG resource",
          mimeType: "image/png",
        },
      ],
    };
    mockExecuteToolApi.mockResolvedValueOnce({
      status: "completed",
      result: rawResult,
    });
    mockReadResource.mockResolvedValueOnce({
      content: {
        contents: [
          {
            uri: "example://linked-image.png",
            blob: "aGVsbG8=",
            mimeType: "image/png",
          },
        ],
      },
    });

    const { result } = renderHook(() =>
      useToolExecution({
        ...makeHookOptions({ selectedTool: "qa_return_linked_image_resource" }),
      })
    );

    await act(async () => {
      await result.current.executeTool({ parameters: {} });
    });

    expect(mockReadResource).toHaveBeenCalledWith(
      "srv-1",
      "example://linked-image.png"
    );
    expect(result.current.pendingExecution?.result).toBe(rawResult);
    expect(result.current.pendingExecution?.modelOutput).toEqual({
      type: "content",
      value: [{ type: "media", data: "aGVsbG8=", mediaType: "image/png" }],
    });
  });

  it("keeps manual server tool runs successful when linked image enrichment fails", async () => {
    const rawResult = {
      content: [
        {
          type: "resource_link",
          uri: "example://linked-image.png",
          name: "Linked PNG resource",
          mimeType: "image/png",
        },
      ],
    };
    mockExecuteToolApi.mockResolvedValueOnce({
      status: "completed",
      result: rawResult,
    });
    mockReadResource.mockRejectedValueOnce(new Error("read failed"));

    const { result } = renderHook(() =>
      useToolExecution({
        ...makeHookOptions({ selectedTool: "qa_return_linked_image_resource" }),
      })
    );

    let outcome:
      | Awaited<ReturnType<typeof result.current.executeTool>>
      | undefined;
    await act(async () => {
      outcome = await result.current.executeTool({ parameters: {} });
    });

    expect(outcome?.ok).toBe(true);
    expect(result.current.pendingExecution?.result).toBe(rawResult);
    expect(result.current.pendingExecution?.modelOutput).toBeUndefined();
  });

  it("does not resolve linked image resources when linked image output is disabled", async () => {
    mockExecuteToolApi.mockResolvedValueOnce({
      status: "completed",
      result: {
        content: [
          {
            type: "resource_link",
            uri: "example://linked-image.png",
            mimeType: "image/png",
          },
        ],
      },
    });

    const { result } = renderHook(() =>
      useToolExecution({
        ...makeHookOptions({ selectedTool: "qa_return_linked_image_resource" }),
        modelVisibleMcpToolResults: {
          linkedResources: { blob: { image: false } },
        },
      })
    );

    await act(async () => {
      await result.current.executeTool({ parameters: {} });
    });

    expect(mockReadResource).not.toHaveBeenCalled();
    expect(result.current.pendingExecution?.modelOutput).toEqual({
      type: "content",
      value: [
        { type: "text", text: "[resource link omitted: policy disabled]" },
      ],
    });
  });

  it("app tool dispatches via bridge.callTool with rawName, not the alias", async () => {
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "from app" }],
    });
    await useAppToolsRegistry
      .getState()
      .registerInstance(makeInstance("b-1", [tool("draw_chart")], callTool));
    const alias = [...useAppToolsRegistry.getState().aliases.keys()][0];

    const { result } = renderHook(() =>
      useToolExecution(makeHookOptions({ selectedTool: alias }))
    );

    let outcome:
      | Awaited<ReturnType<typeof result.current.executeTool>>
      | undefined;
    await act(async () => {
      outcome = await result.current.executeTool({
        parameters: { kind: "bar" },
      });
    });

    // Critical: dispatched with the raw tool name, never the alias.
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith({
      name: "draw_chart",
      arguments: { kind: "bar" },
    });
    expect(mockExecuteToolApi).not.toHaveBeenCalled();
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok) {
      // The completed-tool record uses the rawName so the UI doesn't show
      // a synthetic `app_<hash>` label.
      expect(outcome.toolName).toBe("draw_chart");
    }
  });

  it("keeps app tool runs successful when linked image enrichment fails", async () => {
    const rawResult = {
      content: [
        {
          type: "resource_link",
          uri: "example://linked-image.png",
          name: "Linked PNG resource",
          mimeType: "image/png",
        },
      ],
    };
    const callTool = vi.fn().mockResolvedValue(rawResult);
    await useAppToolsRegistry
      .getState()
      .registerInstance(
        makeInstance("b-1", [tool("qa_return_linked_image_resource")], callTool)
      );
    const alias = [...useAppToolsRegistry.getState().aliases.keys()][0];
    mockReadResource.mockRejectedValueOnce(new Error("read failed"));

    const { result } = renderHook(() =>
      useToolExecution({
        ...makeHookOptions({ selectedTool: alias }),
      })
    );

    let outcome:
      | Awaited<ReturnType<typeof result.current.executeTool>>
      | undefined;
    await act(async () => {
      outcome = await result.current.executeTool({ parameters: {} });
    });

    expect(outcome?.ok).toBe(true);
    expect(result.current.pendingExecution?.result).toBe(rawResult);
    expect(result.current.pendingExecution?.modelOutput).toBeUndefined();
  });

  it("stale alias returns a clear error and never calls the MCP server", async () => {
    const { result } = renderHook(() =>
      useToolExecution(makeHookOptions({ selectedTool: "app_deadbeef" }))
    );

    let outcome:
      | Awaited<ReturnType<typeof result.current.executeTool>>
      | undefined;
    await act(async () => {
      outcome = await result.current.executeTool({ parameters: {} });
    });

    expect(outcome?.ok).toBe(false);
    if (outcome && !outcome.ok) {
      expect(outcome.error).toMatch(/no longer available/i);
      expect(outcome.toolName).toBe("app_deadbeef");
    }
    expect(mockExecuteToolApi).not.toHaveBeenCalled();
  });

  it("stores the unscrubbed CallToolResult so the playground can inspect _meta", async () => {
    const raw = {
      content: [{ type: "text", text: "from app" }],
      structuredContent: { score: 42 },
      _meta: { "mcpjam.test": true },
    };
    const callTool = vi.fn().mockResolvedValue(raw);
    await useAppToolsRegistry
      .getState()
      .registerInstance(makeInstance("b-1", [tool("draw_chart")], callTool));
    const alias = [...useAppToolsRegistry.getState().aliases.keys()][0];

    const options = makeHookOptions({ selectedTool: alias });
    const { result } = renderHook(() => useToolExecution(options));

    await act(async () => {
      await result.current.executeTool({ parameters: {} });
    });

    // The playground's inspector pane reads `setToolOutput` — assert the full
    // raw payload landed there (including `structuredContent` + `_meta`).
    expect(options.setToolOutput).toHaveBeenCalledWith(raw);
    // `_meta` is extracted into the response-metadata slot for the UI badge.
    expect(options.setToolResponseMetadata).toHaveBeenCalledWith({
      "mcpjam.test": true,
    });
  });

  it("registers and unregisters the pending controller on the bridge's bridgeId", async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [] });
    await useAppToolsRegistry
      .getState()
      .registerInstance(makeInstance("b-1", [tool("draw_chart")], callTool));
    const alias = [...useAppToolsRegistry.getState().aliases.keys()][0];

    const { result } = renderHook(() =>
      useToolExecution(makeHookOptions({ selectedTool: alias }))
    );

    await act(async () => {
      await result.current.executeTool({ parameters: {} });
    });

    // After settle, the pending set should be empty (or absent) — the
    // dispatch path must clean up after itself even on success.
    const pending = useAppToolsRegistry
      .getState()
      .pendingControllers.get("b-1");
    expect(pending === undefined || pending.size === 0).toBe(true);
  });

  it("app tool dispatch can still execute without a connected MCP server", async () => {
    // Regression guard: server tools require `effectiveServerName`. App
    // tools must not — the iframe owns its own connection.
    const callTool = vi.fn().mockResolvedValue({ content: [] });
    await useAppToolsRegistry
      .getState()
      .registerInstance(makeInstance("b-1", [tool("draw_chart")], callTool));
    const alias = [...useAppToolsRegistry.getState().aliases.keys()][0];

    const { result } = renderHook(() =>
      useToolExecution({
        ...makeHookOptions({ selectedTool: alias }),
        serverName: undefined,
      })
    );

    let outcome:
      | Awaited<ReturnType<typeof result.current.executeTool>>
      | undefined;
    await act(async () => {
      outcome = await result.current.executeTool({ parameters: {} });
    });

    expect(outcome?.ok).toBe(true);
    expect(callTool).toHaveBeenCalled();
  });
});

describe("useToolExecution step-up (SEP-2350)", () => {
  function withServer(server: ServerWithName) {
    const appState = {
      servers: { [server.name]: server },
    } as unknown as AppState;
    return ({ children }: { children: React.ReactNode }) =>
      createElement(AppStateProvider, { appState }, children);
  }

  const server = {
    name: "srv-1",
    connectionStatus: "connected",
  } as unknown as ServerWithName;

  it("drives applyToolCallStepUp on a 403 insufficient_scope response", async () => {
    mockExecuteToolApi.mockResolvedValueOnce({
      error: "Insufficient scope",
      insufficientScope: {
        requiredScope: "read write admin",
        resourceMetadataUrl: "https://rs.example/.well-known",
      },
    });

    const { result } = renderHook(
      () => useToolExecution(makeHookOptions({ selectedTool: "get_weather" })),
      { wrapper: withServer(server) },
    );

    await act(async () => {
      await result.current.executeTool({ parameters: {} });
    });

    expect(mockApplyToolCallStepUp).toHaveBeenCalledTimes(1);
    expect(mockApplyToolCallStepUp).toHaveBeenCalledWith(server, {
      requiredScope: "read write admin",
      resourceMetadataUrl: "https://rs.example/.well-known",
    });
    expect(mockResetToolCallStepUp).not.toHaveBeenCalled();
  });

  it("resets the step-up counter after a successful call", async () => {
    mockExecuteToolApi.mockResolvedValueOnce({
      status: "completed",
      result: { content: [{ type: "text", text: "ok" }] },
    });

    const { result } = renderHook(
      () => useToolExecution(makeHookOptions({ selectedTool: "get_weather" })),
      { wrapper: withServer(server) },
    );

    await act(async () => {
      await result.current.executeTool({ parameters: {} });
    });

    expect(mockResetToolCallStepUp).toHaveBeenCalledWith(server);
    expect(mockApplyToolCallStepUp).not.toHaveBeenCalled();
  });

  it("does not drive step-up for an ordinary error (no challenge)", async () => {
    mockExecuteToolApi.mockResolvedValueOnce({ error: "Boom" });

    const { result } = renderHook(
      () => useToolExecution(makeHookOptions({ selectedTool: "get_weather" })),
      { wrapper: withServer(server) },
    );

    await act(async () => {
      await result.current.executeTool({ parameters: {} });
    });

    expect(mockApplyToolCallStepUp).not.toHaveBeenCalled();
  });

  it("drives step-up for a resourceMetadataUrl-only challenge (discovery now consumes the PRM pointer — SEP-2350 follow-up to #3427)", async () => {
    // Same `isActionableStepUpChallenge` gate resources/prompts/chat use: a
    // `resourceMetadataUrl` is now actionable on its own — the OAuth flow
    // discovers the server's authoritative scopes/AS from it.
    mockExecuteToolApi.mockResolvedValueOnce({
      error: "Insufficient scope",
      insufficientScope: {
        resourceMetadataUrl: "https://rs.example/.well-known",
      },
    });

    const { result } = renderHook(
      () => useToolExecution(makeHookOptions({ selectedTool: "get_weather" })),
      { wrapper: withServer(server) },
    );

    await act(async () => {
      await result.current.executeTool({ parameters: {} });
    });

    expect(mockApplyToolCallStepUp).toHaveBeenCalledTimes(1);
    expect(mockApplyToolCallStepUp).toHaveBeenCalledWith(server, {
      requiredScope: undefined,
      resourceMetadataUrl: "https://rs.example/.well-known",
    });
  });

  it("does not drive step-up for an errorDescription-only challenge (nothing to re-authorize with)", async () => {
    // Neither a `requiredScope` nor a `resourceMetadataUrl` — redirecting would
    // only burn the bounded step-up budget.
    mockExecuteToolApi.mockResolvedValueOnce({
      error: "Insufficient scope",
      insufficientScope: {
        errorDescription: "more scope needed",
      },
    });

    const { result } = renderHook(
      () => useToolExecution(makeHookOptions({ selectedTool: "get_weather" })),
      { wrapper: withServer(server) },
    );

    await act(async () => {
      await result.current.executeTool({ parameters: {} });
    });

    expect(mockApplyToolCallStepUp).not.toHaveBeenCalled();
  });
});
