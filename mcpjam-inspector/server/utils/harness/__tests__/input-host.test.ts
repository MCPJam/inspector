import { describe, expect, it, vi } from "vitest";
import {
  TaskLifecycleEngine,
  driveTaskToTerminal,
  initInputRequiredState,
  runInputRequiredOperation,
  type InputRequests,
  type MrtrMethod,
} from "@mcpjam/sdk";
import {
  createHarnessInputHost,
  type HarnessInputHandler,
} from "../input-host.js";

const form = {
  method: "elicitation/create",
  params: {
    message: "Choose a color",
    requestedSchema: {
      type: "object",
      properties: { color: { type: "string" } },
    },
  },
} satisfies InputRequests[string];
const url = {
  method: "elicitation/create",
  params: {
    mode: "url",
    message: "Connect account",
    url: "https://example.com/consent",
    elicitationId: "consent-1",
  },
} satisfies InputRequests[string];

function host(
  handle: HarnessInputHandler,
  signal = new AbortController().signal,
) {
  return createHarnessInputHost({
    allowedServerIds: new Set(["server"]),
    modes: ["form", "url"],
    handle,
    signal,
  });
}

describe("shared harness input contract", () => {
  it.each(["accept", "decline", "cancel"] as const)(
    "preserves %s for native, modern and task input adapters",
    async (action) => {
      const inputs = host(async () => ({ action }));
      const state = initInputRequiredState({
        method: "tools/call",
        params: {},
      });
      const native = await inputs.answer(
        {
          serverId: "server",
          requestId: "native",
          message: "Choose",
          schema: {},
        },
        new AbortController().signal,
      );
      const modern = await inputs.collectMrtrForServer("server")({
        state,
        inputRequests: { k: form },
      });
      const task = await inputs.taskHandlers.elicitation?.(form.params, {
        serverId: "server",
        taskId: "task",
        inputKey: "k",
      });
      expect(native).toEqual({ action });
      expect(modern).toEqual({ k: { action } });
      expect(task).toEqual({ action });
    },
  );

  it("keeps server ownership and operation identity out of the input payload", async () => {
    const handle = vi.fn<HarnessInputHandler>(async () => ({
      action: "decline",
    }));
    const inputs = host(handle);
    const state = initInputRequiredState({
      method: "tools/call",
      params: {},
      opId: "operation",
    });
    await inputs.collectMrtrForServer("other-server")({
      state,
      inputRequests: { k: form },
    });
    expect(handle).not.toHaveBeenCalled();
    await inputs.collectMrtrForServer("server")({
      state,
      inputRequests: { k: form },
    });
    await inputs.collectMrtrForServer("server")({
      state: { ...state, opId: "another-operation" },
      inputRequests: { k: form },
    });
    expect(handle.mock.calls[0][0].requestId).not.toBe(
      handle.mock.calls[1][0].requestId,
    );
  });

  it.each<MrtrMethod>(["tools/call", "prompts/get", "resources/read"])(
    "%s preserves opaque state and replaces answers between rounds",
    async (method) => {
      const handle = vi.fn<HarnessInputHandler>(async (request) =>
        request.mode === "url"
          ? { action: "accept" }
          : { action: "accept", content: { color: "blue" } },
      );
      const inputs = host(handle);
      const original = { name: "operation", arguments: { value: "unchanged" } };
      const seen: Record<string, unknown>[] = [];
      const result = await runInputRequiredOperation({
        method,
        params: original,
        collectInput: inputs.collectMrtrForServer("server"),
        supportedElicitationModes: ["form", "url"],
        sender: async (request, { round }) => {
          seen.push(request.params);
          if (round === 0)
            return {
              resultType: "input_required",
              requestState: "opaque\u0000state",
              inputRequests: { color: form },
            };
          if (round === 1)
            return {
              resultType: "input_required",
              requestState: "next-state",
              inputRequests: { consent: url },
            };
          return { value: "complete" };
        },
      });
      expect(result).toEqual({ value: "complete" });
      expect(seen).toEqual([
        original,
        {
          ...original,
          requestState: "opaque\u0000state",
          inputResponses: {
            color: { action: "accept", content: { color: "blue" } },
          },
        },
        {
          ...original,
          requestState: "next-state",
          inputResponses: { consent: { action: "accept" } },
        },
      ]);
      expect(original).not.toHaveProperty("requestState");
      expect(handle.mock.calls.map(([request]) => request.serverId)).toEqual([
        "server",
        "server",
      ]);
      expect(handle.mock.calls[0][0].requestId).not.toBe(
        handle.mock.calls[1][0].requestId,
      );
    },
  );

  it("validates the whole round before presenting any request", async () => {
    const handle = vi.fn<HarnessInputHandler>();
    const inputs = host(handle);
    const state = initInputRequiredState({ method: "tools/call", params: {} });
    await expect(
      inputs.collectMrtrForServer("server")({
        state,
        inputRequests: { valid: form, invalid: { method: "roots/list" } },
      }),
    ).rejects.toThrow("undeclared");
    expect(handle).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "url", message: "Missing URL and elicitation id" },
    { message: "Missing form schema" },
  ])(
    "refuses malformed input before opening another form: %j",
    async (params) => {
      const handle = vi.fn<HarnessInputHandler>();
      const inputs = host(handle);
      await expect(
        inputs.collectMrtrForServer("server")({
          state: initInputRequiredState({ method: "tools/call", params: {} }),
          inputRequests: {
            valid: form,
            invalid: { method: "elicitation/create", params },
          },
        }),
      ).rejects.toThrow("Malformed");
      expect(handle).not.toHaveBeenCalled();
    },
  );

  it("withdraws sibling forms when a round cannot collect all answers", async () => {
    const withdrawn = vi.fn();
    const inputs = host(async (request, signal) => {
      if (request.message === "Fail") throw new Error("handler failed");
      return new Promise((resolve) => {
        const cancel = () => {
          withdrawn();
          resolve({ action: "cancel" });
        };
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
      });
    });
    const sender = vi.fn(async () => ({
      resultType: "input_required" as const,
      inputRequests: {
        first: { ...form, params: { ...form.params, message: "Fail" } },
        second: form,
      },
    }));
    await expect(
      runInputRequiredOperation({
        method: "tools/call",
        params: {},
        sender,
        collectInput: inputs.collectMrtrForServer("server"),
      }),
    ).rejects.toThrow("handler failed");
    expect(withdrawn).toHaveBeenCalledOnce();
    expect(sender).toHaveBeenCalledOnce();
  });

  it("never resumes an operation with a late answer after cancellation", async () => {
    const controller = new AbortController();
    const inputs = host(async () => {
      controller.abort();
      return { action: "accept", content: { color: "blue" } };
    }, controller.signal);
    const sender = vi.fn(async () => ({
      resultType: "input_required" as const,
      requestState: "state",
      inputRequests: { color: form },
    }));
    await expect(
      runInputRequiredOperation({
        method: "tools/call",
        params: {},
        sender,
        collectInput: inputs.collectMrtrForServer("server"),
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(sender).toHaveBeenCalledOnce();
  });

  it("refuses an aborted owner even when the request has another signal", async () => {
    const owner = new AbortController();
    const handle = vi.fn<HarnessInputHandler>();
    const inputs = host(handle, owner.signal);
    owner.abort();
    await expect(
      inputs.collectMrtrForServer("server")({
        state: initInputRequiredState({ method: "tools/call", params: {} }),
        inputRequests: { k: form },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    expect(handle).not.toHaveBeenCalled();
  });

  it("uses the same handler for Task input and commits only acknowledged updates", async () => {
    const handle = vi.fn<HarnessInputHandler>(async () => ({
      action: "accept",
      content: { color: "blue" },
    }));
    const inputs = host(handle);
    let now = 0;
    let attempts = 0;
    let committed = false;
    const updateTask = vi.fn(async () => {
      if (++attempts === 1) throw new Error("update was rejected");
      committed = true;
    });
    const result = await driveTaskToTerminal({
      identity: {
        scope: "project",
        serverId: "server",
        taskId: "task",
        wire: "extension",
      },
      getTask: async () =>
        committed
          ? {
              status: "completed",
              result: { content: [{ type: "text", text: "done" }] },
            }
          : { status: "input_required", inputRequests: { color: form } },
      updateTask,
      input: {
        declaredCapabilities: { elicitation: { form: {}, url: {} } },
        handlers: inputs.taskHandlers,
      },
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      engine: new TaskLifecycleEngine({ now: () => now }),
    });
    expect(result.outcome).toBe("completed");
    expect(updateTask).toHaveBeenCalledTimes(2);
    expect(handle).toHaveBeenCalledTimes(2);
    expect(handle.mock.calls[0][0]).toMatchObject({
      serverId: "server",
      relatedTaskId: "task",
    });
  });
});
