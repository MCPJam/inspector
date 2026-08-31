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

import {
  AUTHORIZATION_SERVER_METADATA_MISSING_ISSUER,
  executeDynamicClientRegistration,
} from "@mcpjam/sdk/browser";

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

/**
 * Replay the pair of messages one failed registration writes: the bare failure,
 * then the same failure with the fallback hint appended once no pre-registered
 * client turns up. Taken from the SDK outcome so a rewording there cannot leave
 * this asserting stale text.
 */
async function replayRegistrationFailure(status: number) {
  const dcr = await executeDynamicClientRegistration({
    request: {
      method: "POST",
      url: "https://auth.example.test/register",
      headers: {},
      body: { client_name: "Test Client" },
    },
    requestExecutor: async () => ({
      ok: false,
      status,
      statusText: "Registration failed",
      headers: {},
      body: { error: "registration_failed" },
    }),
  });
  if (dcr.status === "registered") {
    throw new Error(`expected a ${status} outcome`);
  }

  const { wrapped, updateState } = wrappedUpdateState(
    vi.fn(),
    "request_client_registration",
  );
  wrapped({ error: dcr.error });
  wrapped({ error: dcr.errorWithFallbackHint });
  return { updateState };
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

  it("ignores a registration the authorization server refused", async () => {
    // A 4xx from the registration endpoint is that server declining to mint a
    // client, which is what the debugger exists to show — not a defect here.
    const { updateState } = await replayRegistrationFailure(400);

    expect(reportCaught).not.toHaveBeenCalled();
    // Silenced for Sentry only — both messages still reach the screen.
    expect(updateState).toHaveBeenCalledTimes(2);
  });

  it("reports a registration the server failed to answer exactly once", async () => {
    // A 5xx can be ours (a broken debug proxy), so it still reports. One
    // failure writes two strings though — the bare message, then the same
    // message with the fallback hint appended — and both used to file an issue.
    await replayRegistrationFailure(503);

    expect(reportCaught).toHaveBeenCalledTimes(1);
  });

  it("still reports a failure that merely extends the last one", () => {
    // Only the fallback-hint pair collapses. A retry that comes back with the
    // reason the first attempt lacked is a more informative failure, not a
    // duplicate.
    const { wrapped } = wrappedUpdateState();

    wrapped({ error: "Token request failed: 400 Bad Request" });
    wrapped({ error: "Token request failed: 400 Bad Request: invalid_grant" });

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
