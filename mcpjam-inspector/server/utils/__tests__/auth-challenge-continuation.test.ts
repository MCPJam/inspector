import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCOPE_STEP_UP_LIVE_TTL_MS } from "@/shared/scope-step-up";
import {
  __peekLocalScopeStepUpContinuationForTests,
  __resetLocalScopeStepUpContinuationsForTests,
  AUTH_CHALLENGE_REPEATED_REASON,
  AUTH_CHALLENGE_TOMBSTONE_TTL_MS,
  cancelLocalScopeStepUpContinuationForRequest,
  claimLocalScopeStepUpContinuation,
  completeLocalScopeStepUpContinuation,
  createLocalAuthChallengeContinuation,
  createLocalScopeStepUpContinuation,
  failLocalScopeStepUpContinuation,
  hasRecentLocalAuthSignIn,
  LOCAL_CONTINUATION_SWEEP_INTERVAL_MS,
  settleLocalAuthChallengeHistoryCall,
} from "../scope-step-up-continuation.js";

const BINDING = "actor/project/conversation";

function createSignIn(toolCallId = "call-1") {
  return createLocalAuthChallengeContinuation({
    bindingKey: BINDING,
    serverId: "orders",
    serverName: "Orders",
    toolCallId,
    toolName: "get_my_orders",
    toolInput: { since: "2026-01-01" },
    challenge: { serverId: "orders", toolCallId, requiredScope: "orders:read" },
  });
}

function createStepUp(toolCallId = "call-2") {
  return createLocalScopeStepUpContinuation({
    bindingKey: BINDING,
    serverId: "orders",
    toolCallId,
    toolName: "cancel_order",
    toolInput: { id: 1 },
    challenge: {
      serverId: "orders",
      toolCallId,
      requiredScope: "orders:write",
    },
  });
}

describe("local sign-in continuations", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
    __resetLocalScopeStepUpContinuationsForTests();
  });

  afterEach(() => {
    __resetLocalScopeStepUpContinuationsForTests();
    vi.useRealTimers();
  });

  it("saves the call with its reason and replays it once", () => {
    const { continuationId, expiresAt } = createSignIn();
    expect(expiresAt).toBe(Date.now() + SCOPE_STEP_UP_LIVE_TTL_MS);
    const claimed = claimLocalScopeStepUpContinuation({
      continuationId,
      toolCallId: "call-1",
      bindingKey: BINDING,
    });
    expect(claimed).toMatchObject({
      reason: "authorization_required",
      serverName: "Orders",
      toolName: "get_my_orders",
      input: { since: "2026-01-01" },
    });
  });

  describe("TTL sweeper", () => {
    it("clears the saved input when the window runs out, without a claim", () => {
      const { continuationId } = createSignIn();
      expect(
        __peekLocalScopeStepUpContinuationForTests(continuationId),
      ).toEqual({ status: "pending", inputPresent: true });

      vi.advanceTimersByTime(
        SCOPE_STEP_UP_LIVE_TTL_MS + LOCAL_CONTINUATION_SWEEP_INTERVAL_MS,
      );
      expect(
        __peekLocalScopeStepUpContinuationForTests(continuationId),
      ).toEqual({ status: "expired", inputPresent: false });
    });

    it("keeps a sign-in tombstone long enough to settle history, then drops it", () => {
      const { continuationId } = createSignIn();
      vi.advanceTimersByTime(
        SCOPE_STEP_UP_LIVE_TTL_MS + LOCAL_CONTINUATION_SWEEP_INTERVAL_MS,
      );
      vi.advanceTimersByTime(AUTH_CHALLENGE_TOMBSTONE_TTL_MS / 2);
      expect(
        __peekLocalScopeStepUpContinuationForTests(continuationId)?.status,
      ).toBe("expired");

      vi.advanceTimersByTime(AUTH_CHALLENGE_TOMBSTONE_TTL_MS);
      expect(
        __peekLocalScopeStepUpContinuationForTests(continuationId),
      ).toBeUndefined();
    });

    it("sweeps step-up windows too, keeping the expired answer for a while", () => {
      const event = createStepUp();
      vi.advanceTimersByTime(
        SCOPE_STEP_UP_LIVE_TTL_MS + LOCAL_CONTINUATION_SWEEP_INTERVAL_MS,
      );
      expect(
        __peekLocalScopeStepUpContinuationForTests(event.continuationId),
      ).toEqual({ status: "expired", inputPresent: false });
      expect(() =>
        claimLocalScopeStepUpContinuation({
          continuationId: event.continuationId,
          toolCallId: "call-2",
          bindingKey: BINDING,
        }),
      ).toThrow("scope_step_up_continuation_expired");
    });
  });

  describe("cancel request (send without clicking)", () => {
    it("answers a pending sign-in with its reason", () => {
      const { continuationId } = createSignIn();
      expect(
        cancelLocalScopeStepUpContinuationForRequest({
          continuationId,
          toolCallId: "call-1",
          bindingKey: BINDING,
          reason: "sign-in was not completed",
        }),
      ).toEqual({
        serverId: "orders",
        serverName: "Orders",
        toolName: "get_my_orders",
        reason: "authorization_required",
      });
      expect(
        __peekLocalScopeStepUpContinuationForTests(continuationId),
      ).toEqual({ status: "cancelled", inputPresent: false });
    });

    it("still answers a sign-in whose window already expired", () => {
      const { continuationId } = createSignIn();
      vi.advanceTimersByTime(SCOPE_STEP_UP_LIVE_TTL_MS + 1);
      expect(
        cancelLocalScopeStepUpContinuationForRequest({
          continuationId,
          toolCallId: "call-1",
          bindingKey: BINDING,
          reason: "sign-in was not completed",
        }),
      ).toMatchObject({ reason: "authorization_required" });
    });

    it("keeps refusing an expired step-up, exactly as before", () => {
      const event = createStepUp();
      vi.advanceTimersByTime(SCOPE_STEP_UP_LIVE_TTL_MS + 1);
      expect(() =>
        cancelLocalScopeStepUpContinuationForRequest({
          continuationId: event.continuationId,
          toolCallId: "call-2",
          bindingKey: BINDING,
          reason: "authorization was not completed",
        }),
      ).toThrow("scope_step_up_continuation_expired");
    });
  });

  describe("history settlement", () => {
    it("cancels a pending sign-in for an inherited unresolved call", () => {
      const { continuationId } = createSignIn();
      expect(
        settleLocalAuthChallengeHistoryCall({
          bindingKey: BINDING,
          toolCallId: "call-1",
        }),
      ).toEqual({
        serverId: "orders",
        serverName: "Orders",
        toolName: "get_my_orders",
      });
      expect(() =>
        claimLocalScopeStepUpContinuation({
          continuationId,
          toolCallId: "call-1",
          bindingKey: BINDING,
        }),
      ).toThrow("scope_step_up_continuation_cancelled");
    });

    it("settles an expired sign-in too", () => {
      createSignIn();
      vi.advanceTimersByTime(
        SCOPE_STEP_UP_LIVE_TTL_MS + LOCAL_CONTINUATION_SWEEP_INTERVAL_MS,
      );
      expect(
        settleLocalAuthChallengeHistoryCall({
          bindingKey: BINDING,
          toolCallId: "call-1",
        }),
      ).toMatchObject({ toolName: "get_my_orders" });
    });

    it("never crosses a conversation binding", () => {
      createSignIn();
      expect(
        settleLocalAuthChallengeHistoryCall({
          bindingKey: "someone-else",
          toolCallId: "call-1",
        }),
      ).toBeUndefined();
    });

    it("leaves step-up calls and unknown calls alone", () => {
      const event = createStepUp();
      expect(
        settleLocalAuthChallengeHistoryCall({
          bindingKey: BINDING,
          toolCallId: "call-2",
        }),
      ).toBeUndefined();
      expect(
        __peekLocalScopeStepUpContinuationForTests(event.continuationId)
          ?.status,
      ).toBe("pending");
      expect(
        settleLocalAuthChallengeHistoryCall({
          bindingKey: BINDING,
          toolCallId: "never-suspended",
        }),
      ).toBeUndefined();
    });

    it("does not settle a call whose replay is in progress or done", () => {
      const { continuationId } = createSignIn();
      claimLocalScopeStepUpContinuation({
        continuationId,
        toolCallId: "call-1",
        bindingKey: BINDING,
      });
      expect(
        settleLocalAuthChallengeHistoryCall({
          bindingKey: BINDING,
          toolCallId: "call-1",
        }),
      ).toBeUndefined();
      completeLocalScopeStepUpContinuation(continuationId);
      expect(
        settleLocalAuthChallengeHistoryCall({
          bindingKey: BINDING,
          toolCallId: "call-1",
        }),
      ).toBeUndefined();
    });
  });

  describe("repeat after sign-in", () => {
    it("remembers a completed sign-in for the same operation for one window", () => {
      const { continuationId } = createSignIn();
      claimLocalScopeStepUpContinuation({
        continuationId,
        toolCallId: "call-1",
        bindingKey: BINDING,
      });
      completeLocalScopeStepUpContinuation(continuationId);
      const query = {
        bindingKey: BINDING,
        serverId: "orders",
        toolName: "get_my_orders",
      };
      expect(hasRecentLocalAuthSignIn(query)).toBe(true);
      expect(
        hasRecentLocalAuthSignIn({ ...query, toolName: "list_products" }),
      ).toBe(false);
      expect(
        hasRecentLocalAuthSignIn({ ...query, bindingKey: "someone-else" }),
      ).toBe(false);
      vi.advanceTimersByTime(SCOPE_STEP_UP_LIVE_TTL_MS + 1);
      expect(hasRecentLocalAuthSignIn(query)).toBe(false);
    });

    it("counts a replay refused again as a sign-in that happened", () => {
      const { continuationId } = createSignIn();
      claimLocalScopeStepUpContinuation({
        continuationId,
        toolCallId: "call-1",
        bindingKey: BINDING,
      });
      failLocalScopeStepUpContinuation(
        continuationId,
        AUTH_CHALLENGE_REPEATED_REASON,
      );
      expect(
        hasRecentLocalAuthSignIn({
          bindingKey: BINDING,
          serverId: "orders",
          toolName: "get_my_orders",
        }),
      ).toBe(true);
    });

    it("does not count an abandoned or cancelled sign-in", () => {
      createSignIn();
      settleLocalAuthChallengeHistoryCall({
        bindingKey: BINDING,
        toolCallId: "call-1",
      });
      expect(
        hasRecentLocalAuthSignIn({
          bindingKey: BINDING,
          serverId: "orders",
          toolName: "get_my_orders",
        }),
      ).toBe(false);
    });
  });
});
