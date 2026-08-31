import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reportCaught, createOAuthStateMachine } = vi.hoisted(() => ({
  reportCaught: vi.fn(),
  createOAuthStateMachine: vi.fn(() => ({ proceedToNextStep: vi.fn() })),
}));

vi.mock("@/lib/error-reporting", () => ({
  reportCaught,
  reportBoundaryError: vi.fn(),
}));

vi.mock("@mcpjam/sdk/browser", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createOAuthStateMachine };
});

import { AUTHORIZATION_SERVER_METADATA_MISSING_ISSUER } from "@mcpjam/sdk/browser";

import { createInspectorOAuthStateMachine } from "../debug-state-machine-adapter";

/**
 * Build the machine, then reach the `updateState` the adapter actually handed
 * to the SDK — that wrapper is what we are testing.
 */
function wrappedUpdateState(updateState = vi.fn(), currentStep = "metadata") {
  createInspectorOAuthStateMachine({
    protocolVersion: "2025-06-18",
    registrationStrategy: "dynamic",
    state: { currentStep } as never,
    updateState,
    serverUrl: "https://example.test/mcp",
    serverName: "example",
  } as never);

  const passed = createOAuthStateMachine.mock.calls.at(-1)![0] as {
    updateState: (u: Record<string, unknown>) => void;
  };
  return { wrapped: passed.updateState, updateState };
}

describe("OAuth debugger step-failure reporting", () => {
  beforeEach(() => {
    reportCaught.mockReset();
    createOAuthStateMachine.mockClear();
  });

  afterEach(() => vi.restoreAllMocks());

  it("attributes the report to the step the update moves TO", () => {
    const { wrapped } = wrappedUpdateState(vi.fn(), "metadata");

    wrapped({ error: "boom", currentStep: "token_request" });

    expect(reportCaught.mock.calls[0][1]).toMatchObject({
      extra: { step: "token_request" },
    });
  });

  it("reports exactly one warning per new error", () => {
    const { wrapped } = wrappedUpdateState();

    wrapped({ error: "token exchange failed: 401" });

    expect(reportCaught).toHaveBeenCalledTimes(1);
    const [error, options] = reportCaught.mock.calls[0];
    expect((error as Error).message).toBe("token exchange failed: 401");
    expect(options).toMatchObject({
      source: "oauth_debugger_step",
      level: "warning",
      extra: { step: "metadata", protocolVersion: "2025-06-18" },
    });
  });

  it("does not re-report the same error on a repeated update", () => {
    const { wrapped } = wrappedUpdateState();

    wrapped({ error: "same failure" });
    wrapped({ error: "same failure" });
    wrapped({ error: "same failure" });

    expect(reportCaught).toHaveBeenCalledTimes(1);
  });

  it("reports a genuinely different error", () => {
    const { wrapped } = wrappedUpdateState();

    wrapped({ error: "first" });
    wrapped({ error: "second" });

    expect(reportCaught).toHaveBeenCalledTimes(2);
  });

  it("reports the same message again after the error is cleared", () => {
    // A retry that fails identically is a new failure, not a duplicate.
    const { wrapped } = wrappedUpdateState();

    wrapped({ error: "flaky metadata fetch" });
    wrapped({ error: undefined });
    wrapped({ error: "flaky metadata fetch" });

    expect(reportCaught).toHaveBeenCalledTimes(2);
  });

  it("ignores updates that carry no error", () => {
    const { wrapped } = wrappedUpdateState();

    wrapped({ authorizationCode: "abc" });
    wrapped({ error: "" });

    expect(reportCaught).not.toHaveBeenCalled();
  });

  it("ignores advisory warnings the flow recovers from", () => {
    const { wrapped, updateState } = wrappedUpdateState();

    const advisory = {
      error: "Warning: Authorization server may not support S256 PKCE method",
    };
    wrapped(advisory);

    expect(reportCaught).not.toHaveBeenCalled();
    expect(updateState).toHaveBeenCalledWith(advisory);
  });

  it("ignores a metadata document missing the RFC 8414 issuer", () => {
    // Stops the flow, but it is the server under test violating RFC 8414 and
    // nothing we act on — it must stay on screen without reaching Sentry.
    // The message comes from the SDK export the machines throw, so a rephrasing
    // there cannot leave the adapter matching on stale text.
    const { wrapped, updateState } = wrappedUpdateState();

    const serverFault = {
      error: AUTHORIZATION_SERVER_METADATA_MISSING_ISSUER,
    };
    wrapped(serverFault);

    expect(reportCaught).not.toHaveBeenCalled();
    expect(updateState).toHaveBeenCalledWith(serverFault);
  });

  it("still reports a real failure that follows a warning", () => {
    const { wrapped } = wrappedUpdateState();

    wrapped({ error: "Warning: Authorization server may not support S256" });
    wrapped({ error: "token exchange failed: 401" });

    expect(reportCaught).toHaveBeenCalledTimes(1);
    expect((reportCaught.mock.calls[0][0] as Error).message).toBe(
      "token exchange failed: 401",
    );
  });

  it("reports the same failure again when a warning came between", () => {
    // The warning replaced the message on screen, so the recurrence is a new
    // failure — not the duplicate update the dedup guard exists to swallow.
    const { wrapped } = wrappedUpdateState();

    wrapped({ error: "token exchange failed: 401" });
    wrapped({ error: "Warning: Authorization server may not support S256" });
    wrapped({ error: "token exchange failed: 401" });

    expect(reportCaught).toHaveBeenCalledTimes(2);
  });

  it("reports one failure once when the hint is appended after it", () => {
    // The SDK writes the bare message, then the same message with the recovery
    // hint (`errorWithFallbackHint`). Two strings, one refusal — and exact
    // comparison reported both, a millisecond apart.
    const { wrapped } = wrappedUpdateState();

    wrapped({ error: "Dynamic Client Registration failed (400)." });
    wrapped({
      error:
        "Dynamic Client Registration failed (400). Configure a pre-registered client or enable DCR on the authorization server.",
    });

    expect(reportCaught).toHaveBeenCalledTimes(1);
  });

  it("swallows the pair in the other order too", () => {
    // Nothing guarantees which of the two lands first, and a guard that only
    // works one way round is a guard that works half the time.
    const { wrapped } = wrappedUpdateState();

    wrapped({ error: "Client registration failed: timeout. Configure a pre-registered client." });
    wrapped({ error: "Client registration failed: timeout." });

    expect(reportCaught).toHaveBeenCalledTimes(1);
  });

  it("does not swallow a different failure that merely follows", () => {
    // The narrowness is the point: an unrelated message never begins with the
    // whole text of the one before it.
    const { wrapped } = wrappedUpdateState();

    wrapped({ error: "Dynamic Client Registration failed (400)." });
    wrapped({ error: "Authenticated request failed: 401 Unauthorized" });

    expect(reportCaught).toHaveBeenCalledTimes(2);
  });

  it("still forwards every update to the caller's updateState", () => {
    const { wrapped, updateState } = wrappedUpdateState();

    wrapped({ error: "boom" });
    wrapped({ authorizationCode: "abc" });

    expect(updateState).toHaveBeenCalledTimes(2);
    expect(updateState).toHaveBeenNthCalledWith(1, { error: "boom" });
    expect(updateState).toHaveBeenNthCalledWith(2, { authorizationCode: "abc" });
  });
});
