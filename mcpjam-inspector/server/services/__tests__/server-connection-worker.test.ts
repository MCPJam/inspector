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
import type { ProbeHttpAttempt, ProbeMcpServerResult } from "@mcpjam/sdk";
import {
  BlockedEgressTargetError,
  EgressResolutionError,
} from "../../utils/hosted-egress-guard.js";

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

/** The transport the worker hands to the probe. Mocked so a test can make it
 * refuse a target without touching DNS. */
const transport = vi.hoisted(() => ({
  pinnedFetch: vi.fn(),
  createPinnedFetch: vi.fn(),
}));

vi.mock("../server-connections-backend.js", async () => {
  const actual = await vi.importActual<
    typeof import("../server-connections-backend.js")
  >("../server-connections-backend.js");
  return { ...actual, ...backend };
});

vi.mock("../server-connection-discovery.js", () => discovery);

vi.mock("@mcpjam/sdk", () => probe);

vi.mock("../../utils/pinned-fetch.js", () => ({
  createPinnedFetch: transport.createPinnedFetch,
}));

const { runConnectionJob } = await import("../server-connection-worker.js");
const { ServerConnectionBackendError } = await import(
  "../server-connections-backend.js"
);

function leased(status: string, extra: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    leased: true,
    status,
    serverUrl: "https://example.com/mcp",
    ...extra,
  };
}

/**
 * Build a probe result the SDK could ACTUALLY return.
 *
 * The suite this replaced asserted on `status: "ok"` and `status: "unauthorized"`
 * — neither of which `probeMcpServer` can produce — and passed anyway, which is
 * exactly how a worker that could never reach `ready` shipped green. Typing the
 * fixtures as `ProbeMcpServerResult` means a test can no longer describe a
 * contract that does not exist: the union is `"ready" | "oauth_required" |
 * "reachable" | "error"`, and a fixture outside it fails typecheck.
 *
 * The type import survives `vi.mock("@mcpjam/sdk")` because types are erased
 * before the mock ever exists.
 */
function probeResult(
  overrides: Partial<ProbeMcpServerResult> &
    Pick<ProbeMcpServerResult, "status">
): ProbeMcpServerResult {
  return {
    url: "https://example.com/mcp",
    protocolVersion: "2025-06-18",
    transport: { attempts: [] },
    oauth: { required: false, optional: false, registrationStrategies: [] },
    ...overrides,
  };
}

function attempt(
  name: ProbeHttpAttempt["name"],
  status: number
): ProbeHttpAttempt {
  return {
    name,
    request: { method: "POST", url: "https://example.com/mcp", headers: {} },
    response: { status, statusText: "", headers: {} },
    durationMs: 1,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  backend.releaseLease.mockResolvedValue(undefined);
  backend.reportDiscovery.mockResolvedValue({ status: "validating" });
  backend.reportValidation.mockResolvedValue({ status: "ready" });
  transport.pinnedFetch.mockResolvedValue(new Response("{}"));
  transport.createPinnedFetch.mockReturnValue(transport.pinnedFetch);
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

  it("swallows a lost race instead of throwing at a route that already answered", async () => {
    backend.acquireLease.mockResolvedValue(leased("discovering"));
    // The row moved underneath us, or someone else owns it now. Both are normal
    // races. The caller is an HTTP route that has already sent its 202, so a
    // throw here lands in a log with nobody to read it.
    discovery.runDiscoveryPreflight.mockRejectedValue(
      new ServerConnectionBackendError("someone else has the lease", 409)
    );

    const result = await runConnectionJob("scr_x");

    expect(result).toEqual({
      requestId: "scr_x",
      ran: false,
      skipped: "not-leased",
    });
    // Released before giving up: whichever report would have released it never
    // ran, so holding the lease would strand the request until it lapsed.
    expect(backend.releaseLease).toHaveBeenCalledWith("scr_x", expect.any(String));
  });

  it("treats a request that is gone the same way", async () => {
    backend.acquireLease.mockResolvedValue(leased("validating"));
    backend.fetchValidationContext.mockRejectedValue(
      new ServerConnectionBackendError("not found", 404)
    );

    const result = await runConnectionJob("scr_x");

    expect(result.skipped).toBe("not-leased");
    expect(backend.releaseLease).toHaveBeenCalled();
  });

  it("releases the lease when reporting the discovery outcome fails", async () => {
    backend.acquireLease.mockResolvedValue(leased("discovering"));
    discovery.runDiscoveryPreflight.mockResolvedValue({
      kind: "retryable",
      detail: "dns hiccup",
    });
    // `reportValidation` is only legal from `validating`; a request still in
    // `discovering` cannot take it. Without the release the lease would be held
    // until it lapsed, delaying the retry the cron exists to schedule.
    backend.reportValidation.mockRejectedValue(
      new ServerConnectionBackendError("invalid state", 409)
    );

    await runConnectionJob("scr_x");

    expect(backend.releaseLease).toHaveBeenCalledWith("scr_x", expect.any(String));
  });

  it("does not blame the target for a lease with no server URL", async () => {
    backend.acquireLease.mockResolvedValue(
      leased("discovering", { serverUrl: undefined })
    );

    const result = await runConnectionJob("scr_x");

    // Passing `""` into the guard made it throw, which reported
    // `authMethod: "unsupported"` — permanently telling someone their URL was
    // refused when the backend had handed us a row with nothing in it. There is
    // no legal report from `discovering`, so releasing the lease and letting the
    // cron come back is the whole remedy.
    expect(discovery.runDiscoveryPreflight).not.toHaveBeenCalled();
    expect(backend.reportDiscovery).not.toHaveBeenCalled();
    expect(backend.reportValidation).not.toHaveBeenCalled();
    expect(backend.releaseLease).toHaveBeenCalledWith("scr_x", expect.any(String));
    expect(result.skipped).toBe("not-actionable");
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
    probe.probeMcpServer.mockResolvedValue(
      probeResult({
        status: "ready",
        transport: {
          selected: "streamable-http",
          attempts: [attempt("streamable_initialize", 200)],
        },
        initialize: { protocolVersion: "2025-06-18" },
      })
    );

    await runConnectionJob("scr_x");

    expect(backend.reportValidation).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "ready" })
    );
    // The credential must reach the probe, and only the probe.
    expect(probe.probeMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "secret-token" })
    );
  });

  it("reports ready for an SSE server, which carries no protocol version", async () => {
    backend.fetchValidationContext.mockResolvedValue({
      serverUrl: "https://example.com/mcp",
      accessToken: null,
      authMethod: "none",
    });
    // The SDK's SSE arm reports only a content type. Requiring
    // `initialize.protocolVersion` on top of `status: "ready"` would mark every
    // working SSE server terminally non-MCP.
    probe.probeMcpServer.mockResolvedValue(
      probeResult({
        status: "ready",
        transport: {
          selected: "sse",
          attempts: [
            attempt("streamable_initialize", 405),
            attempt("sse_probe", 200),
          ],
        },
        initialize: { contentType: "text/event-stream" },
      })
    );

    await runConnectionJob("scr_x");

    expect(backend.reportValidation).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "ready" })
    );
  });

  it("validates an unauthenticated target with no credential at all", async () => {
    backend.fetchValidationContext.mockResolvedValue({
      serverUrl: "https://example.com/mcp",
      accessToken: null,
      authMethod: "none",
    });
    probe.probeMcpServer.mockResolvedValue(
      probeResult({
        status: "ready",
        initialize: { protocolVersion: "2025-06-18" },
      })
    );

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
      credentialRetryable: false,
    });

    await runConnectionJob("scr_x");

    expect(backend.reportValidation).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "authentication-failed" })
    );
    // Nothing was probed — there was nothing to probe with.
    expect(probe.probeMcpServer).not.toHaveBeenCalled();
  });

  it("retries, rather than re-consenting, when the authorization server was unreachable", async () => {
    backend.fetchValidationContext.mockResolvedValue({
      serverUrl: "https://example.com/mcp",
      accessToken: null,
      authMethod: "oauth",
      credentialRetryable: true,
    });

    await runConnectionJob("scr_x");

    // `authentication-failed` here moves the request to
    // `awaiting_authorization` and burns one of three OAuth attempts. The
    // credential is intact and consent cannot reach a server that is down, so
    // a few minutes of tenant downtime would fail the request for good.
    expect(backend.reportValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "retryable",
        errorCode: "VALIDATION_FAILED",
      })
    );
    expect(probe.probeMcpServer).not.toHaveBeenCalled();
  });

  it("treats an OAuth challenge at validation time as an auth failure, not a retry", async () => {
    backend.fetchValidationContext.mockResolvedValue({
      serverUrl: "https://example.com/mcp",
      accessToken: "stale-token",
      authMethod: "oauth",
    });
    // A 401 with a challenge is what the probe calls `oauth_required`. We sent
    // the stored credential, so this is the server rejecting it.
    probe.probeMcpServer.mockResolvedValue(
      probeResult({
        status: "oauth_required",
        transport: { attempts: [attempt("streamable_initialize", 401)] },
        oauth: { required: true, optional: false, registrationStrategies: [] },
      })
    );

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

  it("does not send the user to consent over a 403 when nothing was sent", async () => {
    backend.fetchValidationContext.mockResolvedValue({
      serverUrl: "https://example.com/mcp",
      accessToken: null,
      authMethod: "none",
    });
    // A 403 is evidence a STORED GRANT was rejected only if a stored grant was
    // sent. `authentication-failed` would move this request to
    // `awaiting_authorization` — a state whose next step cannot be performed,
    // because discovery found no authorization server to send anyone to.
    probe.probeMcpServer.mockResolvedValue(
      probeResult({
        status: "reachable",
        transport: { attempts: [attempt("streamable_initialize", 403)] },
        error: "Server responded with HTTP 403 Forbidden to the initialize probe.",
      })
    );

    await runConnectionJob("scr_x");

    expect(backend.reportValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "terminal",
        errorCode: "UNSUPPORTED_AUTH_METHOD",
      })
    );
  });

  it("treats a 403 on a reachable target as a rejected credential", async () => {
    backend.fetchValidationContext.mockResolvedValue({
      serverUrl: "https://example.com/mcp",
      accessToken: "stale-token",
      authMethod: "oauth",
    });
    // A 403 never becomes `oauth_required` — the probe only promotes 401 — so
    // it arrives as `reachable`, whose name is about the socket and not the
    // protocol. Reporting it terminally would tell the user their working
    // server is not an MCP server when the real fix is re-consent.
    probe.probeMcpServer.mockResolvedValue(
      probeResult({
        status: "reachable",
        transport: { attempts: [attempt("streamable_initialize", 403)] },
        error: "Server responded with HTTP 403 Forbidden to the initialize probe.",
      })
    );

    await runConnectionJob("scr_x");

    expect(backend.reportValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "authentication-failed",
        errorCode: "AUTHENTICATION_FAILED",
      })
    );
  });

  it("is terminal for a reachable endpoint whose answer is not MCP", async () => {
    backend.fetchValidationContext.mockResolvedValue({
      serverUrl: "https://example.com/mcp",
      accessToken: null,
      authMethod: "none",
    });
    probe.probeMcpServer.mockResolvedValue(
      probeResult({
        status: "reachable",
        transport: { attempts: [attempt("streamable_initialize", 200)] },
        error:
          "Server responded to initialize but did not return a recognizable MCP initialize result.",
      })
    );

    await runConnectionJob("scr_x");

    expect(backend.reportValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "terminal",
        errorCode: "PROTOCOL_VALIDATION_FAILED",
      })
    );
  });

  it("does not revoke the grant over a 403 from a metadata endpoint", async () => {
    backend.fetchValidationContext.mockResolvedValue({
      serverUrl: "https://example.com/mcp",
      accessToken: "good-token",
      authMethod: "oauth",
    });
    // `resource_metadata` routinely lives on a DIFFERENT host. A 403 from it is
    // someone else's misconfiguration, and treating it as our credential being
    // rejected would throw away a grant that works.
    probe.probeMcpServer.mockResolvedValue(
      probeResult({
        status: "reachable",
        transport: {
          attempts: [
            attempt("streamable_initialize", 200),
            attempt("resource_metadata", 403),
          ],
        },
        error:
          "Server responded to initialize but did not return a recognizable MCP initialize result.",
      })
    );

    await runConnectionJob("scr_x");

    expect(backend.reportValidation).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "terminal" })
    );
  });

  it("is terminal for an endpoint that answers but is not MCP", async () => {
    backend.fetchValidationContext.mockResolvedValue({
      serverUrl: "https://example.com/mcp",
      accessToken: null,
      authMethod: "none",
    });
    probe.probeMcpServer.mockResolvedValue(
      probeResult({
        status: "error",
        error: "Response is not a valid JSON-RPC message",
      })
    );

    await runConnectionJob("scr_x");

    expect(backend.reportValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "terminal",
        errorCode: "PROTOCOL_VALIDATION_FAILED",
      })
    );
  });

  it("does not read an auth failure out of incidental '401' text", async () => {
    backend.fetchValidationContext.mockResolvedValue({
      serverUrl: "https://example.com/mcp",
      accessToken: "good-token",
      authMethod: "oauth",
    });
    // `probe.error` is prose assembled for a human and can carry a status from
    // somewhere else entirely. The code the target actually sent is 503, so the
    // right answer is "come back later", not "your grant is dead".
    probe.probeMcpServer.mockResolvedValue(
      probeResult({
        status: "error",
        transport: { attempts: [attempt("streamable_initialize", 503)] },
        error:
          "Upstream gateway is unavailable; it last returned 401 from https://auth.example/token",
      })
    );

    await runConnectionJob("scr_x");

    expect(backend.reportValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "retryable",
        errorCode: "VALIDATION_FAILED",
      })
    );
  });

  it("still reads a transport-level auth failure out of the message when nothing answered", async () => {
    backend.fetchValidationContext.mockResolvedValue({
      serverUrl: "https://example.com/mcp",
      accessToken: "stale-token",
      authMethod: "oauth",
    });
    // No attempt carries a response, so the message is the only evidence there
    // is and the regex is allowed to speak.
    probe.probeMcpServer.mockResolvedValue(
      probeResult({
        status: "error",
        error: "Request failed: 401 Unauthorized",
      })
    );

    await runConnectionJob("scr_x");

    expect(backend.reportValidation).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "authentication-failed" })
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

  it("keeps a refused target terminal instead of retrying it", async () => {
    backend.fetchValidationContext.mockResolvedValue({
      serverUrl: "https://rebinding.example/mcp",
      accessToken: "secret-token",
      authMethod: "oauth",
    });
    // The pinned transport refuses a private or reserved address by throwing
    // this. Discovery already treats it as terminal; classifying it as
    // `retryable` here would put an SSRF attempt back on a retry schedule from
    // the validation side, which is the same hole closed on the discovery side.
    probe.probeMcpServer.mockRejectedValue(
      new BlockedEgressTargetError(
        'Refusing to connect to "rebinding.example": it is not a publicly routable address.'
      )
    );

    await runConnectionJob("scr_x");

    expect(backend.reportValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "terminal",
        errorCode: "URL_NOT_ALLOWED",
      })
    );
  });

  it("records a refusal the probe swallowed", async () => {
    backend.fetchValidationContext.mockResolvedValue({
      serverUrl: "https://rebinding.example/mcp",
      accessToken: "secret-token",
      authMethod: "oauth",
    });
    // THE ORDINARY CASE, and the one that matters: `probeMcpServer` catches
    // whatever `fetchFn` throws and reports `status: "error"`, so the refusal
    // never reaches a catch here. Reading the probe's own account would call it
    // retryable and put an SSRF attempt back on a schedule with a live
    // credential attached.
    transport.pinnedFetch.mockRejectedValue(
      new BlockedEgressTargetError(
        'Refusing to connect to "rebinding.example": it is not a publicly routable address.'
      )
    );
    probe.probeMcpServer.mockImplementation(async (config: never) => {
      const { fetchFn } = config as unknown as { fetchFn: typeof fetch };
      await fetchFn("https://rebinding.example/mcp").catch(() => {});
      return probeResult({ status: "error", error: "fetch failed" });
    });

    await runConnectionJob("scr_x");

    expect(backend.reportValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "terminal",
        errorCode: "URL_NOT_ALLOWED",
      })
    );
  });

  it("keeps a resolver outage retryable", async () => {
    backend.fetchValidationContext.mockResolvedValue({
      serverUrl: "https://example.com/mcp",
      accessToken: "secret-token",
      authMethod: "oauth",
    });
    // The opposite verdict to the one above, and the reason the two error
    // classes exist separately: DNS failing is ours, not the user's.
    probe.probeMcpServer.mockRejectedValue(
      new EgressResolutionError("Could not resolve oauth target example.com")
    );

    await runConnectionJob("scr_x");

    expect(backend.reportValidation).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "retryable",
        errorCode: "VALIDATION_FAILED",
      })
    );
  });

  it("gives up on a probe that never returns, rather than holding the lease", async () => {
    vi.useFakeTimers();
    try {
      backend.fetchValidationContext.mockResolvedValue({
        serverUrl: "https://stalls.example/mcp",
        accessToken: "secret-token",
        authMethod: "oauth",
      });
      // `timeoutMs` bounds ONE request and the probe makes several, so a target
      // that stalls each in turn would hold this request's work lease for the
      // sum of them.
      probe.probeMcpServer.mockReturnValue(new Promise(() => {}));

      const job = runConnectionJob("scr_x");
      await vi.advanceTimersByTimeAsync(60_000);
      await job;

      expect(backend.reportValidation).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: "retryable",
          errorCode: "VALIDATION_FAILED",
        })
      );
    } finally {
      vi.useRealTimers();
    }
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
