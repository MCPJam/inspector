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
 * The doctor is injected rather than stubbed at the module level, so these
 * tests never open a socket and never depend on the SDK's internal probe
 * layering.
 */
import { describe, expect, it, vi } from "vitest";
import type { ServerDoctorResult } from "@mcpjam/sdk";
import {
  classifyDiscoveryResult,
  runDiscoveryPreflight,
} from "../server-connection-discovery.js";

type Probe = NonNullable<ServerDoctorResult["probe"]>;

function probe(overrides: Partial<Probe>): Probe {
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
  } as Probe;
}

function doctorResult(
  overrides: Partial<ServerDoctorResult>,
): ServerDoctorResult {
  return {
    target: null,
    generatedAt: "2026-01-01T00:00:00.000Z",
    status: "ready",
    probe: probe({}),
    connection: { status: "ok", detail: "connected" },
    initInfo: null,
    capabilities: null,
    tools: [],
    toolsMetadata: {},
    resources: [],
    resourceTemplates: [],
    prompts: [],
    checks: {},
    error: null,
    ...overrides,
  } as ServerDoctorResult;
}

describe("classifyDiscoveryResult", () => {
  it("reports authMethod none when initialize succeeds unauthenticated", () => {
    const outcome = classifyDiscoveryResult(
      doctorResult({ probe: probe({ status: "ready" }) }),
    );

    expect(outcome).toMatchObject({ kind: "discovered", authMethod: "none" });
  });

  it("reports authMethod oauth for a challenge naming an authorization server", () => {
    const outcome = classifyDiscoveryResult(
      doctorResult({
        probe: probe({
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
      }),
    );

    expect(outcome).toMatchObject({ kind: "discovered", authMethod: "oauth" });
  });

  it("accepts a challenge that resolved registration strategies but no metadata URL", () => {
    // Either half is sufficient — a resolved strategy list means discovery got
    // far enough to know how a client would be identified.
    const outcome = classifyDiscoveryResult(
      doctorResult({
        probe: probe({
          status: "oauth_required",
          oauth: {
            required: true,
            optional: false,
            registrationStrategies: ["preregistered"],
          },
        }),
      }),
    );

    expect(outcome).toMatchObject({ kind: "discovered", authMethod: "oauth" });
  });

  it("reports unsupported for a non-Bearer challenge", () => {
    // Basic names no authorization server because the scheme has no concept
    // of one, so nothing is discovered and there is no flow to run.
    const outcome = classifyDiscoveryResult(
      doctorResult({
        probe: probe({
          status: "oauth_required",
          oauth: {
            required: true,
            optional: false,
            wwwAuthenticate: 'Basic realm="mcp"',
            registrationStrategies: [],
          },
        }),
      }),
    );

    expect(outcome).toMatchObject({
      kind: "discovered",
      authMethod: "unsupported",
    });
  });

  it("reports unsupported for a manual bearer server", () => {
    // Challenges with Bearer, publishes no authorization server metadata:
    // the token is meant to be pasted in by a human.
    const outcome = classifyDiscoveryResult(
      doctorResult({
        probe: probe({
          status: "oauth_required",
          oauth: {
            required: true,
            optional: false,
            wwwAuthenticate: "Bearer",
            registrationStrategies: [],
            discoveryError: "No authorization server metadata found",
          },
        }),
      }),
    );

    expect(outcome).toMatchObject({
      kind: "discovered",
      authMethod: "unsupported",
    });
  });

  it("treats a non-MCP response as terminal, not retryable", () => {
    // The host answered; the answer was not MCP. Retrying spends the request's
    // attempt budget to receive the same answer.
    const outcome = classifyDiscoveryResult(
      doctorResult({
        status: "error",
        probe: probe({
          status: "reachable",
          error: "Server returned HTML instead of an MCP initialize result",
        }),
      }),
    );

    expect(outcome.kind).toBe("terminal");
    expect(outcome).toMatchObject({ errorCode: "NOT_AN_MCP_SERVER" });
  });

  it("treats an unreachable server as retryable and reports no auth method", () => {
    // The distinction that matters most: a server that was down for a minute
    // must not be permanently labelled `unsupported`.
    const outcome = classifyDiscoveryResult(
      doctorResult({
        status: "error",
        probe: probe({ status: "error", error: "connect ETIMEDOUT" }),
      }),
    );

    expect(outcome.kind).toBe("retryable");
    expect(outcome).not.toHaveProperty("authMethod");
  });

  it("treats a doctor run that never probed as retryable", () => {
    const outcome = classifyDiscoveryResult(
      doctorResult({
        status: "error",
        probe: null,
        error: { code: "UNKNOWN", message: "socket hang up" },
      }),
    );

    expect(outcome.kind).toBe("retryable");
  });
});

describe("runDiscoveryPreflight", () => {
  it("refuses a private target before any request is made", async () => {
    const runDoctor = vi.fn();

    const outcome = await runDiscoveryPreflight(
      { serverUrl: "http://169.254.169.254/latest/meta-data/" },
      { runDoctor },
    );

    expect(outcome).toMatchObject({
      kind: "terminal",
      errorCode: "URL_NOT_ALLOWED",
    });
    // The point of a preflight guard is that no socket is opened at all.
    expect(runDoctor).not.toHaveBeenCalled();
  });

  it("refuses loopback unless the local-dev opt-in is set", async () => {
    const runDoctor = vi.fn();

    const blocked = await runDiscoveryPreflight(
      { serverUrl: "http://127.0.0.1:3000/mcp" },
      { runDoctor },
    );
    expect(blocked).toMatchObject({
      kind: "terminal",
      errorCode: "URL_NOT_ALLOWED",
    });
    expect(runDoctor).not.toHaveBeenCalled();
  });

  it("allows loopback when the opt-in is set", async () => {
    const runDoctor = vi
      .fn()
      .mockResolvedValue(doctorResult({ probe: probe({ status: "ready" }) }));

    const outcome = await runDiscoveryPreflight(
      { serverUrl: "http://127.0.0.1:3000/mcp", allowLoopback: true },
      { runDoctor },
    );

    expect(outcome).toMatchObject({ kind: "discovered", authMethod: "none" });
    expect(runDoctor).toHaveBeenCalledTimes(1);
  });

  it("keeps the loopback opt-in from relaxing anything else", async () => {
    const runDoctor = vi.fn();

    // A LAN address is not loopback. The opt-in exists for local development
    // against 127.0.0.1, not as a general private-network escape hatch.
    const outcome = await runDiscoveryPreflight(
      { serverUrl: "http://192.168.1.10/mcp", allowLoopback: true },
      { runDoctor },
    );

    expect(outcome).toMatchObject({
      kind: "terminal",
      errorCode: "URL_NOT_ALLOWED",
    });
    expect(runDoctor).not.toHaveBeenCalled();
  });

  it("rejects a non-http scheme", async () => {
    const runDoctor = vi.fn();

    const outcome = await runDiscoveryPreflight(
      { serverUrl: "file:///etc/passwd" },
      { runDoctor },
    );

    expect(outcome).toMatchObject({
      kind: "terminal",
      errorCode: "URL_NOT_ALLOWED",
    });
    expect(runDoctor).not.toHaveBeenCalled();
  });

  it("attaches no credential to the probe", async () => {
    const runDoctor = vi
      .fn()
      .mockResolvedValue(doctorResult({ probe: probe({ status: "ready" }) }));

    await runDiscoveryPreflight(
      { serverUrl: "https://example.com/mcp" },
      { runDoctor },
    );

    // Discovery asks what a stranger sees. A token here would classify a
    // server as open when it is not.
    const config = runDoctor.mock.calls[0][0].config;
    expect(config).not.toHaveProperty("accessToken");
    expect(config).not.toHaveProperty("refreshToken");
    expect(config).not.toHaveProperty("authProvider");
  });
});
