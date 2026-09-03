/**
 * Discovery preflight for a connection request.
 *
 * The classification table is the contract worth pinning: each arm decides
 * whether a person gets sent to a consent screen, whether the request survives
 * a bad minute, or whether it dies. The two that are easy to get backwards are
 * asserted explicitly — a network failure must never be reported as a
 * discovery result, and a server that answers with non-MCP must never be
 * retried.
 *
 * The SSRF cases carry their weight here: a URL that passes the pure hostname
 * classifier and only turns private once DNS answers, and a target that turns
 * private only on a redirect. Both defeat a guard that inspects the first URL
 * and stops, so both are asserted to come back TERMINAL rather than retryable —
 * an SSRF attempt on a retry schedule is worse than one refused outright.
 *
 * The prober and the guarded fetch are both injected, so these tests never open
 * a socket, never resolve a name, and never depend on the SDK's internal probe
 * layering.
 */
import { describe, expect, it, vi } from "vitest";
import type { ProbeMcpServerResult } from "@mcpjam/sdk";
import {
  BlockedEgressTargetError,
  createGuardedFetch,
  EgressResolutionError,
} from "../../utils/hosted-egress-guard.js";
import {
  classifyDiscoveryResult,
  DISCOVERY_TIMEOUT_MS,
  MAX_DISCOVERY_TIMEOUT_MS,
  runDiscoveryPreflight,
} from "../server-connection-discovery.js";

function probe(overrides: Partial<ProbeMcpServerResult>): ProbeMcpServerResult {
  return {
    url: "https://example.com/mcp",
    protocolVersion: "2025-11-25",
    status: "ready",
    transport: { attempts: [] },
    oauth: {
      required: false,
      optional: false,
      registrationStrategies: [],
    },
    ...overrides,
  } as ProbeMcpServerResult;
}

/** A prober that reports whatever `fetchFn` threw as `status: "error"` —
 *  the real `probeMcpServer`'s behaviour, and the reason an egress refusal has
 *  to be recovered rather than read off the probe result. */
function probeThroughFetch(): typeof import("@mcpjam/sdk").probeMcpServer {
  return (async (config: { url: string; fetchFn?: typeof fetch }) => {
    try {
      await config.fetchFn?.(config.url, { method: "POST" });
    } catch (error) {
      return probe({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return probe({ status: "ready" });
  }) as unknown as typeof import("@mcpjam/sdk").probeMcpServer;
}

describe("classifyDiscoveryResult", () => {
  it("reports authMethod none when initialize succeeds unauthenticated", () => {
    const outcome = classifyDiscoveryResult(probe({ status: "ready" }));

    expect(outcome).toMatchObject({ kind: "discovered", authMethod: "none" });
  });

  it("reports authMethod oauth for a challenge naming an authorization server", () => {
    const outcome = classifyDiscoveryResult(
      probe({
        status: "oauth_required",
        oauth: {
          required: true,
          optional: false,
          wwwAuthenticate:
            'Bearer resource_metadata="https://example.com/.well-known"',
          authorizationServerMetadataUrl:
            "https://auth.example.com/.well-known/oauth-authorization-server",
          registrationStrategies: ["dcr"],
        },
      }),
    );

    expect(outcome).toMatchObject({ kind: "discovered", authMethod: "oauth" });
  });

  it("reports unsupported when strategies resolved but no authorization server did", () => {
    // A strategy list is NOT a substitute for an authorization server: the
    // prober fills it in with a default on the discovery-failed path, so
    // trusting it routes a server with nowhere to send anyone into consent.
    const outcome = classifyDiscoveryResult(
      probe({
        status: "oauth_required",
        oauth: {
          required: true,
          optional: false,
          registrationStrategies: ["preregistered"],
        },
      }),
    );

    expect(outcome).toMatchObject({
      kind: "discovered",
      authMethod: "unsupported",
    });
  });

  it("accepts metadata with no challenge header at all", () => {
    // Some servers 401 with no WWW-Authenticate while still publishing usable
    // metadata; the scheme check must not turn that into `unsupported`.
    const outcome = classifyDiscoveryResult(
      probe({
        status: "oauth_required",
        oauth: {
          required: true,
          optional: false,
          authorizationServerMetadataUrl:
            "https://auth.example.com/.well-known/oauth-authorization-server",
          registrationStrategies: ["dcr"],
        },
      }),
    );

    expect(outcome).toMatchObject({ kind: "discovered", authMethod: "oauth" });
  });

  it("accepts metadata with a blank challenge header", () => {
    const outcome = classifyDiscoveryResult(
      probe({
        status: "oauth_required",
        oauth: {
          required: true,
          optional: false,
          wwwAuthenticate: "   ",
          authorizationServerMetadataUrl:
            "https://auth.example.com/.well-known/oauth-authorization-server",
          registrationStrategies: ["dcr"],
        },
      }),
    );

    expect(outcome).toMatchObject({ kind: "discovered", authMethod: "oauth" });
  });

  it("reports unsupported for a non-Bearer challenge", () => {
    // Basic names no authorization server because the scheme has no concept
    // of one, so nothing is discovered and there is no flow to run.
    const outcome = classifyDiscoveryResult(
      probe({
        status: "oauth_required",
        oauth: {
          required: true,
          optional: false,
          wwwAuthenticate: 'Basic realm="mcp"',
          registrationStrategies: [],
        },
      }),
    );

    expect(outcome).toMatchObject({
      kind: "discovered",
      authMethod: "unsupported",
    });
  });

  it("reports unsupported for a manual bearer server", () => {
    // THE SHAPE THE PROBER ACTUALLY RETURNS, and a regression test for a real
    // bug. When metadata discovery throws — which is exactly what happens for a
    // manual-bearer server — `server-probe.ts` returns
    // `registrationStrategies: ["preregistered"]` with NO
    // `authorizationServerMetadataUrl`. An earlier revision treated a non-empty
    // strategy list as sufficient, so this case classified as `oauth` and the
    // `unsupported` branch was unreachable. The fixture deliberately carries
    // the non-empty list to keep that from coming back.
    const outcome = classifyDiscoveryResult(
      probe({
        status: "oauth_required",
        oauth: {
          required: true,
          optional: false,
          wwwAuthenticate: "Bearer",
          registrationStrategies: ["preregistered"],
          discoveryError: "No authorization server metadata found",
        },
      }),
    );

    expect(outcome).toMatchObject({
      kind: "discovered",
      authMethod: "unsupported",
    });
  });

  it("reports unsupported for a non-Bearer challenge that still resolved metadata", () => {
    // Basic has no authorization-code flow to run even if something
    // OAuth-shaped sits at the well-known URL, so the scheme decides.
    const outcome = classifyDiscoveryResult(
      probe({
        status: "oauth_required",
        oauth: {
          required: true,
          optional: false,
          wwwAuthenticate: 'Basic realm="mcp"',
          authorizationServerMetadataUrl:
            "https://auth.example.com/.well-known/oauth-authorization-server",
          registrationStrategies: ["dcr"],
        },
      }),
    );

    expect(outcome).toMatchObject({
      kind: "discovered",
      authMethod: "unsupported",
    });
  });

  it("accepts Bearer offered alongside another scheme", () => {
    const outcome = classifyDiscoveryResult(
      probe({
        status: "oauth_required",
        oauth: {
          required: true,
          optional: false,
          wwwAuthenticate:
            'Basic realm="mcp", Bearer resource_metadata="https://example.com/.well-known"',
          authorizationServerMetadataUrl:
            "https://auth.example.com/.well-known/oauth-authorization-server",
          registrationStrategies: ["dcr"],
        },
      }),
    );

    expect(outcome).toMatchObject({ kind: "discovered", authMethod: "oauth" });
  });

  it("treats a non-MCP response as terminal, not retryable", () => {
    // The host answered; the answer was not MCP. Retrying spends the request's
    // attempt budget to receive the same answer.
    const outcome = classifyDiscoveryResult(
      probe({
        status: "reachable",
        error: "Server returned HTML instead of an MCP initialize result",
      }),
    );

    expect(outcome.kind).toBe("terminal");
    expect(outcome).toMatchObject({ errorCode: "NOT_AN_MCP_SERVER" });
  });

  it("treats an unreachable server as retryable and reports no auth method", () => {
    // The distinction that matters most: a server that was down for a minute
    // must not be permanently labelled `unsupported`.
    const outcome = classifyDiscoveryResult(
      probe({ status: "error", error: "connect ETIMEDOUT" }),
    );

    expect(outcome.kind).toBe("retryable");
    expect(outcome).not.toHaveProperty("authMethod");
  });

  it("treats a probe that reached nothing as retryable", () => {
    const outcome = classifyDiscoveryResult(
      probe({ status: "error", error: "socket hang up" }),
    );

    expect(outcome.kind).toBe("retryable");
  });
});

describe("runDiscoveryPreflight", () => {
  const ready = () =>
    vi.fn().mockResolvedValue(probe({ status: "ready" })) as unknown as never;

  it("refuses a literal private target before any request is made", async () => {
    const probeServer = vi.fn();

    const outcome = await runDiscoveryPreflight(
      { serverUrl: "http://169.254.169.254/latest/meta-data/" },
      { probeServer: probeServer as never },
    );

    expect(outcome).toMatchObject({
      kind: "terminal",
      errorCode: "URL_NOT_ALLOWED",
    });
    // The point of a preflight classifier is that no socket is opened at all.
    expect(probeServer).not.toHaveBeenCalled();
  });

  it("refuses loopback unless the local-dev opt-in is set", async () => {
    const probeServer = vi.fn();

    // `allowPrivateNetwork: false` is what a HOSTED deployment resolves to;
    // it is spelled out because the default now follows `!HOSTED_MODE`, and
    // this test is about the hosted policy rather than the local one.
    const blocked = await runDiscoveryPreflight(
      { serverUrl: "http://127.0.0.1:3000/mcp", allowPrivateNetwork: false },
      { probeServer: probeServer as never },
    );

    expect(blocked).toMatchObject({
      kind: "terminal",
      errorCode: "URL_NOT_ALLOWED",
    });
    expect(probeServer).not.toHaveBeenCalled();
  });

  it("allows loopback when the opt-in is set", async () => {
    const probeServer = ready();

    const outcome = await runDiscoveryPreflight(
      { serverUrl: "http://127.0.0.1:3000/mcp", allowLoopback: true },
      { probeServer },
    );

    expect(outcome).toMatchObject({ kind: "discovered", authMethod: "none" });
    expect(probeServer).toHaveBeenCalledTimes(1);
  });

  it("keeps the loopback opt-in from relaxing anything else", async () => {
    const probeServer = vi.fn();

    // A LAN address is not loopback. The opt-in exists for local development
    // against 127.0.0.1, not as a general private-network escape hatch.
    const outcome = await runDiscoveryPreflight(
      {
        serverUrl: "http://192.168.1.10/mcp",
        allowLoopback: true,
        allowPrivateNetwork: false,
      },
      { probeServer: probeServer as never },
    );

    expect(outcome).toMatchObject({
      kind: "terminal",
      errorCode: "URL_NOT_ALLOWED",
    });
    expect(probeServer).not.toHaveBeenCalled();
  });

  it("probes a loopback server by default, the way a local inspector does", async () => {
    // The local default. Testing a server on the developer's own machine is
    // the inspector's whole job, so the preflight must not stand in its way.
    const probeServer = ready();

    const outcome = await runDiscoveryPreflight(
      { serverUrl: "http://127.0.0.1:3000/mcp" },
      { probeServer },
    );

    expect(outcome).toMatchObject({ kind: "discovered", authMethod: "none" });
    expect(probeServer).toHaveBeenCalledTimes(1);
  });

  it("probes a LAN server by default too", async () => {
    const probeServer = ready();

    const outcome = await runDiscoveryPreflight(
      { serverUrl: "http://192.168.1.10/mcp" },
      { probeServer },
    );

    expect(outcome).toMatchObject({ kind: "discovered", authMethod: "none" });
    expect(probeServer).toHaveBeenCalledTimes(1);
  });

  it("refuses cloud metadata even by default", async () => {
    // The floor under the local allowance: no opt-in reaches it, and the
    // probe must never run.
    const probeServer = vi.fn();

    const outcome = await runDiscoveryPreflight(
      { serverUrl: "http://169.254.169.254/latest/meta-data/" },
      { probeServer: probeServer as never },
    );

    expect(outcome).toMatchObject({
      kind: "terminal",
      errorCode: "URL_NOT_ALLOWED",
    });
    expect(probeServer).not.toHaveBeenCalled();
  });

  it("rejects a non-http scheme", async () => {
    const probeServer = vi.fn();

    const outcome = await runDiscoveryPreflight(
      { serverUrl: "file:///etc/passwd" },
      { probeServer: probeServer as never },
    );

    expect(outcome).toMatchObject({
      kind: "terminal",
      errorCode: "URL_NOT_ALLOWED",
    });
    expect(probeServer).not.toHaveBeenCalled();
  });

  it("refuses a plaintext probe to a public host", async () => {
    const probeServer = vi.fn();

    // The RFC 6890 classifier judges addresses, not transport, and accepts
    // http:. Hosted targets are HTTPS-only, so this has to be enforced here.
    const outcome = await runDiscoveryPreflight(
      { serverUrl: "http://example.com/mcp" },
      { probeServer: probeServer as never },
    );

    expect(outcome).toMatchObject({
      kind: "terminal",
      errorCode: "URL_NOT_ALLOWED",
    });
    expect(probeServer).not.toHaveBeenCalled();
  });

  it("still allows plaintext loopback under the opt-in", async () => {
    // `http://127.0.0.1:3000/mcp` IS the local-development product; the
    // HTTPS rule must not take that away.
    const probeServer = ready();

    const outcome = await runDiscoveryPreflight(
      { serverUrl: "http://127.0.0.1:3000/mcp", allowLoopback: true },
      { probeServer },
    );

    expect(outcome).toMatchObject({ kind: "discovered", authMethod: "none" });
  });

  it("caps a caller-supplied timeout", async () => {
    const probeServer = ready();

    await runDiscoveryPreflight(
      { serverUrl: "https://example.com/mcp", timeoutMs: 10 * 60_000 },
      { probeServer },
    );

    // timeoutMs bounds ONE request and the probe makes several, so an uncapped
    // value multiplies into the wall time one preflight can occupy a worker.
    const config = (probeServer as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][0] as { timeoutMs: number };
    expect(config.timeoutMs).toBe(MAX_DISCOVERY_TIMEOUT_MS);
  });

  it("falls back to the default for a nonsense timeout", async () => {
    const probeServer = ready();

    await runDiscoveryPreflight(
      { serverUrl: "https://example.com/mcp", timeoutMs: Number.NaN },
      { probeServer },
    );

    const config = (probeServer as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][0] as { timeoutMs: number };
    expect(config.timeoutMs).toBe(DISCOVERY_TIMEOUT_MS);
  });

  it("rejects an empty URL without probing", async () => {
    const probeServer = vi.fn();

    const outcome = await runDiscoveryPreflight(
      { serverUrl: "" },
      { probeServer: probeServer as never },
    );

    expect(outcome).toMatchObject({
      kind: "terminal",
      errorCode: "URL_NOT_ALLOWED",
    });
    expect(probeServer).not.toHaveBeenCalled();
  });

  it("rejects a null URL that slipped past the type system", async () => {
    const probeServer = vi.fn();

    // The caller is an HTTP route parsing an untrusted body, so `serverUrl`
    // being absent at runtime is a real shape, not a hypothetical.
    const outcome = await runDiscoveryPreflight(
      { serverUrl: null as unknown as string },
      { probeServer: probeServer as never },
    );

    expect(outcome).toMatchObject({
      kind: "terminal",
      errorCode: "URL_NOT_ALLOWED",
    });
    expect(probeServer).not.toHaveBeenCalled();
  });

  it("attaches no credential to the probe", async () => {
    const probeServer = ready();

    await runDiscoveryPreflight(
      { serverUrl: "https://example.com/mcp" },
      {
        probeServer,
      },
    );

    // Discovery asks what a stranger sees. A token here would classify a
    // server as open when it is not.
    const config = (probeServer as unknown as { mock: { calls: unknown[][] } })
      .mock.calls[0][0] as Record<string, unknown>;
    expect(config).not.toHaveProperty("accessToken");
    expect(config).not.toHaveProperty("headers");
    expect(config.fetchFn).toBeTypeOf("function");
  });

  it("refuses a public hostname whose DNS answer is private", async () => {
    // Driven through the REAL guard, not a mock that throws on cue: the point
    // is that `evil.example` passes the pure hostname classifier — nothing
    // about the STRING is private — and is caught only once resolved.
    const baseFetch = vi.fn();
    const outcome = await runDiscoveryPreflight(
      { serverUrl: "https://evil.example/mcp" },
      {
        probeServer: probeThroughFetch(),
        fetchFn: createGuardedFetch({
          hosted: true,
          resolver: async (hostname) =>
            hostname === "evil.example"
              ? ["169.254.169.254"]
              : ["93.184.216.34"],
          baseFetch: baseFetch as unknown as typeof fetch,
        }),
      },
    );

    // TERMINAL, not retryable: the prober swallows the throw and calls it
    // `status: "error"`, and letting that stand would put an SSRF attempt on
    // a retry schedule.
    expect(outcome).toMatchObject({
      kind: "terminal",
      errorCode: "URL_NOT_ALLOWED",
    });
    // Nothing was dialled at all — the refusal happened before any socket.
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it("refuses a target that only turns private on a redirect", async () => {
    // A caller need not name the address they want reached: they can name a
    // host they control and have it answer 302 Location: 169.254.169.254.
    // This drives the guard's PER-HOP re-check, which is a different code path
    // from the DNS case above — the first hop is legitimately public.
    const baseFetch = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        }),
    );

    const outcome = await runDiscoveryPreflight(
      { serverUrl: "https://redirector.example/mcp" },
      {
        probeServer: probeThroughFetch(),
        fetchFn: createGuardedFetch({
          hosted: true,
          resolver: async () => ["93.184.216.34"],
          baseFetch: baseFetch as unknown as typeof fetch,
        }),
      },
    );

    expect(outcome).toMatchObject({
      kind: "terminal",
      errorCode: "URL_NOT_ALLOWED",
    });
    // Exactly one request: the public first hop was dialled, the private
    // redirect target never was. A guard that only checked the first URL would
    // show two calls here.
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it("follows a redirect that stays public", async () => {
    // The redirect check must refuse private hops without refusing redirects
    // as such, or every legitimately-redirecting server becomes unreachable.
    const baseFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example/mcp" },
        }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const outcome = await runDiscoveryPreflight(
      { serverUrl: "https://redirector.example/mcp" },
      {
        probeServer: probeThroughFetch(),
        fetchFn: createGuardedFetch({
          hosted: true,
          resolver: async () => ["93.184.216.34"],
          baseFetch: baseFetch as unknown as typeof fetch,
        }),
      },
    );

    expect(outcome).toMatchObject({ kind: "discovered", authMethod: "none" });
    expect(baseFetch).toHaveBeenCalledTimes(2);
  });

  it("keeps a recorded refusal from being masked by a later stall", async () => {
    // The sequence that makes this a security bug and not a nicety: the guard
    // refuses a hop, the prober SWALLOWS that throw and moves on to another
    // endpoint, and that endpoint hangs. The deadline then wins the race. If
    // the deadline branch answered `retryable` without consulting the recorded
    // refusal, the target we just refused would be put back on a retry
    // schedule.
    const outcome = await runDiscoveryPreflight(
      { serverUrl: "https://evil.example/mcp", timeoutMs: 5 },
      {
        deadlineMs: 25,
        fetchFn: async () => {
          throw new BlockedEgressTargetError(
            'Request URL hostname "evil.example" resolves to 169.254.169.254',
          );
        },
        probeServer: (async (config: {
          url: string;
          fetchFn?: typeof fetch;
        }) => {
          // Refused hop, swallowed exactly as the real prober does...
          await config
            .fetchFn?.(config.url, { method: "POST" })
            .catch(() => {});
          // ...then a stall long enough for the deadline to win.
          await new Promise(() => {});
          return probe({});
        }) as never,
      },
    );

    expect(outcome).toMatchObject({
      kind: "terminal",
      errorCode: "URL_NOT_ALLOWED",
    });
  });

  it("keeps a recorded refusal from being masked by an unexpected throw", async () => {
    const outcome = await runDiscoveryPreflight(
      { serverUrl: "https://evil.example/mcp" },
      {
        fetchFn: async () => {
          throw new BlockedEgressTargetError(
            'Request URL hostname "evil.example" resolves to 169.254.169.254',
          );
        },
        probeServer: (async (config: {
          url: string;
          fetchFn?: typeof fetch;
        }) => {
          await config
            .fetchFn?.(config.url, { method: "POST" })
            .catch(() => {});
          throw new Error("some later, unrelated failure");
        }) as never,
      },
    );

    expect(outcome).toMatchObject({
      kind: "terminal",
      errorCode: "URL_NOT_ALLOWED",
    });
  });

  it("treats a resolver outage as retryable, not as a refusal", async () => {
    // DNS blipping is our infrastructure trouble, not a verdict about the
    // user's server. Reporting it as URL_NOT_ALLOWED would permanently fail a
    // perfectly good request and tell the user their server is forbidden.
    const outcome = await runDiscoveryPreflight(
      { serverUrl: "https://example.com/mcp" },
      {
        probeServer: (async () => {
          throw new EgressResolutionError(
            'Could not check "example.com" for a safe address: SERVFAIL',
          );
        }) as never,
      },
    );

    expect(outcome.kind).toBe("retryable");
    expect(outcome).not.toHaveProperty("authMethod");
  });

  it("treats an unexpected prober rejection as retryable", async () => {
    const outcome = await runDiscoveryPreflight(
      { serverUrl: "https://example.com/mcp" },
      {
        probeServer: (async () => {
          throw new Error("boom");
        }) as never,
      },
    );

    // Nothing was learned about the target, so no discovery may be reported.
    expect(outcome).toMatchObject({ kind: "retryable", detail: "boom" });
    expect(outcome).not.toHaveProperty("authMethod");
  });
});
