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

  it("still forwards every update to the caller's updateState", () => {
    const { wrapped, updateState } = wrappedUpdateState();

    wrapped({ error: "boom" });
    wrapped({ authorizationCode: "abc" });

    expect(updateState).toHaveBeenCalledTimes(2);
    expect(updateState).toHaveBeenNthCalledWith(1, { error: "boom" });
    expect(updateState).toHaveBeenNthCalledWith(2, { authorizationCode: "abc" });
  });
});

/**
 * Regression: INSPECTOR-CLIENT-22N.
 *
 * Every report here is built by ONE `new Error(...)` on ONE line, so every
 * event carries an identical stack — and Sentry's default JS grouping is the
 * stack, not the message. Ten unrelated failure classes across eight users
 * collapsed into a single "escalating" issue whose alert quoted whichever
 * event happened to fire it, while two genuine leads (a null-swallowing
 * metadata error, an `iss` check tripping on a trailing slash) sat buried in
 * it. The wrapper has to hand Sentry an explicit grouping key.
 */
describe("OAuth debugger step-failure grouping", () => {
  beforeEach(() => {
    reportCaught.mockReset();
    createOAuthStateMachine.mockClear();
  });

  /** Verbatim from the issue's event list, one per distinct failure class. */
  const PRODUCTION_FAILURES = [
    "Dynamic Client Registration failed (403). Configure a pre-registered client or enable DCR on the authorization server.",
    "Could not discover authorization server metadata. Last error: null",
    "PKCE is REQUIRED for 2025-11-25 protocol, but authorization server does not advertise code_challenge_methods_supported. Server is not compliant with 2025-11-25 spec.",
    "Token request failed: invalid_client - Client authentication failed (e.g., unknown client, no client authentication included, or unsupported authentication method).",
    "Missing authorization code",
    "Failed to request MCP server: Backend debug proxy error: 500 Internal Server Error: connect ECONNREFUSED 127.0.0.1:9876",
    "Failed to request MCP server: Backend debug proxy error: 400 Bad Request: OAuth proxy target resolves to a private/reserved IP address (198.18.2.250)",
    "Failed to request MCP server: Backend debug proxy error: 401 Unauthorized: Invalid session token.",
    "Authorization response `iss` does not match the issuer this flow started with. Recorded from authorization-server metadata: `https://localhost:7218`; returned on the callback: `https://localhost:7218/`.",
    "Authenticated request failed: 400 Bad Request",
  ];

  /** Clear between messages so the dedupe memo never suppresses a report. */
  function reportEach(
    wrapped: (u: Record<string, unknown>) => void,
    errors: string[],
  ) {
    for (const error of errors) {
      wrapped({ error: undefined });
      wrapped({ error });
    }
    return reportCaught.mock.calls.map(([, options]) =>
      JSON.stringify((options as { fingerprint?: string[] }).fingerprint),
    );
  }

  it("groups each production failure class separately", () => {
    const { wrapped } = wrappedUpdateState();

    const fingerprints = reportEach(wrapped, PRODUCTION_FAILURES);

    expect(fingerprints).toHaveLength(PRODUCTION_FAILURES.length);
    expect(fingerprints.every(Boolean)).toBe(true);
    expect(new Set(fingerprints).size).toBe(PRODUCTION_FAILURES.length);
  });

  it("keeps one class together when only a volatile value differs", () => {
    // The same guard rejection reached Sentry three times with three different
    // addresses. Fingerprinting on the raw message would split one failure
    // class into one issue per user's LAN.
    const { wrapped } = wrappedUpdateState();

    const fingerprints = reportEach(wrapped, [
      "Failed to request MCP server: Backend debug proxy error: 400 Bad Request: OAuth proxy target resolves to a private/reserved IP address (10.22.7.151)",
      "Failed to request MCP server: Backend debug proxy error: 400 Bad Request: OAuth proxy target resolves to a private/reserved IP address (198.18.2.250)",
      "Failed to request MCP server: Backend debug proxy error: 400 Bad Request: OAuth proxy target resolves to a private/reserved IP address (fd53:1c5a:1000::c8e3:cf02)",
    ]);

    // Assert they exist as well as agree: three absent fingerprints are also
    // one distinct value, and that is the bug this suite exists to catch.
    expect(fingerprints.every(Boolean)).toBe(true);
    expect(new Set(fingerprints).size).toBe(1);
  });

  it("separates the same message raised at different steps", () => {
    // No intervening clear: the dedupe memo has to key on the step too, or the
    // second report — a distinct issue under this fingerprint — is swallowed.
    const { wrapped } = wrappedUpdateState();

    wrapped({ error: "Authenticated request failed: 400 Bad Request" });
    wrapped({
      error: "Authenticated request failed: 400 Bad Request",
      currentStep: "token_request",
    });

    expect(reportCaught).toHaveBeenCalledTimes(2);
    const [first, second] = reportCaught.mock.calls.map(
      ([, o]) => (o as { fingerprint?: string[] }).fingerprint,
    );
    expect(first).not.toEqual(second);
  });

  it("tags step and protocol version so triage can filter on them", () => {
    // `extra` is not indexed for search in Sentry; tags are. Without this the
    // per-step dimension the reporter collects cannot be queried.
    const { wrapped } = wrappedUpdateState(vi.fn(), "metadata");

    wrapped({ error: "boom", currentStep: "token_request" });

    expect(reportCaught.mock.calls[0][1]).toMatchObject({
      tags: {
        oauth_step: "token_request",
        oauth_protocol_version: "2025-06-18",
      },
    });
  });
});
