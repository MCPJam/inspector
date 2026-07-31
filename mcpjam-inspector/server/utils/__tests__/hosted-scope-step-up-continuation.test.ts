import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  create: vi.fn(),
  claim: vi.fn(),
  markWire: vi.fn(),
  finalize: vi.fn(),
  cancel: vi.fn(),
  scrub: vi.fn(),
}));

vi.mock("../mrtr-continuation-state.js", () => ({
  createContinuation: store.create,
  claimContinuation: store.claim,
  markContinuationWireStarted: store.markWire,
  finalizeContinuation: store.finalize,
  cancelContinuation: store.cancel,
  scrubContinuation: store.scrub,
}));

import {
  buildHostedScopeStepUpCancellation,
  buildHostedScopeStepUpResume,
  createHostedScopeStepUpContinuation,
} from "../hosted-scope-step-up-continuation.js";

function manager() {
  return {
    getInitializationInfo: () => ({
      protocolVersion: "2026-07-28",
      serverCapabilities: { tools: {} },
      serverVersion: { name: "bench", version: "1" },
    }),
    getServerConfig: () => ({ url: "https://bench.example/mcp" }),
  } as any;
}

describe("hosted scope step-up continuation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.create.mockResolvedValue({
      ok: true,
      continuationId: "continuation-1",
      status: "awaiting_input",
      round: 0,
      stateVersion: 0,
      expiresAt: Date.now() + 600_000,
      createdAt: Date.now(),
      idempotent: false,
    });
    store.markWire.mockResolvedValue({ ok: true, attempt: 1 });
    store.finalize.mockResolvedValue({
      ok: true,
      stateVersion: 1,
      status: "completed",
    });
    store.cancel.mockResolvedValue({ ok: true, status: "indeterminate" });
    store.scrub.mockResolvedValue({ ok: true });
  });

  it("stores exact arguments server-side and emits only an opaque event", async () => {
    const event = await createHostedScopeStepUpContinuation({
      bearer: "bearer",
      authPrincipal: "user-1",
      projectId: "project-1",
      chatSessionId: "chat-1",
      manager: manager(),
      serverName: "Auth Bench",
      info: {
        serverId: "server-1",
        toolCallId: "call-1",
        requiredScope: "bench:write",
      },
      toolName: "bench_write",
      toolInput: { value: 7 },
    });

    expect(event).toMatchObject({
      continuationId: expect.any(String),
      serverId: "server-1",
      serverName: "Auth Bench",
      toolCallId: "call-1",
      operation: { method: "tools/call", operation: "bench_write" },
    });
    expect(event).not.toHaveProperty("toolInput");
    expect(store.create).toHaveBeenCalledWith(
      "bearer",
      expect.objectContaining({
        projectId: "project-1",
        chatSessionId: "chat-1",
        serverId: "server-1",
        operationId: "call-1",
        operationMethod: "tools/call",
        resumeState: expect.stringContaining('"toolName":"bench_write"'),
      }),
      undefined
    );
  });

  it("claims once, fences the wire, executes the saved call, and completes", async () => {
    await createHostedScopeStepUpContinuation({
      bearer: "bearer",
      authPrincipal: "user-1",
      projectId: "project-1",
      chatSessionId: "chat-1",
      manager: manager(),
      info: {
        serverId: "server-1",
        toolCallId: "call-1",
        requiredScope: "bench:write",
      },
      toolName: "bench_write",
      toolInput: { value: 7 },
    });
    const createBody = store.create.mock.calls[0][1];
    store.claim.mockResolvedValue({
      ok: true,
      status: "resuming",
      stateVersion: 0,
      state: {
        continuationId: "continuation-1",
        serverId: "server-1",
        operationId: "call-1",
        operationMethod: "tools/call",
        sideEffecting: true,
        negotiatedEra: "2026-07-28",
        projectId: "project-1",
        chatSessionId: "chat-1",
        resumeState: createBody.resumeState,
        round: 0,
        maxRounds: 1,
        attempt: 0,
      },
    });
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const resume = buildHostedScopeStepUpResume({
      request: {
        continuationId: "continuation-1",
        toolCallId: "call-1",
      },
      bearer: "bearer",
      authPrincipal: "user-1",
      projectId: "project-1",
      chatSessionId: "chat-1",
      manager: manager(),
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "bench_write",
              input: { value: 7 },
            },
          ],
        } as any,
      ],
      tools: {
        bench_write: { _serverId: "server-1", execute },
      } as any,
    });

    const result = await resume.resolve(() => {});
    expect(result.kind).toBe("complete");
    expect(store.claim).toHaveBeenCalledTimes(1);
    expect(store.markWire).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      { value: 7 },
      expect.objectContaining({ toolCallId: "call-1" })
    );
    expect(store.finalize).toHaveBeenCalledWith(
      "bearer",
      expect.objectContaining({ status: "completed" }),
      undefined
    );
    expect(store.scrub).toHaveBeenCalledTimes(1);
  });

  it("resolves OAuth denial as a tool error without starting the tool", async () => {
    store.cancel.mockResolvedValue({ ok: true, status: "cancelled" });
    const cancellation = buildHostedScopeStepUpCancellation({
      request: {
        continuationId: "continuation-1",
        toolCallId: "call-1",
      },
      bearer: "bearer",
      tools: {
        bench_write: { _serverId: "server-1", execute: vi.fn() },
      } as any,
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "bench_write",
              input: { value: 7 },
            },
          ],
        } as any,
      ],
    });

    const result = await cancellation.resolve(() => {});
    expect(result).toMatchObject({
      kind: "recover",
      toolResultMessage: {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bench_write",
          },
        ],
      },
    });
    expect(store.cancel).toHaveBeenCalledWith("bearer", {
      continuationId: "continuation-1",
      reason: "authorization was not completed",
    });
    expect(store.markWire).not.toHaveBeenCalled();
    expect(store.scrub).toHaveBeenCalledTimes(1);
  });
});
