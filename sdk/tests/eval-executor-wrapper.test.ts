import { describe, expect, it, vi } from "vitest";
import type { HostExecutor } from "../src/HostExecutor.js";
import { wrapAgentWithAbortSignal } from "../src/eval-executor-wrapper.js";

describe("eval executor wrapper", () => {
  it("forwards introspection and keeps abort propagation through withOptions", async () => {
    const run = vi.fn<HostExecutor["run"]>(async () => {
      throw new Error("provider stopped");
    });
    const resetPromptHistory = vi.fn();
    const executor: HostExecutor = {
      run,
      withOptions: vi.fn(() => executor),
      getPromptHistory: () => [],
      resetPromptHistory,
    };
    const parent = new AbortController();
    const child = new AbortController();
    const wrapped = wrapAgentWithAbortSignal(executor, parent.signal);
    expect(wrapped.getPromptHistory()).toEqual([]);
    wrapped.resetPromptHistory();
    expect(resetPromptHistory).toHaveBeenCalledOnce();
    await expect(
      wrapped.withOptions({}).run("hello", { abortSignal: child.signal })
    ).rejects.toThrow("provider stopped");
    const options = run.mock.calls[0]?.[1];
    parent.abort("cancelled");
    expect(options?.abortSignal?.aborted).toBe(true);
    expect(options?.abortSignal?.reason).toBe("cancelled");
  });
});
