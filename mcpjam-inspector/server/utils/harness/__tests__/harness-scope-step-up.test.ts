import { InsufficientScopeError } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetHarnessScopeStepUpForTests,
  harnessScopeStepUpServerMatches,
  matchHarnessScopeStepUpToolCall,
  normalizeHarnessScopeStepUpCorrelationId,
  publishHarnessScopeStepUp,
  publishHarnessScopeStepUpFromToolError,
  stableHarnessValue,
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

/**
 * Which observed tool call a challenge resumes.
 *
 * `runHarnessTurn` suspends exactly one `toolCallId` and resumes THAT call after
 * the step-up, so picking the wrong one re-runs a call that already succeeded
 * and abandons the one that actually failed.
 */
describe("matchHarnessScopeStepUpToolCall", () => {
  const first = {
    toolCallId: "call-1",
    serverId: "cal",
    toolName: "create_event",
    input: { title: "standup" },
  };
  const second = {
    toolCallId: "call-2",
    serverId: "cal",
    toolName: "create_event",
    input: { title: "standup" },
  };

  it("resumes the call the challenge came from, not the first identical one", () => {
    // The regression: two byte-identical calls in one turn. The tuple matcher
    // returns `find`'s FIRST hit, so a challenge raised by the second call
    // resumed the first. A host-executed call carries the AI SDK `toolCallId`
    // straight out of `execute()`, so there is no need to guess.
    expect(
      matchHarnessScopeStepUpToolCall({
        observed: [first, second],
        challenge: {
          serverId: "cal",
          toolCallId: "call-2",
          requiredScope: "calendar.write",
          toolName: "create_event",
          toolInput: { title: "standup" },
        },
      }),
    ).toBe(second);
  });

  it("falls back to the tuple when the publisher had no id (the proxy path)", () => {
    // The signed proxy only ever saw an HTTP `tools/call`; it has no AI SDK id
    // to publish, so the tuple stays the correlator for native delivery.
    expect(
      matchHarnessScopeStepUpToolCall({
        observed: [
          {
            toolCallId: "call-9",
            serverId: "cal",
            toolName: "list_events",
            input: { range: "week", limit: 5 },
          },
        ],
        challenge: {
          serverId: "CAL",
          requiredScope: "calendar.read",
          toolName: "list_events",
          // Key ORDER must not matter — the proxy reserializes the arguments.
          toolInput: { limit: 5, range: "week" },
        },
      })?.toolCallId,
    ).toBe("call-9");
  });

  it("waits rather than degrading to the tuple when the id is not observed yet", () => {
    // A challenge can land before its own `tool-call` part is consumed. Falling
    // back to the tuple here is exactly how the wrong call gets resumed; the
    // correlator is re-run on every later observed call, so returning nothing
    // costs only a retry.
    expect(
      matchHarnessScopeStepUpToolCall({
        observed: [first],
        challenge: {
          serverId: "cal",
          toolCallId: "call-2",
          requiredScope: "calendar.write",
          toolName: "create_event",
          toolInput: { title: "standup" },
        },
      }),
    ).toBeUndefined();
  });

  it("ignores a tuple match on a different server or tool", () => {
    expect(
      matchHarnessScopeStepUpToolCall({
        observed: [first],
        challenge: {
          serverId: "other",
          requiredScope: "x",
          toolName: "create_event",
          toolInput: { title: "standup" },
        },
      }),
    ).toBeUndefined();
    expect(
      matchHarnessScopeStepUpToolCall({
        observed: [first],
        challenge: {
          serverId: "cal",
          requiredScope: "x",
          toolName: "delete_event",
          toolInput: { title: "standup" },
        },
      }),
    ).toBeUndefined();
  });
});

describe("stableHarnessValue", () => {
  it("is order-independent for objects and order-sensitive for arrays", () => {
    expect(stableHarnessValue({ a: 1, b: [2, { d: 4, c: 3 }] })).toBe(
      stableHarnessValue({ b: [2, { c: 3, d: 4 }], a: 1 }),
    );
    expect(stableHarnessValue([1, 2])).not.toBe(stableHarnessValue([2, 1]));
    expect(stableHarnessValue(undefined)).toBe("null");
  });
});
