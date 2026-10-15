import { jsonSchema } from "ai";
import { describe, expect, it, vi } from "vitest";
import { wrapModelToolsets } from "../model-tool-executor.js";
describe("model execution ownership seam", () => {
  it("leaves the default toolset identical", () => {
    const groups = {
      server: {
        test: { inputSchema: jsonSchema({ type: "object" }), execute: vi.fn() },
      },
    };
    expect(wrapModelToolsets(groups)).toBe(groups);
  });
  it("does not run on listing and preserves approval and rendering", async () => {
    const execute = vi.fn(async () => ({ content: [] }));
    const toModelOutput = vi.fn();
    const owner = vi.fn(async (_execution, run) => run());
    const tools = wrapModelToolsets(
      {
        server: {
          test: {
            inputSchema: jsonSchema({ type: "object" }),
            execute,
            needsApproval: true,
            toModelOutput,
          },
        },
      },
      owner,
    );
    expect(owner).not.toHaveBeenCalled();
    expect(tools.server.test.needsApproval).toBe(true);
    expect(tools.server.test.toModelOutput).toBe(toModelOutput);
    const signal = new AbortController().signal;
    await tools.server.test.execute!(
      { zero: 0 },
      { toolCallId: "call", messages: [], abortSignal: signal, context: {} },
    );
    expect(owner).toHaveBeenCalledWith(
      {
        serverKey: "server",
        toolName: "test",
        toolCallId: "call",
        input: { zero: 0 },
        signal,
      },
      expect.any(Function),
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("a failed ownership fence runs no original effect", async () => {
    const execute = vi.fn();
    const tools = wrapModelToolsets(
      {
        server: {
          test: { inputSchema: jsonSchema({ type: "object" }), execute },
        },
      },
      async () => {
        throw new Error("denied");
      },
    );
    await expect(
      tools.server.test.execute!(
        {},
        { toolCallId: "call", messages: [], context: {} },
      ),
    ).rejects.toThrow("denied");
    expect(execute).not.toHaveBeenCalled();
  });
});
