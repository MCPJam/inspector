import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createElement } from "react";

import { useToolExecution } from "../useToolExecution";
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
  applyToolCallStepUp: (...args: unknown[]) => mockApplyToolCallStepUp(...args),
  resetToolCallStepUp: (...args: unknown[]) => mockResetToolCallStepUp(...args),
}));

// --- Helpers ----------------------------------------------------------------

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

describe("useToolExecution server routing", () => {
  it("server tool calls executeToolApi", async () => {
    mockExecuteToolApi.mockResolvedValueOnce({
      status: "completed",
      result: { content: [{ type: "text", text: "ok" }] },
    });

    const { result } = renderHook(() =>
      useToolExecution(makeHookOptions({ selectedTool: "get_weather" })),
    );

    let outcome:
      Awaited<ReturnType<typeof result.current.executeTool>> | undefined;
    await act(async () => {
      outcome = await result.current.executeTool({
        parameters: { city: "NYC" },
      });
    });

    expect(mockExecuteToolApi).toHaveBeenCalledWith("srv-1", "get_weather", {
      city: "NYC",
    });
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
      }),
    );

    await act(async () => {
      await result.current.executeTool({ parameters: {} });
    });

    expect(mockReadResource).toHaveBeenCalledWith(
      "srv-1",
      "example://linked-image.png",
    );
    expect(result.current.pendingExecution?.result).toBe(rawResult);
    expect(result.current.pendingExecution?.modelOutput).toEqual({
      type: "content",
      value: [
        {
          type: "file",
          mediaType: "image/png",
          data: { type: "data", data: "aGVsbG8=" },
        },
      ],
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
      }),
    );

    let outcome:
      Awaited<ReturnType<typeof result.current.executeTool>> | undefined;
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
      }),
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
    expect(mockApplyToolCallStepUp).toHaveBeenCalledWith(
      server,
      {
        requiredScope: "read write admin",
        resourceMetadataUrl: "https://rs.example/.well-known",
      },
      expect.objectContaining({
        operation: {
          method: "tools/call",
          operation: "get_weather",
        },
      }),
    );
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

    expect(mockResetToolCallStepUp).toHaveBeenCalledWith(server, {
      method: "tools/call",
      operation: "get_weather",
    });
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
    expect(mockApplyToolCallStepUp).toHaveBeenCalledWith(
      server,
      {
        requiredScope: undefined,
        resourceMetadataUrl: "https://rs.example/.well-known",
      },
      expect.objectContaining({
        operation: {
          method: "tools/call",
          operation: "get_weather",
        },
      }),
    );
  });

  it("drives step-up for an errorDescription-only challenge (discovery chooses the scopes)", async () => {
    // Neither a `requiredScope` nor a `resourceMetadataUrl`: the
    // re-authorization falls back to the previous scopes and discovery's
    // `scopes_supported`, still bounded by the one-attempt budget.
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

    expect(mockApplyToolCallStepUp).toHaveBeenCalledTimes(1);
  });
});
