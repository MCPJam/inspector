/**
 * The 2025-11-25 step for a task parked on `input_required`: "When the
 * requestor encounters the `input_required` status, it SHOULD preemptively
 * call `tasks/result`."
 *
 * These pin the call itself (one request, bounded, classified by what came
 * back) and when the task runner makes it.
 */

import { describe, expect, it, vi } from "vitest";
import type { MCPClientManager } from "../../src/mcp-client-manager/index.js";
import {
  INPUT_REQUIRED_RESULT_WAIT_MS,
  callResultWhileInputRequired,
  describeResultCall,
  inputRequiredResultWaitMs,
} from "../../src/tasks-conformance/input-required-result.js";
import { TaskOperations } from "../../src/tasks-conformance/task-operations.js";
import { normalizeMCPTasksConformanceConfig } from "../../src/tasks-conformance/validation.js";

function rpcError(code: number, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("callResultWhileInputRequired", () => {
  it("sends one tasks/result for the task, with the time limit", async () => {
    const request = vi.fn().mockResolvedValue({ content: [] });
    const call = await callResultWhileInputRequired({
      request,
      taskId: "task-1",
      timeoutMs: 1_234,
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      { method: "tasks/result", params: { taskId: "task-1" } },
      { timeout: 1_234 },
    );
    expect(call.outcome).toBe("returned");
  });

  it("reads a JSON-RPC error as the server's answer", async () => {
    const request = vi
      .fn()
      .mockRejectedValue(rpcError(-32603, "the task failed"));
    const call = await callResultWhileInputRequired({
      request,
      taskId: "task-1",
      timeoutMs: 1_000,
    });

    expect(call).toMatchObject({
      outcome: "error",
      code: -32603,
      message: "the task failed",
    });
  });

  it("reads the client's own timeout as no answer", async () => {
    const request = vi
      .fn()
      .mockRejectedValue(rpcError(-32001, "Request timed out"));
    const call = await callResultWhileInputRequired({
      request,
      taskId: "task-1",
      timeoutMs: 1_000,
    });

    expect(call).toMatchObject({
      outcome: "no-answer",
      message: "Request timed out",
    });
  });

  it("reads a failure with no JSON-RPC code as no answer", async () => {
    // A dropped connection or an abort: the server said nothing about the task.
    const request = vi.fn().mockRejectedValue(new Error("socket hang up"));
    const call = await callResultWhileInputRequired({
      request,
      taskId: "task-1",
      timeoutMs: 1_000,
    });

    expect(call).toMatchObject({
      outcome: "no-answer",
      message: "socket hang up",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("inputRequiredResultWaitMs", () => {
  it("is the fixed bound on a normal poll budget", () => {
    expect(inputRequiredResultWaitMs(30_000)).toBe(
      INPUT_REQUIRED_RESULT_WAIT_MS,
    );
  });

  it("never exceeds the run's own poll budget", () => {
    expect(inputRequiredResultWaitMs(300)).toBe(300);
  });

  it("is never negative", () => {
    expect(inputRequiredResultWaitMs(-1)).toBe(0);
  });
});

describe("describeResultCall", () => {
  it("reports each outcome without inventing fields", () => {
    expect(describeResultCall({ outcome: "returned", waitedMs: 12 })).toEqual({
      outcome: "returned",
      waitedMs: 12,
    });
    expect(
      describeResultCall({
        outcome: "error",
        code: -32603,
        message: "failed",
        waitedMs: 20,
      }),
    ).toEqual({
      outcome: "error",
      code: -32603,
      message: "failed",
      waitedMs: 20,
    });
    expect(
      describeResultCall({
        outcome: "no-answer",
        message: "Request timed out",
        waitedMs: 5_000,
      }),
    ).toEqual({
      outcome: "no-answer",
      message: "Request timed out",
      waitedMs: 5_000,
    });
  });
});

describe("TaskOperations.resolveInputRequired", () => {
  const PARKED = {
    task: { taskId: "task-1", status: "input_required", pollInterval: 1 },
    inputRequired: true,
  };

  function setup(options: {
    requestWithSchema: ReturnType<typeof vi.fn>;
    getTask?: ReturnType<typeof vi.fn>;
    pollTimeoutMs?: number;
  }) {
    const getTask = options.getTask ?? vi.fn();
    const manager = {
      getManagedClient: () => ({
        requestWithSchema: options.requestWithSchema,
      }),
      getTask,
    } as unknown as MCPClientManager;
    const operations = new TaskOperations(
      normalizeMCPTasksConformanceConfig({
        url: "https://example.test/mcp",
        pollTimeoutMs: options.pollTimeoutMs ?? 2_000,
      }),
    );
    return { manager, operations, getTask };
  }

  it("does nothing on the extension wire, which has no tasks/result", async () => {
    const requestWithSchema = vi.fn();
    const { manager, operations } = setup({ requestWithSchema });

    const polled = await operations.resolveInputRequired(
      manager,
      "server",
      "extension",
      "task-1",
      PARKED,
    );

    expect(polled).toBe(PARKED);
    expect(requestWithSchema).not.toHaveBeenCalled();
  });

  it("does nothing when the task did not park on input_required", async () => {
    const requestWithSchema = vi.fn();
    const { manager, operations } = setup({ requestWithSchema });
    const finished = { task: { taskId: "task-1", status: "completed" } };

    const polled = await operations.resolveInputRequired(
      manager,
      "server",
      "legacy",
      "task-1",
      finished,
    );

    expect(polled).toBe(finished);
    expect(requestWithSchema).not.toHaveBeenCalled();
  });

  it("calls tasks/result once and keeps the parked task when nothing comes back", async () => {
    const requestWithSchema = vi
      .fn()
      .mockRejectedValue(rpcError(-32001, "Request timed out"));
    const { manager, operations, getTask } = setup({
      requestWithSchema,
      pollTimeoutMs: 750,
    });

    const polled = await operations.resolveInputRequired(
      manager,
      "server",
      "legacy",
      "task-1",
      PARKED,
    );

    expect(requestWithSchema).toHaveBeenCalledTimes(1);
    const [payload, , requestOptions] = requestWithSchema.mock.calls[0]!;
    expect(payload).toEqual({
      method: "tasks/result",
      params: { taskId: "task-1" },
    });
    // Bounded by the run's poll budget when that is the smaller of the two.
    expect(requestOptions).toEqual({ timeout: 750 });
    expect(polled.task).toBe(PARKED.task);
    expect(polled.inputRequired).toBe(true);
    expect(polled.resultCall?.outcome).toBe("no-answer");
    // The task was not read again: nothing says it moved.
    expect(getTask).not.toHaveBeenCalled();
  });

  it("reads the task again when tasks/result returns", async () => {
    const requestWithSchema = vi.fn().mockResolvedValue({ content: [] });
    const getTask = vi
      .fn()
      .mockResolvedValue({ taskId: "task-1", status: "completed" });
    const { manager, operations } = setup({ requestWithSchema, getTask });

    const polled = await operations.resolveInputRequired(
      manager,
      "server",
      "legacy",
      "task-1",
      PARKED,
    );

    expect(polled.resultCall?.outcome).toBe("returned");
    expect(polled.task).toEqual({ taskId: "task-1", status: "completed" });
    expect(polled.inputRequired).toBeUndefined();
  });

  it("reads the task again after a JSON-RPC error, and reports it still parked if it is", async () => {
    // A server that refuses tasks/result while the task is open has not ended
    // the task. The re-read says so, and the run goes on with a parked task.
    const requestWithSchema = vi
      .fn()
      .mockRejectedValue(rpcError(-32602, "task is not finished"));
    const getTask = vi.fn().mockResolvedValue(PARKED.task);
    const { manager, operations } = setup({ requestWithSchema, getTask });

    const polled = await operations.resolveInputRequired(
      manager,
      "server",
      "legacy",
      "task-1",
      PARKED,
    );

    expect(polled.resultCall).toMatchObject({ outcome: "error", code: -32602 });
    expect(polled.task?.status).toBe("input_required");
    expect(polled.inputRequired).toBe(true);
  });

  it("keeps the earlier read when the task cannot be read again", async () => {
    const requestWithSchema = vi.fn().mockResolvedValue({ content: [] });
    const getTask = vi.fn().mockRejectedValue(new Error("connection reset"));
    const { manager, operations } = setup({ requestWithSchema, getTask });

    const polled = await operations.resolveInputRequired(
      manager,
      "server",
      "legacy",
      "task-1",
      PARKED,
    );

    expect(polled.task).toBe(PARKED.task);
    expect(polled.resultCall?.outcome).toBe("returned");
  });
});
