import { beforeEach, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useToolAuthChallengeReplay } from "../useToolAuthChallengeReplay";
import { useUIPlaygroundStore } from "@/stores/ui-playground-store";
import { createServer } from "@/test/factories";
import type { UseToolExecutionReturn } from "../useToolExecution";

const pending = vi.hoisted(() => ({
  descriptor: { kind: "tool" as const, surface: "playground", serverName: "bench", toolName: "write", parameters: { value: "saved" } },
}));
const claim = vi.hoisted(() => vi.fn());
vi.mock("@/lib/scope-step-up-replay", () => ({
  peekPendingDirectScopeStepUpReplay: () => pending,
  claimPendingDirectScopeStepUpReplay: claim,
  clearPendingDirectScopeStepUpReplay: vi.fn(),
}));
beforeEach(() => {
  useUIPlaygroundStore.getState().reset();
  claim.mockReset().mockReturnValueOnce(pending);
});
it.each([false, true])("restores the call before executing after delayed tool loading (error=%s)", async (failed) => {
  const execute = vi.fn<UseToolExecutionReturn["executeTool"]>(async () => {
    const state = useUIPlaygroundStore.getState();
    expect(state.selectedTool).toBe("write");
    expect(state.formFields[0].value).toBe("saved");
    if (failed) state.setExecutionError("Server refused the retry");
    else state.setToolOutput({ value: "saved" });
    return { ok: true, toolName: "write", parameters: { value: "saved" }, result: { value: "saved" }, response: { status: "completed", result: { value: "saved" } } };
  });
  const shared = { servers: { bench: createServer({ name: "bench", connectionStatus: "connected" }) } };
  renderHook(() =>
    useToolAuthChallengeReplay(["bench"], "bench", shared, execute),
  );
  expect(execute).not.toHaveBeenCalled();
  const tools = { write: { name: "write", inputSchema: { type: "object" as const, properties: { value: { type: "string" } } } } };
  act(() => useUIPlaygroundStore.getState().setTools(tools));
  await waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  act(() => useUIPlaygroundStore.getState().setTools({ ...tools }));
  expect(execute).toHaveBeenCalledTimes(1);
  const state = useUIPlaygroundStore.getState();
  expect(state.selectedTool).toBe("write");
  expect(failed ? state.executionError : state.toolOutput).toEqual(failed ? "Server refused the retry" : { value: "saved" });
});

it("restores a call saved on an active server that is not the selected one", async () => {
  const execute = vi.fn<UseToolExecutionReturn["executeTool"]>(async () => ({
    ok: true,
    toolName: "write",
    parameters: { value: "saved" },
    result: {},
    response: { status: "completed", result: {} },
  }));
  const shared = {
    servers: {
      bench: createServer({ name: "bench", connectionStatus: "connected" }),
      other: createServer({ name: "other", connectionStatus: "connected" }),
    },
  };
  renderHook(() =>
    useToolAuthChallengeReplay(["other", "bench"], "other", shared, execute),
  );

  await waitFor(() =>
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: "bench",
        toolName: "write",
        parameters: { value: "saved" },
        scopeStepUpReplay: true,
      }),
    ),
  );
  expect(claim).toHaveBeenCalledWith({
    serverName: "bench",
    surface: "playground",
  });
  const state = useUIPlaygroundStore.getState();
  // The selected server's own tool selection is left alone.
  expect(state.selectedTool).toBeNull();
  expect(state.recoveredToolCall).toEqual({
    serverName: "bench",
    toolName: "write",
    parameters: { value: "saved" },
  });
});

it("leaves a call saved on a server the rail does not show", () => {
  const execute = vi.fn<UseToolExecutionReturn["executeTool"]>();
  const shared = {
    servers: {
      bench: createServer({ name: "bench", connectionStatus: "connected" }),
    },
  };
  renderHook(() =>
    useToolAuthChallengeReplay(["other"], "other", shared, execute),
  );
  expect(claim).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

it("retains edited fields when the current tool is selected again", () => {
  const state = useUIPlaygroundStore.getState();
  state.setSelectedTool("write");
  state.setFormFields([
    {
      name: "value",
      type: "string",
      value: "edited",
      required: true,
      isSet: true,
    },
  ]);
  const fields = useUIPlaygroundStore.getState().formFields;
  state.setSelectedTool("write");
  expect(useUIPlaygroundStore.getState().formFields).toBe(fields);
  state.setSelectedTool("other");
  expect(useUIPlaygroundStore.getState().formFields).toEqual([]);
});
