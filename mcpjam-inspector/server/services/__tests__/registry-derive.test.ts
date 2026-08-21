/**
 * Deriving an org-registry entry from a pasted URL.
 *
 * Two things are worth pinning here and the rest follows from them.
 *
 * An EGRESS REFUSAL must never come back as "try again". The prober swallows
 * whatever `fetchFn` throws into `status: "error"`, which reads as a transient
 * failure — so a refusal recovered out of band has to outrank it, or an SSRF
 * attempt lands on a retry schedule with a friendly spinner. That ordering
 * lives in `probeThroughEgressGuard`; these tests assert this module keeps it.
 *
 * And `serverInfo` is arbitrary JSON from a stranger. Whatever it contains
 * ends up on a card every member of an organization sees, so a non-string name
 * is absent rather than "[object Object]", and a very long one is cut.
 *
 * The prober and the guarded fetch are injected: no socket, no DNS.
 */
import { describe, expect, it, vi } from "vitest";
import type { ProbeMcpServerResult } from "@mcpjam/sdk";
import { createGuardedFetch } from "../../utils/hosted-egress-guard.js";
import { deriveRegistryEntry } from "../registry-derive.js";

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

function probeReturning(
  result: ProbeMcpServerResult
): typeof import("@mcpjam/sdk").probeMcpServer {
  return (async () => result) as unknown as typeof import("@mcpjam/sdk").probeMcpServer;
}

/** The real `probeMcpServer`'s behaviour: it CATCHES what `fetchFn` throws and
 *  reports it as `status: "error"`. */
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

describe("deriveRegistryEntry", () => {
  it("reads name, version and title off an open server", async () => {
    const outcome = await deriveRegistryEntry(
      { url: "https://example.com/mcp" },
      {
        probeServer: probeReturning(
          probe({
            status: "ready",
            initialize: {
              serverInfo: {
                name: "example-mcp",
                version: "1.4.2",
                title: "Example",
              },
            },
          })
        ),
      }
    );

    expect(outcome).toEqual({
      kind: "derived",
      facts: {
        status: "ready",
        serverName: "example-mcp",
        serverVersion: "1.4.2",
        title: "Example",
        authRequired: false,
        registrationStrategies: [],
        endpointUrl: "https://example.com/mcp",
      },
    });
  });

  it("carries the auth posture off an OAuth challenge", async () => {
    const outcome = await deriveRegistryEntry(
      { url: "https://example.com/mcp" },
      {
        probeServer: probeReturning(
          probe({
            status: "oauth_required",
            oauth: {
              required: true,
              optional: false,
              registrationStrategies: ["dcr", "cimd"],
            },
          })
        ),
      }
    );

    expect(outcome).toMatchObject({
      kind: "derived",
      facts: {
        status: "oauth_required",
        authRequired: true,
        registrationStrategies: ["dcr", "cimd"],
      },
    });
  });

  it("reports the endpoint the probe actually reached, not the one pasted", async () => {
    const outcome = await deriveRegistryEntry(
      { url: "https://example.com/mcp" },
      {
        probeServer: probeReturning(
          probe({ url: "https://example.com/mcp/v1", status: "ready" })
        ),
      }
    );

    expect(outcome).toMatchObject({
      kind: "derived",
      facts: { endpointUrl: "https://example.com/mcp/v1" },
    });
  });

  it.each([
    ["a non-string name", { name: { evil: true }, version: "1.0.0" }],
    ["no serverInfo at all", undefined],
    ["a non-object serverInfo", "example"],
  ])("does not put %s on the card", async (_label, serverInfo) => {
    const outcome = await deriveRegistryEntry(
      { url: "https://example.com/mcp" },
      {
        probeServer: probeReturning(
          probe({ status: "ready", initialize: { serverInfo } })
        ),
      }
    );

    expect(outcome).toMatchObject({ kind: "derived" });
    if (outcome.kind !== "derived") throw new Error("unreachable");
    expect(outcome.facts.serverName).toBeUndefined();
  });

  it("bounds a server name long enough to be a denial of a card", async () => {
    const outcome = await deriveRegistryEntry(
      { url: "https://example.com/mcp" },
      {
        probeServer: probeReturning(
          probe({
            status: "ready",
            initialize: { serverInfo: { name: "x".repeat(5_000) } },
          })
        ),
      }
    );

    if (outcome.kind !== "derived") throw new Error("unreachable");
    expect(outcome.facts.serverName).toHaveLength(200);
  });

  it("refuses a literal private address before any socket exists", async () => {
    const probeServer = vi.fn();
    const outcome = await deriveRegistryEntry(
      { url: "http://169.254.169.254/mcp" },
      { probeServer: probeServer as never }
    );

    expect(outcome).toEqual({ kind: "refused" });
    expect(probeServer).not.toHaveBeenCalled();
  });

  it("refuses a plaintext probe to a public host", async () => {
    const outcome = await deriveRegistryEntry(
      { url: "http://example.com/mcp" },
      { probeServer: probeReturning(probe({ status: "ready" })) }
    );

    expect(outcome).toEqual({ kind: "refused" });
  });

  it("refuses — never 'unreachable' — a name that only turns private once DNS answers", async () => {
    const baseFetch = vi.fn();
    const outcome = await deriveRegistryEntry(
      { url: "https://evil.example/mcp" },
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
      }
    );

    // The prober turned the guard's throw into `status: "error"`. Reporting
    // that as retryable would put an SSRF attempt on a retry schedule.
    expect(outcome).toEqual({ kind: "refused" });
    expect(baseFetch).not.toHaveBeenCalled();
  });

  it("calls a server that answers with non-MCP terminal, not retryable", async () => {
    const outcome = await deriveRegistryEntry(
      { url: "https://example.com/mcp" },
      {
        probeServer: probeReturning(
          probe({ status: "reachable", error: "HTTP 200 text/html" })
        ),
      }
    );

    expect(outcome).toMatchObject({ kind: "not-mcp" });
  });

  it("calls a server that did not answer unreachable", async () => {
    const outcome = await deriveRegistryEntry(
      { url: "https://example.com/mcp" },
      {
        probeServer: probeReturning(
          probe({ status: "error", error: "ETIMEDOUT" })
        ),
      }
    );

    expect(outcome).toEqual({ kind: "unreachable", detail: "ETIMEDOUT" });
  });
});
