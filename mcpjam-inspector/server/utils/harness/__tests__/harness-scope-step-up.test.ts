import { InsufficientScopeError } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetHarnessScopeStepUpForTests,
  harnessScopeStepUpServerMatches,
  normalizeHarnessScopeStepUpCorrelationId,
  publishHarnessScopeStepUp,
  publishHarnessScopeStepUpFromToolError,
  subscribeHarnessScopeStepUp,
} from "../harness-scope-step-up.js";
import { inspectorCommandBus } from "../../../services/inspector-command-bus.js";

const TURN_A = "11111111-1111-4111-8111-111111111111";
const TURN_B = "22222222-2222-4222-8222-222222222222";

describe("harness scope step-up correlation", () => {
  beforeEach(() => {
    __resetHarnessScopeStepUpForTests();
  });

  it("isolates concurrent turns and ignores late events after teardown", () => {
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    const stopA = subscribeHarnessScopeStepUp(TURN_A, listenerA, [
      "auth-bench",
    ]);
    subscribeHarnessScopeStepUp(TURN_B, listenerB, ["other-server"]);

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

  it("recovers a missing or stale turn id for one live turn on the server", () => {
    const listener = vi.fn();
    subscribeHarnessScopeStepUp(TURN_A, listener, ["auth-bench"]);

    publishHarnessScopeStepUp(undefined, {
      serverId: "auth-bench",
      requiredScope: "bench:write",
    });
    publishHarnessScopeStepUp(TURN_B, {
      serverId: "AUTH-BENCH",
      requiredScope: "bench:write",
    });

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("also notifies the active local Inspector client", () => {
    const sendEvent = vi.fn();
    const unregister = inspectorCommandBus.registerSubscriber({
      clientId: "scope-step-up-test",
      send: vi.fn(),
      sendEvent,
      supersede: vi.fn(),
      close: vi.fn(),
    });
    subscribeHarnessScopeStepUp(TURN_A, vi.fn(), ["auth-bench"]);

    publishHarnessScopeStepUp(undefined, {
      serverId: "auth-bench",
      toolCallId: "call-1",
      requiredScope: "bench:write",
    });

    expect(sendEvent).toHaveBeenCalledWith({
      kind: "scope_step_up",
      serverId: "auth-bench",
      toolCallId: "call-1",
      requiredScope: "bench:write",
    });
    unregister();
  });

  it("does not notify Inspector when a valid correlation names an unselected server", () => {
    const sendEvent = vi.fn();
    const unregister = inspectorCommandBus.registerSubscriber({
      clientId: "scope-step-up-mismatch-test",
      send: vi.fn(),
      sendEvent,
      supersede: vi.fn(),
      close: vi.fn(),
    });
    const listener = vi.fn();
    subscribeHarnessScopeStepUp(TURN_A, listener, ["auth-bench"]);

    try {
      publishHarnessScopeStepUp(TURN_A, {
        serverId: "other-server",
        requiredScope: "other:write",
      });

      // Correlation delivery is unchanged; run-harness-turn applies its
      // selectedServers filter before writing this event into the chat stream.
      expect(listener).toHaveBeenCalledTimes(1);
      expect(sendEvent).not.toHaveBeenCalled();

      publishHarnessScopeStepUp(TURN_A, {
        serverId: "AUTH-BENCH",
        requiredScope: "bench:write",
      });
      expect(listener).toHaveBeenCalledTimes(2);
      expect(sendEvent).toHaveBeenCalledWith({
        kind: "scope_step_up",
        serverId: "AUTH-BENCH",
        requiredScope: "bench:write",
      });
    } finally {
      unregister();
    }
  });

  it("drops an uncorrelated challenge when two live turns share the server", () => {
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    subscribeHarnessScopeStepUp(TURN_A, listenerA, ["auth-bench"]);
    subscribeHarnessScopeStepUp(TURN_B, listenerB, ["auth-bench"]);

    publishHarnessScopeStepUp(undefined, {
      serverId: "auth-bench",
      requiredScope: "bench:write",
    });

    expect(listenerA).not.toHaveBeenCalled();
    expect(listenerB).not.toHaveBeenCalled();
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

  it("matches a subscriber's server filter the way routing does", () => {
    // A subscriber that filtered with a bare `includes` would drop a variant
    // this registry had already routed (and already told Inspector about).
    expect(harnessScopeStepUpServerMatches(["auth-bench"], "AUTH-BENCH")).toBe(
      true,
    );
    expect(
      harnessScopeStepUpServerMatches(["AUTH-BENCH"], " auth-bench "),
    ).toBe(true);
    expect(harnessScopeStepUpServerMatches(["auth-bench"], "other")).toBe(
      false,
    );
    expect(harnessScopeStepUpServerMatches([], "auth-bench")).toBe(false);
    expect(harnessScopeStepUpServerMatches(undefined, "auth-bench")).toBe(
      false,
    );
  });
});
