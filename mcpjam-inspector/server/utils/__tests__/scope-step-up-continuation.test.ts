import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLocalScopeStepUpContinuationsForTests,
  cancelLocalScopeStepUpContinuation,
  cancelLocalScopeStepUpContinuationForRequest,
  claimLocalScopeStepUpContinuation,
  completeLocalScopeStepUpContinuation,
  createLocalScopeStepUpContinuation,
  markLocalScopeStepUpWireStarted,
  scopeStepUpInputHash,
} from "../scope-step-up-continuation.js";
import { SCOPE_STEP_UP_LIVE_TTL_MS } from "@/shared/scope-step-up";

const challenge = {
  serverId: "bench",
  toolCallId: "call-1",
  requiredScope: "bench:write",
};

function create() {
  return createLocalScopeStepUpContinuation({
    bindingKey: "actor/project/conversation",
    serverId: "bench",
    resourceUrl: "https://bench.example/mcp",
    toolCallId: "call-1",
    toolName: "bench_write",
    toolInput: { value: 7 },
    challenge,
    serverName: "Auth Bench",
  });
}

describe("local scope step-up continuation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T00:00:00Z"));
    __resetLocalScopeStepUpContinuationsForTests();
  });

  afterEach(() => {
    __resetLocalScopeStepUpContinuationsForTests();
    vi.useRealTimers();
  });

  it("binds and restores the exact operation without exposing its input", () => {
    const event = create();
    expect(event).toMatchObject({
      serverId: "bench",
      serverName: "Auth Bench",
      toolCallId: "call-1",
      operation: { method: "tools/call", operation: "bench_write" },
      requiredScope: "bench:write",
    });
    expect(event).not.toHaveProperty("toolInput");

    const claimed = claimLocalScopeStepUpContinuation({
      continuationId: event.continuationId,
      toolCallId: "call-1",
      bindingKey: "actor/project/conversation",
    });
    expect(claimed.input).toEqual({ value: 7 });
    expect(claimed.inputHash).toBe(scopeStepUpInputHash({ value: 7 }));
  });

  it("allows only one claim and scrubs after completion", () => {
    const event = create();
    claimLocalScopeStepUpContinuation({
      continuationId: event.continuationId,
      toolCallId: "call-1",
      bindingKey: "actor/project/conversation",
    });
    expect(() =>
      claimLocalScopeStepUpContinuation({
        continuationId: event.continuationId,
        toolCallId: "call-1",
        bindingKey: "actor/project/conversation",
      })
    ).toThrow("scope_step_up_retry_in_progress");

    completeLocalScopeStepUpContinuation(event.continuationId);
    expect(() =>
      claimLocalScopeStepUpContinuation({
        continuationId: event.continuationId,
        toolCallId: "call-1",
        bindingKey: "actor/project/conversation",
      })
    ).toThrow("scope_step_up_continuation_completed");
  });

  it("turns cancellation after the wire fence into indeterminate", () => {
    const event = create();
    claimLocalScopeStepUpContinuation({
      continuationId: event.continuationId,
      toolCallId: "call-1",
      bindingKey: "actor/project/conversation",
    });
    markLocalScopeStepUpWireStarted(event.continuationId);
    cancelLocalScopeStepUpContinuation(event.continuationId, "connection lost");
    expect(() =>
      claimLocalScopeStepUpContinuation({
        continuationId: event.continuationId,
        toolCallId: "call-1",
        bindingKey: "actor/project/conversation",
      })
    ).toThrow("scope_step_up_continuation_indeterminate");
  });

  it("cancels a pending request without crossing its conversation binding", () => {
    const event = create();
    expect(() =>
      cancelLocalScopeStepUpContinuationForRequest({
        continuationId: event.continuationId,
        toolCallId: "call-1",
        bindingKey: "other-conversation",
        reason: "authorization denied",
      })
    ).toThrow("scope_step_up_continuation_not_found");
    expect(
      cancelLocalScopeStepUpContinuationForRequest({
        continuationId: event.continuationId,
        toolCallId: "call-1",
        bindingKey: "actor/project/conversation",
        reason: "authorization denied",
      })
    ).toEqual({ serverId: "bench", toolName: "bench_write" });
    expect(() =>
      claimLocalScopeStepUpContinuation({
        continuationId: event.continuationId,
        toolCallId: "call-1",
        bindingKey: "actor/project/conversation",
      })
    ).toThrow("scope_step_up_continuation_cancelled");
  });

  it("expires a pending continuation after ten minutes", () => {
    const event = create();
    vi.advanceTimersByTime(SCOPE_STEP_UP_LIVE_TTL_MS + 1);
    expect(() =>
      claimLocalScopeStepUpContinuation({
        continuationId: event.continuationId,
        toolCallId: "call-1",
        bindingKey: "actor/project/conversation",
      })
    ).toThrow("scope_step_up_continuation_expired");
  });
});
