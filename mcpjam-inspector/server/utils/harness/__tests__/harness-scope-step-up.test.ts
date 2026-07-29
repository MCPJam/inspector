import { InsufficientScopeError } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetHarnessScopeStepUpForTests,
  normalizeHarnessScopeStepUpCorrelationId,
  publishHarnessScopeStepUp,
  publishHarnessScopeStepUpFromToolError,
  subscribeHarnessScopeStepUp,
} from "../harness-scope-step-up.js";

const TURN_A = "11111111-1111-4111-8111-111111111111";
const TURN_B = "22222222-2222-4222-8222-222222222222";

describe("harness scope step-up correlation", () => {
  beforeEach(() => {
    __resetHarnessScopeStepUpForTests();
  });

  it("isolates concurrent turns and ignores late events after teardown", () => {
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    const stopA = subscribeHarnessScopeStepUp(TURN_A, listenerA);
    subscribeHarnessScopeStepUp(TURN_B, listenerB);

    publishHarnessScopeStepUp(TURN_A, {
      serverId: "auth-bench",
      requiredScope: "bench:write",
    });
    expect(listenerA).toHaveBeenCalledTimes(1);
    expect(listenerB).not.toHaveBeenCalled();

    stopA();
    publishHarnessScopeStepUp(TURN_A, {
      serverId: "auth-bench",
      requiredScope: "bench:write",
    });
    expect(listenerA).toHaveBeenCalledTimes(1);
  });

  it("shares the branded-error extraction and actionable-field gate", () => {
    const listener = vi.fn();
    subscribeHarnessScopeStepUp(TURN_A, listener);

    publishHarnessScopeStepUpFromToolError(TURN_A, {
      serverId: "auth-bench",
      toolCallId: "call-1",
      error: new InsufficientScopeError({
        requiredScope: "bench:write",
        resourceMetadataUrl: new URL(
          "https://bench.example/.well-known/oauth-protected-resource",
        ),
      }),
    });
    expect(listener).toHaveBeenCalledWith({
      serverId: "auth-bench",
      toolCallId: "call-1",
      requiredScope: "bench:write",
      resourceMetadataUrl:
        "https://bench.example/.well-known/oauth-protected-resource",
      errorDescription: undefined,
    });

    publishHarnessScopeStepUpFromToolError(TURN_A, {
      serverId: "auth-bench",
      error: new InsufficientScopeError({
        errorDescription: "More access is required",
      }),
    });
    publishHarnessScopeStepUpFromToolError(TURN_A, {
      serverId: "auth-bench",
      error: new Error("ordinary failure"),
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed correlation ids", () => {
    expect(
      normalizeHarnessScopeStepUpCorrelationId("not-a-turn"),
    ).toBeUndefined();
    const listener = vi.fn();
    subscribeHarnessScopeStepUp("not-a-turn", listener);
    publishHarnessScopeStepUp("not-a-turn", {
      serverId: "auth-bench",
      requiredScope: "bench:write",
    });
    expect(listener).not.toHaveBeenCalled();
  });
});
