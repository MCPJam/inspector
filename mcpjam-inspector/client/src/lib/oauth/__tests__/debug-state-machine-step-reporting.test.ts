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

describe("sanitizeStepError", () => {
  it("strips userinfo out of URLs the server under test echoed back", async () => {
    // error_description is whatever the server chose to return, and the
    // debugger is routinely pointed at half-built servers.
    const { sanitizeStepError } = await import(
      "../debug-state-machine-adapter"
    );
    expect(
      sanitizeStepError("failed: https://user:s3cret@example.test/token"),
    ).toBe("failed: https://[redacted]@example.test/token");
  });

  it("redacts userinfo through the LAST @ of the authority", async () => {
    // `@` is legal inside a password, so browser URL parsing treats
    // `user:secret@part` as the whole userinfo here. Stopping at the first
    // `@` would report half of it.
    const { sanitizeStepError } = await import(
      "../debug-state-machine-adapter"
    );
    const out = sanitizeStepError("POST https://user:secret@part@example.test/token");
    expect(out).not.toContain("part");
    expect(out).toBe("POST https://[redacted]@example.test/token");
  });

  it("redacts bare user:pass@host with no scheme", async () => {
    const { sanitizeStepError } = await import(
      "../debug-state-machine-adapter"
    );
    expect(sanitizeStepError("connect failed for admin:hunter2@example.test")).toBe(
      "connect failed for [redacted]@example.test",
    );
  });

  it("redacts credential query parameters by name", async () => {
    const { sanitizeStepError } = await import(
      "../debug-state-machine-adapter"
    );
    const out = sanitizeStepError(
      "POST /token?client_secret=abc123&code=xyz789&grant_type=authorization_code failed",
    );
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("xyz789");
    // The parameter NAME is the diagnostic and is preserved; so is anything
    // that is not credential-shaped.
    expect(out).toContain("client_secret=[redacted]");
    expect(out).toContain("grant_type=authorization_code");
  });

  it("redacts Authorization bearer and basic values", async () => {
    const { sanitizeStepError } = await import(
      "../debug-state-machine-adapter"
    );
    expect(
      sanitizeStepError("upstream said: Authorization: Bearer eyJhbGciOi.J9.sig"),
    ).toContain("Bearer [redacted]");
    expect(sanitizeStepError("Authorization: Basic dXNlcjpwYXNz")).toContain(
      "Basic [redacted]",
    );
  });

  it("redacts JSON credential fields", async () => {
    const { sanitizeStepError } = await import(
      "../debug-state-machine-adapter"
    );
    const out = sanitizeStepError('{"client_secret": "s3cret", "iss": "https://a.test"}');
    expect(out).not.toContain("s3cret");
    expect(out).toContain('"client_secret": "[redacted]"');
    expect(out).toContain("https://a.test");
  });

  it("keeps an escaped quote inside a JSON credential value redacted", async () => {
    // `[^"]*` would treat the escaped quote as the end of the string and
    // leave the secret's tail in the report.
    const { sanitizeStepError } = await import(
      "../debug-state-machine-adapter"
    );
    const out = sanitizeStepError(String.raw`{"client_secret":"abc\"def"}`);
    expect(out).not.toContain("def");
    expect(out).toContain('"client_secret":"[redacted]"');
  });

  it("keeps the diagnostic word after a bare Bearer/basic mention", async () => {
    // "Bearer token is expired" is a real, common error_description. A naive
    // `bearer\s+\w+` redactor eats the word that says WHAT went wrong.
    const { sanitizeStepError } = await import(
      "../debug-state-machine-adapter"
    );
    expect(sanitizeStepError("Bearer token is expired")).toBe(
      "Bearer token is expired",
    );
    expect(sanitizeStepError("the basic flow worked")).toBe(
      "the basic flow worked",
    );
    // …but a credential-shaped value is still redacted without a header.
    expect(sanitizeStepError("got Bearer eyJhbGciOi.J9.sig back")).toContain(
      "Bearer [redacted]",
    );
  });

  it("does not emit a raw credential prefix when the input cap splits one", async () => {
    const { sanitizeStepError } = await import(
      "../debug-state-machine-adapter"
    );
    // A long redactable run SHRINKS under redaction, pulling content from
    // beyond the 500-char report bound into view — so a JSON secret left
    // unterminated by the 4000-char scan bound really can surface.
    const out = sanitizeStepError(
      `access_token=${"A".repeat(3960)}{"client_secret":"SUPERSECRETVALUE"}`,
    );
    expect(out).not.toContain("SUPERSECR");
    expect(out).toContain("access_token=[redacted]");
    expect(out).toContain('"client_secret":"[redacted]');
  });

  it("redacts a truncated JSON credential that contains an escaped quote", async () => {
    // The tail guard has to be escape-aware too: `[^"]*$` stops at the
    // escaped quote, and the long redactable prefix shrinks enough to pull
    // the exposed suffix inside the 500-char report.
    const { sanitizeStepError } = await import(
      "../debug-state-machine-adapter"
    );
    const out = sanitizeStepError(
      `access_token=${"A".repeat(3960)}` +
        String.raw`{"client_secret":"abc\"SUPERSECRET"}`,
    );
    expect(out).not.toContain("SUPE");
    expect(out).toContain('"client_secret":"[redacted]');
  });

  it("caps pathological lengths", async () => {
    const { sanitizeStepError } = await import(
      "../debug-state-machine-adapter"
    );
    expect(sanitizeStepError("x".repeat(5000))).toHaveLength(500);
  });

  it("leaves an ordinary message alone", async () => {
    const { sanitizeStepError } = await import(
      "../debug-state-machine-adapter"
    );
    expect(sanitizeStepError("token exchange failed: 401")).toBe(
      "token exchange failed: 401",
    );
  });
});

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

  it("still forwards every update to the caller's updateState", () => {
    const { wrapped, updateState } = wrappedUpdateState();

    wrapped({ error: "boom" });
    wrapped({ authorizationCode: "abc" });

    expect(updateState).toHaveBeenCalledTimes(2);
    expect(updateState).toHaveBeenNthCalledWith(1, { error: "boom" });
    expect(updateState).toHaveBeenNthCalledWith(2, { authorizationCode: "abc" });
  });
});
