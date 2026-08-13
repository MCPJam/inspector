/**
 * The connection worker.
 *
 * The assertions that earn their place here are about the FAILURE TAXONOMY.
 * Three outcomes look nearly identical in a stack trace and mean completely
 * different things to the user: a network blip should keep the credential and
 * retry, a rejected token should send them back to consent, and a non-MCP
 * endpoint should stop immediately. Classifying a blip as an auth failure
 * throws away a working grant; classifying a bad endpoint as retryable burns
 * five attempts before admitting it.
 *
 * The other load-bearing assertion is that the worker never picks its own step
 * — it does what the lease response's `status` told it, because that routing
 * rule belongs to the backend's transition table and a second copy here would
 * be free to disagree.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  acquireLease: vi.fn(),
  releaseLease: vi.fn(),
  reportDiscovery: vi.fn(),
  reportValidation: vi.fn(),
  fetchValidationContext: vi.fn(),
}));

const discovery = vi.hoisted(() => ({
  runDiscoveryPreflight: vi.fn(),
}));

const probe = vi.hoisted(() => ({
  probeMcpServer: vi.fn(),
}));

vi.mock("../server-connections-backend.js", async () => {
  const actual = await vi.importActual<
    typeof import("../server-connections-backend.js")
  >("../server-connections-backend.js");
  return { ...actual, ...backend };
});

vi.mock("../server-connection-discovery.js", () => discovery);

vi.mock("@mcpjam/sdk", () => probe);

const { runConnectionJob } = await import("../server-connection-worker.js");

function leased(status: string, extra: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    leased: true,
    status,
    serverUrl: "https://example.com/mcp",
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  backend.releaseLease.mockResolvedValue(undefined);
  backend.reportDiscovery.mockResolvedValue({ status: "validating" });
  backend.reportValidation.mockResolvedValue({ status: "ready" });
});

describe("lease handling", () => {
  it("does nothing when another worker holds the lease", async () => {
    backend.acquireLease.mockResolvedValue({
      ok: true,
      leased: false,
      reason: "leased",
    });

    const result = await runConnectionJob("scr_x");

    expect(result).toEqual({
      requestId: "scr_x",
      ran: false,
      skipped: "not-leased",
    });
    // A refusal is the lease working, so nothing is reported and nothing fails.
    expect(backend.reportDiscovery).not.toHaveBeenCalled();
    expect(backend.reportValidation).not.toHaveBeenCalled();
  });

  it("releases the lease for a status that is waiting on a person", async () => {
    backend.acquireLease.mockResolvedValue(leased("awaiting_authorization"));

    const result = await runConnectionJob("scr_x");

    expect(result.skipped).toBe("not-actionable");
    expect(backend.releaseLease).toHaveBeenCalledWith("scr_x", expect.any(String));
    expect(backend.reportValidation).not.toHaveBeenCalled();
  });

  it("runs discovery only when the lease said discovering", async () => {
    backend.acquireLease.mockResolvedValue(leased("discovering"));
    discovery.runDiscoveryPreflight.mockResolvedValue({
      kind: "discovered",
      authMethod: "oauth",
      detail: "ok",
    });

    await runConnectionJob("scr_x");

    expect(discovery.runDiscoveryPreflight).toHaveBeenCalled();
    expect(backend.fetchValidationContext).not.toHaveBeenCalled();
  });
});

describe("discovery outcomes", () => {
  it("passes a discovered auth method straight through", async () => {
    backend.acquireLease.mockResolvedValue(leased("discovering"));
    discovery.runDiscoveryPreflight.mockResolvedValue({
      kind: "discovered",
      authMethod: "none",
      detail: "ok",
    });

    await runConnectionJob("scr_x");

    expect(backend.reportDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ authMethod: "none" })
    );
  });

  it("reports a blocked or non-MCP target as unsupported, which is terminal", async () => {
    backend.acquireLease.mockResolvedValue(leased("discovering"));
    discovery.runDiscoveryPreflight.mockResolvedValue({
      kind: "terminal",
      errorCode: "URL_NOT_ALLOWED",
      detail: "blocked",
    });

    await runConnectionJob("scr_x");

    expect(backend.reportDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({ authMethod: "unsupported" })
    );
  });

  it("reports a transient discovery failure as retryable", async () => {
    backend.acquireLease.mockResolvedValue(leased("discovering"));
    discovery.runDiscoveryPreflight.mockResolvedValue({
      kind: "retryable",
      detail: "dns hiccup",
    });

    await runConnectionJob("scr_x");

    expect(backend.reportValidation).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "retryable" })
    );
  });
});

describe("validation outcomes", () => {
  beforeEach(() => {
    backend.acquireLease.mockResolvedValue(leased("validating"));
  });

  it("reports ready when an authenticated initialize succeeds", async () => {
    backend.fetchValidationContext.mockResolvedValue({
      serverUrl: "https://example.com/mcp",
      accessToken: "secret-token",
      authMethod: "oauth",
    });
    probe.probeMcpServer.mockResolvedValue({
      status: "ok",
      initialize: { protocolVersion: "2025-06-18" },
    });

    await runConnectionJob("scr_x");

    expect(backend.reportValidation).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "ready" })
    );
    // The credential must reach the probe, and only the probe.
    expect(probe.probeMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "secret-token" })
    );
  });

  it("validates an unauthenticated target with no credential at all", async () => {
    backend.fetchValidationContext.mockResolvedValue({
      serverUrl: "https://example.com/mcp",
      accessToken: null,
      authMethod: "none",
    });
    probe.probeMcpServer.mockResolvedValue({
      status: "ok",
      initialize: { protocolVersion: "2025-06-18" },
    });

    await runConnectionJob("scr_x");

    expect(backend.reportValidation).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "ready" })
    );
  });

  it("sends the user back to consent when an OAuth target has no stored token", async () => {
    backend.fetchValidationContext.mockResolvedValue({
      serverUrl: "https://example.com/mcp",
      accessToken: null,
      authMethod: "oauth",
    });

    await runConnectionJob("scr_x");

    expect(backend.reportValidation).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "authentication-failed" })
    );
    // Nothing was probed — there was nothing to probe with.
    expect(probe.probeMcpServer).not.toHaveBeenCalled();
  });

  it("treats an OAuth challenge at validation time as an auth failure, not a retry", async () => {
    backend.fetchValidationContext.mockResolvedValue({
      serverUrl: "https://example.com/mcp",
      accessToken: "stale-token",
      authMethod: "oauth",
    });
    probe.probeMcpServer.mockResolvedValue({
      status: "unauthorized",
      oauth: { required: true },
    });

    await runConnectionJob("scr_x");

    // Retrying with the same rejected token would burn the job budget without
    // ever asking the user for the thing that would fix it.
    expect(backend.reportValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "authentication-failed",
        errorCode: "AUTHENTICATION_FAILED",
      })
    );
  });

  it("is terminal for an endpoint that answers but is not MCP", async () => {
    backend.fetchValidationContext.mockResolvedValue({
      serverUrl: "https://example.com/mcp",
      accessToken: null,
      authMethod: "none",
    });
    probe.probeMcpServer.mockResolvedValue({
      status: "error",
      error: "Response is not a valid JSON-RPC message",
    });

    await runConnectionJob("scr_x");

    expect(backend.reportValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "terminal",
        errorCode: "PROTOCOL_VALIDATION_FAILED",
      })
    );
  });

  it("is retryable for an ambiguous network failure", async () => {
    backend.fetchValidationContext.mockResolvedValue({
      serverUrl: "https://example.com/mcp",
      accessToken: null,
      authMethod: "none",
    });
    probe.probeMcpServer.mockRejectedValue(new Error("socket hang up"));

    await runConnectionJob("scr_x");

    // Deliberately conservative: a wrong `retryable` costs seconds, a wrong
    // `terminal` tells the user their working server is broken.
    expect(backend.reportValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "retryable",
        errorCode: "VALIDATION_FAILED",
      })
    );
  });

  it("fails terminally when the request has no server URL to validate", async () => {
    backend.fetchValidationContext.mockResolvedValue({
      serverUrl: null,
      accessToken: null,
      authMethod: null,
    });

    await runConnectionJob("scr_x");

    expect(backend.reportValidation).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "terminal" })
    );
  });
});
