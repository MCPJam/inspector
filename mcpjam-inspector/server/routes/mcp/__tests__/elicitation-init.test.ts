import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ElicitResult } from "@modelcontextprotocol/client";
import type { MCPClientManager } from "@mcpjam/sdk";
import { initElicitationCallback } from "../elicitation.js";

type PendingElicitation = {
  resolve: (value: ElicitResult) => void;
  reject: (error: unknown) => void;
};

function createManagerStub() {
  let callback:
    | ((params: {
        requestId: string;
        message: string;
        schema: unknown;
        relatedTaskId?: string;
      }) => Promise<ElicitResult>)
    | undefined;
  const pendingElicitations = new Map<string, PendingElicitation>();

  const manager = {
    setElicitationCallback: vi.fn((cb: typeof callback) => {
      callback = cb;
    }),
    getPendingElicitations: vi.fn(() => pendingElicitations),
  };

  return {
    manager: manager as unknown as MCPClientManager,
    mocks: manager,
    getCallback: () => callback,
    pendingElicitations,
  };
}

describe("initElicitationCallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the global elicitation callback on the manager", () => {
    const { manager, mocks } = createManagerStub();

    initElicitationCallback(manager);

    expect(mocks.setElicitationCallback).toHaveBeenCalledTimes(1);
    expect(mocks.setElicitationCallback.mock.calls[0][0]).toBeTypeOf(
      "function",
    );
  });

  it("is idempotent per manager instance", () => {
    const { manager, mocks } = createManagerStub();

    initElicitationCallback(manager);
    initElicitationCallback(manager);
    initElicitationCallback(manager);

    expect(mocks.setElicitationCallback).toHaveBeenCalledTimes(1);
  });

  it("registers separately for distinct manager instances", () => {
    const first = createManagerStub();
    const second = createManagerStub();

    initElicitationCallback(first.manager);
    initElicitationCallback(second.manager);

    expect(first.mocks.setElicitationCallback).toHaveBeenCalledTimes(1);
    expect(second.mocks.setElicitationCallback).toHaveBeenCalledTimes(1);
  });

  it("stores a pending resolver and resolves when answered", async () => {
    const { manager, getCallback, pendingElicitations } = createManagerStub();

    initElicitationCallback(manager);
    const callback = getCallback();
    expect(callback).toBeDefined();

    const resultPromise = callback!({
      requestId: "req-1",
      message: "Pick a value",
      schema: { type: "object" },
    });

    expect(pendingElicitations.has("req-1")).toBe(true);

    const accepted: ElicitResult = {
      action: "accept",
      content: { value: "ok" },
    };
    pendingElicitations.get("req-1")!.resolve(accepted);

    await expect(resultPromise).resolves.toEqual(accepted);
  });
});
