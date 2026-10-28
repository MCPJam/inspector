import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeForwardedOperation,
  type GateOperation,
} from "../execution-gate.js";
import type { ExecutionControl, Settlement } from "../execution-control.js";

beforeEach(() =>
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "forwarding-gate-test-signing-secret"),
);
afterEach(() => vi.unstubAllEnvs());
const operation: GateOperation = {
  invocationKey: "one",
  turnId: "turn",
  rpcId: 1,
  method: "tools/call",
  paramsPresent: true,
  params: { name: "read", arguments: { b: 2, a: 1 } },
  expiresAt: Date.now() + 60_000,
};
const binding = {
  subject: "user",
  projectId: "project",
  chatSessionId: "chat",
};
function fixture(approval = false) {
  const events: string[] = [];
  const control = {
    prepare: vi.fn<ExecutionControl["prepare"]>(async () => {
      events.push("prepare");
      return {
        executionId: "execution",
        state: "prepared" as const,
        replayed: false,
        requireToolApproval: approval,
      };
    }),
    read: vi.fn(async () => ({
      _id: "execution",
      method: "tools/call",
      turnId: "turn",
      params: null,
      authority: {
        userId: "user",
        projectId: "project",
        sessionId: "session",
        serverId: "server",
        accountId: "account",
      },
      state: "settled" as const,
      outcome: "success",
      result: { json: '{"answer":42}', url: null, bytes: 13, truncated: false },
      complete: true,
    })),
    requestApproval: vi.fn(
      async (_id: string, nonceHash: string, expiresAt: number) => {
        events.push("approval-request");
        return { nonceHash, expiresAt, state: "pending" };
      },
    ),
    decideApproval: vi.fn(
      async (_id: string, nonceHash: string, decision: string) => {
        events.push(decision);
        return { nonceHash, expiresAt: operation.expiresAt, state: decision };
      },
    ),
    claim: vi.fn(async () => {
      events.push("claim");
      return { dispatch: true, state: "dispatched" as const };
    }),
    settle: vi.fn(async () => {
      events.push("settle");
      return { replayed: false, adopted: false };
    }),
  } satisfies Pick<
    ExecutionControl,
    | "prepare"
    | "read"
    | "requestApproval"
    | "decideApproval"
    | "claim"
    | "settle"
  >;
  const dispatch = vi.fn(
    async (settle: (result: Settlement) => Promise<void>) => {
      events.push("dispatch");
      await settle({ outcome: "success", resultJson: '{"answer":42}' });
      return "answer";
    },
  );
  return { control, events, dispatch };
}

describe("forwarded execution gate", () => {
  it("records intent and claims before dispatch, and settles the exact raw result", async () => {
    const f = fixture();
    expect(await executeForwardedOperation({ ...f, operation })).toBe("answer");
    expect(f.events).toEqual(["prepare", "claim", "dispatch", "settle"]);
    expect(f.control.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        paramsJson:
          '{"present":true,"value":{"arguments":{"a":1,"b":2},"name":"read"}}',
      }),
    );
    expect(f.control.settle).toHaveBeenCalledWith(
      "execution",
      expect.any(String),
      { outcome: "success", resultJson: '{"answer":42}' },
    );
  });
  it("asks once with the server execution identity and verifies the signed answer", async () => {
    const f = fixture(true);
    const ask = vi.fn(async (request: { approvalId: string }) => ({
      approvalId: request.approvalId,
      decision: "approved" as const,
    }));
    await executeForwardedOperation({
      ...f,
      operation,
      approval: { binding, ask },
    });
    expect(f.events).toEqual([
      "prepare",
      "approval-request",
      "approved",
      "claim",
      "dispatch",
      "settle",
    ]);
    expect(ask).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: "execution", toolName: "read" }),
    );
    expect(f.control.requestApproval.mock.calls[0][1]).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });
  it.each(["denied", "cancelled"] as const)(
    "does not dispatch an approval answered %s",
    async (decision) => {
      const f = fixture(true);
      await expect(
        executeForwardedOperation({
          ...f,
          operation,
          approval: {
            binding,
            ask: async (r) => ({ approvalId: r.approvalId, decision }),
          },
        }),
      ).rejects.toThrow("approval_not_granted");
      expect(f.dispatch).not.toHaveBeenCalled();
      expect(f.control.claim).not.toHaveBeenCalled();
    },
  );
  it("rejects a forged approval and does not offer an unsigned fallback", async () => {
    const f = fixture(true);
    await expect(
      executeForwardedOperation({
        ...f,
        operation,
        approval: {
          binding,
          ask: async () => ({ approvalId: "forged", decision: "approved" }),
        },
      }),
    ).rejects.toThrow("approval_unverified");
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.control.decideApproval).toHaveBeenCalledWith(
      "execution",
      expect.any(String),
      "denied",
    );
  });
  it("fails closed if approval is required but no approval adapter exists", async () => {
    const f = fixture(true);
    await expect(
      executeForwardedOperation({ ...f, operation }),
    ).rejects.toThrow("approval_unavailable");
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.control.settle).toHaveBeenCalledWith("execution", undefined, {
      outcome: "refused",
    });
  });
  it("does not send a policy-denied tool or request a redundant approval", async () => {
    const f = fixture(true);
    await expect(
      executeForwardedOperation({
        ...f,
        operation: {
          ...operation,
          policy: {
            mode: "readOnly",
            denied: { read: { reason: "denyList", classification: "unknown" } },
            known: ["read"],
            unknownTool: "deny",
          },
        },
      }),
    ).rejects.toThrow();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.control.requestApproval).not.toHaveBeenCalled();
  });
  it("cancels before dispatch when the caller stops while approving", async () => {
    const f = fixture(true);
    const abort = new AbortController();
    await expect(
      executeForwardedOperation({
        ...f,
        operation,
        signal: abort.signal,
        approval: {
          binding,
          ask: async (r) => {
            abort.abort();
            return { approvalId: r.approvalId, decision: "approved" };
          },
        },
      }),
    ).rejects.toThrow();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.control.decideApproval).toHaveBeenCalledWith(
      "execution",
      expect.any(String),
      "cancelled",
    );
  });
  it("does not dispatch when evidence preparation or the dispatch acknowledgement is lost", async () => {
    const f = fixture();
    f.control.prepare.mockRejectedValueOnce(new Error("unavailable"));
    await expect(
      executeForwardedOperation({ ...f, operation }),
    ).rejects.toThrow("unavailable");
    f.control.claim.mockRejectedValueOnce(new Error("lost acknowledgement"));
    await expect(
      executeForwardedOperation({ ...f, operation }),
    ).rejects.toThrow("lost acknowledgement");
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("cancels an unanswered approval without waiting for the adapter", async () => {
    const f = fixture(true);
    const abort = new AbortController();
    const ask = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      queueMicrotask(() => abort.abort(new Error("cancelled")));
      return new Promise<never>(() => {
        expect(signal).toBeDefined();
      });
    });
    await expect(
      executeForwardedOperation({
        ...f,
        operation,
        signal: abort.signal,
        approval: { binding, ask },
      }),
    ).rejects.toThrow("cancelled");
    expect(f.control.decideApproval).toHaveBeenCalledWith(
      "execution",
      expect.any(String),
      "cancelled",
    );
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("attempts incomplete evidence when a committed claim acknowledgement is lost", async () => {
    const f = fixture();
    f.control.claim.mockRejectedValueOnce(new Error("lost acknowledgement"));
    await expect(
      executeForwardedOperation({ ...f, operation }),
    ).rejects.toThrow("lost acknowledgement");
    expect(f.control.settle).toHaveBeenCalledWith(
      "execution",
      expect.any(String),
      { outcome: "incomplete" },
    );
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("does not dispatch when neither the claim nor incomplete settlement can be confirmed", async () => {
    const f = fixture();
    f.control.claim.mockRejectedValueOnce(new Error("offline"));
    f.control.settle.mockRejectedValueOnce(new Error("not dispatched"));
    await expect(
      executeForwardedOperation({ ...f, operation }),
    ).rejects.toThrow("Dispatch and evidence could not be confirmed");
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it("uses one snapshot even if the caller mutates parameters during preparation", async () => {
    const f = fixture(true);
    const params = { name: "read", arguments: { value: "original" } };
    f.control.prepare.mockImplementationOnce(async () => {
      params.name = "delete";
      params.arguments.value = "changed";
      return {
        executionId: "execution",
        state: "prepared",
        replayed: false,
        requireToolApproval: true,
      };
    });
    const ask = vi.fn(async (r) => ({
      approvalId: r.approvalId,
      decision: "approved" as const,
    }));
    await executeForwardedOperation({
      ...f,
      operation: { ...operation, params },
      approval: { binding, ask },
    });
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "read",
        input: {
          present: true,
          value: { name: "read", arguments: { value: "original" } },
        },
      }),
    );
    expect(f.dispatch).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        params: { name: "read", arguments: { value: "original" } },
      }),
    );
  });
  it("records an uncertain upstream result without replaying the dispatch", async () => {
    const f = fixture();
    f.dispatch.mockRejectedValue(new Error("socket reset"));
    await expect(
      executeForwardedOperation({ ...f, operation }),
    ).rejects.toThrow("socket reset");
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.control.settle).toHaveBeenCalledWith(
      "execution",
      expect.any(String),
      { outcome: "incomplete" },
    );
  });
  it("a settlement error never retries the side effect or writes a second outcome", async () => {
    const f = fixture();
    f.control.settle.mockRejectedValue(new Error("evidence lost"));
    await expect(
      executeForwardedOperation({ ...f, operation }),
    ).rejects.toThrow("evidence lost");
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.control.settle).toHaveBeenCalledOnce();
  });
  it("retrieves a completed execution only through the replay adapter", async () => {
    const f = fixture();
    f.control.prepare.mockResolvedValue({
      executionId: "execution",
      state: "settled",
      replayed: true,
      requireToolApproval: false,
    });
    const replay = vi.fn(async (r) => r.result?.json ?? "missing");
    expect(await executeForwardedOperation({ ...f, operation, replay })).toBe(
      '{"answer":42}',
    );
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(replay).toHaveBeenCalledOnce();
  });
  it("preserves missing parameters, null, and numeric versus string RPC ids", async () => {
    for (const op of [
      { ...operation, paramsPresent: false, params: undefined },
      { ...operation, params: null },
      { ...operation, rpcId: "1" },
    ]) {
      const f = fixture();
      await executeForwardedOperation({ ...f, operation: op });
      expect(f.control.prepare).toHaveBeenCalledWith(
        expect.objectContaining({
          rpcId: op.rpcId,
          paramsJson: op.paramsPresent
            ? expect.stringContaining('"value":')
            : '{"present":false}',
        }),
      );
    }
  });
});

it("observes an ask that rejects after cancellation during approval registration", async () => {
  const f = fixture(true);
  const abort = new AbortController();
  f.control.requestApproval.mockImplementation(
    async (_id, nonceHash, expiresAt) => {
      abort.abort(new Error("cancelled during registration"));
      return { nonceHash, expiresAt, state: "pending" };
    },
  );
  await expect(
    executeForwardedOperation({
      ...f,
      operation,
      signal: abort.signal,
      approval: {
        binding,
        ask: async ({ signal }) => {
          signal.throwIfAborted();
          throw new Error("unreachable");
        },
      },
    }),
  ).rejects.toThrow("cancelled during registration");
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.control.decideApproval).toHaveBeenCalledWith(
    "execution",
    expect.any(String),
    "cancelled",
  );
});
