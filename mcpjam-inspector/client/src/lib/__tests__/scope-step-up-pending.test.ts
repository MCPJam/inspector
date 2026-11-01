import { beforeEach, describe, expect, it, vi } from "vitest";
import { SCOPE_STEP_UP_LIVE_TTL_MS } from "@/shared/scope-step-up";
import {
  cancelPendingChatScopeStepUp,
  claimCancelledChatScopeStepUp,
  claimPendingChatScopeStepUp,
  listPendingChatScopeStepUps,
  markPendingChatScopeStepUpCancelled,
  markPendingChatScopeStepUpReady,
  readPendingChatScopeStepUp,
  savePendingChatScopeStepUp,
} from "../scope-step-up-pending";
import {
  claimPendingDirectScopeStepUpReplay,
  setPendingDirectScopeStepUpReplayFlowDigest,
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

  it("settles the newest call for a server when an earlier sign-in was abandoned", () => {
    savePendingChatScopeStepUp({
      event,
      serverName: "Auth Bench",
      chatSessionId: "chat-1",
    });
    savePendingChatScopeStepUp({
      event: { ...event, continuationId: "opaque-2", toolCallId: "call-2" },
      serverName: "Auth Bench",
      chatSessionId: "chat-1",
    });
    expect(readPendingChatScopeStepUp()?.event.continuationId).toBe("opaque-2");

    expect(markPendingChatScopeStepUpReady("Auth Bench")).toBe(true);
    expect(claimPendingChatScopeStepUp("chat-1")?.event.continuationId).toBe(
      "opaque-2"
    );
    expect(
      readPendingChatScopeStepUp({ continuationId: "opaque-1" })?.phase
    ).toBe("awaiting_oauth");
    // The callback for the next sign-in finds the call still waiting on it.
    expect(markPendingChatScopeStepUpCancelled("Auth Bench", "denied")).toBe(
      true
    );
    expect(
      readPendingChatScopeStepUp({ continuationId: "opaque-1" })?.phase
    ).toBe("cancelled");
  });

  it("drops long-expired calls and caps the store when it writes", () => {
    savePendingChatScopeStepUp({
      event: {
        ...event,
        continuationId: "expired",
        expiresAt: Date.now() - 2 * SCOPE_STEP_UP_LIVE_TTL_MS,
      },
      serverName: "Auth Bench",
      chatSessionId: "chat-1",
    });
    for (let index = 0; index < 25; index += 1) {
      savePendingChatScopeStepUp({
        event: { ...event, continuationId: `live-${index}` },
        serverName: "Auth Bench",
        chatSessionId: "chat-1",
      });
    }
    const ids = listPendingChatScopeStepUps().map(
      (pending) => pending.event.continuationId
    );
    expect(ids).toHaveLength(20);
    expect(ids).not.toContain("expired");
    expect(ids[ids.length - 1]).toBe("live-24");
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

  it("never dispatches cancellation again after a reload or stale transition", () => {
    savePendingChatScopeStepUp({ event, serverName: "Auth Bench", chatSessionId: "chat-1" });
    markPendingChatScopeStepUpCancelled("Auth Bench", "failed");
    expect(claimCancelledChatScopeStepUp("chat-1")).toBeDefined();
    expect(readPendingChatScopeStepUp()?.phase).toBe("cancelling");
    markPendingChatScopeStepUpCancelled("Auth Bench", "interrupted");
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
    setPendingDirectScopeStepUpReplayFlowDigest("Auth Bench", "flow");
    markPendingDirectScopeStepUpReplayReady("Auth Bench", "flow");
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
