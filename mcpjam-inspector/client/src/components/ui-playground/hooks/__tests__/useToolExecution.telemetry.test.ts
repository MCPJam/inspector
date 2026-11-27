import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createElement } from "react";

import { useToolExecution } from "../useToolExecution";
import { AppStateProvider } from "@/state/app-state-context";
import type { AppState, ServerWithName } from "@/state/app-types";

const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ track }));
vi.mock("@/lib/error-reporting", () => ({ reportCaught: vi.fn() }));

const mockExecuteToolApi = vi.fn();
vi.mock("@/lib/apis/mcp-tools-api", () => ({
  executeToolApi: (...args: unknown[]) => mockExecuteToolApi(...args),
}));

vi.mock("@/lib/scope-step-up-replay", () => ({
  savePendingDirectScopeStepUpReplay: () => {
    throw new Error("A replay is already pending for another call.");
  },
}));

vi.mock("@/state/oauth-orchestrator", () => ({
  applyToolCallStepUp: vi.fn().mockResolvedValue({ action: "throw" }),
  resetToolCallStepUp: vi.fn(),
}));

const server = {
  name: "srv-1",
  connectionStatus: "connected",
  config: { url: "https://rs.example/mcp" },
} as unknown as ServerWithName;

function wrapper({ children }: { children: React.ReactNode }) {
  const appState = {
    servers: { [server.name]: server },
  } as unknown as AppState;
  return createElement(AppStateProvider, { appState }, children);
}

function completedEvents() {
  return track.mock.calls.filter(([name]) => name === "tool_call_completed");
}

beforeEach(() => {
  track.mockClear();
  mockExecuteToolApi.mockReset();
  localStorage.clear();
});

describe("useToolExecution tool_call_completed", () => {
  it("reports one event when the step-up handler throws after a failed call", async () => {
    mockExecuteToolApi.mockResolvedValueOnce({
      error: "Insufficient scope",
      insufficientScope: { requiredScope: "read write" },
    });

    const { result } = renderHook(
      () =>
        useToolExecution({
          serverName: "srv-1",
          selectedTool: "get_weather",
          toolsMetadata: {},
          formFields: [],
          setIsExecuting: vi.fn(),
          setExecutionError: vi.fn(),
          setToolOutput: vi.fn(),
          setToolResponseMetadata: vi.fn(),
        }),
      { wrapper },
    );

    let outcome:
      Awaited<ReturnType<typeof result.current.executeTool>> | undefined;
    await act(async () => {
      outcome = await result.current.executeTool({ parameters: {} });
    });

    expect(outcome?.ok).toBe(false);
    expect(completedEvents()).toHaveLength(1);
    expect(completedEvents()[0][1]).toMatchObject({ is_error: true });
  });
});
