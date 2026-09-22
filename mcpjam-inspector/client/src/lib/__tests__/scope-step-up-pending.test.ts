import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelPendingChatScopeStepUp,
  claimCancelledChatScopeStepUp,
  claimPendingChatScopeStepUp,
  markPendingChatScopeStepUpCancelled,
  markPendingChatScopeStepUpReady,
  readPendingChatScopeStepUp,
  savePendingChatScopeStepUp,
} from "../scope-step-up-pending";
import {
  claimPendingDirectScopeStepUpReplay,
  markPendingDirectScopeStepUpReplayReady,
  savePendingDirectScopeStepUpReplay,
} from "../scope-step-up-replay";

const event = {
  version: 1 as const,
  kind: "scope_step_up_required" as const,
  continuationId: "opaque-1",
  serverId: "bench",
  toolCallId: "call-1",
  operation: { method: "tools/call" as const, operation: "bench_write" },
  requiredScope: "bench:write",
  expiresAt: Date.now() + 60_000,
};

describe("scope step-up browser resume markers", () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.history.replaceState({}, "", "/playground?conversation=chat-1");
    vi.useRealTimers();
  });

  it("claims a chat continuation once after OAuth and preserves its route", () => {
    savePendingChatScopeStepUp({
      event,
      serverName: "Auth Bench",
      chatSessionId: "chat-1",
    });
    expect(readPendingChatScopeStepUp()?.returnPath).toBe(
      "/playground?conversation=chat-1"
    );
    expect(claimPendingChatScopeStepUp("chat-1")).toBeUndefined();

    markPendingChatScopeStepUpReady("Auth Bench");
    expect(claimPendingChatScopeStepUp("chat-1")?.event.continuationId).toBe(
      "opaque-1"
    );
    expect(claimPendingChatScopeStepUp("chat-1")).toBeUndefined();
  });

  it("does not let a different server cancel a pending chat continuation", () => {
    savePendingChatScopeStepUp({
      event,
      serverName: "Auth Bench",
      chatSessionId: "chat-1",
    });
    cancelPendingChatScopeStepUp("Other");
    expect(readPendingChatScopeStepUp()).toBeDefined();
    cancelPendingChatScopeStepUp("Auth Bench");
    expect(readPendingChatScopeStepUp()).toBeUndefined();
  });

  it("claims an OAuth-denied continuation once for error resolution", () => {
    savePendingChatScopeStepUp({
      event,
      serverName: "Auth Bench",
      chatSessionId: "chat-1",
    });
    markPendingChatScopeStepUpCancelled("Auth Bench", "access_denied");
    expect(claimCancelledChatScopeStepUp("chat-1")).toMatchObject({
      phase: "cancelled",
      cancellationMessage: "access_denied",
    });
    expect(claimCancelledChatScopeStepUp("chat-1")).toBeUndefined();
  });

  it("claims a direct replay only on its original surface and server", () => {
    savePendingDirectScopeStepUpReplay({
      operation: {
        resourceUrl: "https://bench.example/mcp",
        method: "tools/call",
        operation: "bench_write",
      },
      descriptor: {
        kind: "tool",
        surface: "tools",
        serverName: "Auth Bench",
        toolName: "bench_write",
        parameters: { value: 7 },
      },
    });
    markPendingDirectScopeStepUpReplayReady("Auth Bench");
    expect(
      claimPendingDirectScopeStepUpReplay({
        serverName: "Auth Bench",
        surface: "playground",
      })
    ).toBeUndefined();
    expect(
      claimPendingDirectScopeStepUpReplay({
        serverName: "Auth Bench",
        surface: "tools",
      })?.descriptor
    ).toMatchObject({ kind: "tool", toolName: "bench_write" });
    expect(
      claimPendingDirectScopeStepUpReplay({
        serverName: "Auth Bench",
        surface: "tools",
      })
    ).toBeUndefined();
  });
});
