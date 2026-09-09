/**
 * The auth-probe child, and the one thing it must never do: present a probe
 * that could not run as a completed one with nothing wrong in it.
 */

import { describe, expect, it, vi } from "vitest";
import {
  BENCHMARK_PROBE_CHECK_IDS,
  buildProbeEvidence,
  gradeProbeChecks,
  runBenchmarkAuthProbe,
} from "../bench-probe-child";
import type { ProbeMcpServerResult } from "@mcpjam/sdk";

const ENDPOINT = "https://connector.example.com/mcp";

function probe(
  overrides: Omit<Partial<ProbeMcpServerResult>, "oauth"> & {
    oauth?: Partial<ProbeMcpServerResult["oauth"]>;
  } = {},
): ProbeMcpServerResult {
  const { oauth, ...rest } = overrides;
  return {
    url: ENDPOINT,
    protocolVersion: "2025-11-25",
    status: "oauth_required",
    transport: { attempts: [] },
    ...rest,
    oauth: {
      required: true,
      optional: false,
      wwwAuthenticate: `Bearer resource_metadata="${ENDPOINT}/.well-known/oauth-protected-resource"`,
      resourceMetadataUrl: `${ENDPOINT}/.well-known/oauth-protected-resource`,
      resourceMetadata: {
        resource: ENDPOINT,
        authorization_servers: ["https://auth.example.com"],
        scopes_supported: ["mcp:read"],
      },
      registrationStrategies: ["dcr"],
      ...oauth,
    },
  } as ProbeMcpServerResult;
}

describe("buildProbeEvidence", () => {
  it("reports an egress refusal as refused with no checks", () => {
    // A completed probe with zero checks reads, downstream, as a server that
    // had nothing wrong with it — and the backend would stamp the row
    // verified on the strength of it.
    const evidence = buildProbeEvidence(ENDPOINT, {
      kind: "refused",
      errorCode: "URL_NOT_ALLOWED",
      detail: "Refusing to dial a private address",
    });

    expect(evidence.status).toBe("refused");
    expect(evidence.checks).toEqual([]);
    expect(evidence.failureReason).toBe("Refusing to dial a private address");
    expect(evidence.discovery.resourceMetadataFound).toBe(false);
  });

  it("reports an unreachable target as failed with no checks", () => {
    const evidence = buildProbeEvidence(ENDPOINT, {
      kind: "unreachable",
      detail: "Discovery did not finish within 60000ms",
    });

    expect(evidence.status).toBe("failed");
    expect(evidence.checks).toEqual([]);
  });

  it("carries the non-compliant challenge status as the number it was", () => {
    // A 403, a 200 and a 500 have three different remediations; a boolean
    // would say only that one of them happened.
    const evidence = buildProbeEvidence(
      ENDPOINT,
      { kind: "probed", probe: probe({ oauth: { nonCompliantChallengeStatus: 500 } }) },
    );

    expect(evidence.status).toBe("completed");
    expect(evidence.nonCompliantChallengeStatus).toBe(500);
    expect(
      evidence.checks.find(
        (check) => check.id === BENCHMARK_PROBE_CHECK_IDS.unauthenticatedChallenge,
      ),
    ).toMatchObject({ outcome: "failed", securityCritical: true });
  });

  it("summarizes RFC 9728 discovery off the probed metadata", () => {
    const evidence = buildProbeEvidence(ENDPOINT, {
      kind: "probed",
      probe: probe(),
    });

    expect(evidence.discovery).toEqual({
      resourceMetadataFound: true,
      resourceMetadataUrl: `${ENDPOINT}/.well-known/oauth-protected-resource`,
      authorizationServers: ["https://auth.example.com"],
      scopesSupported: ["mcp:read"],
      resource: ENDPOINT,
    });
    expect(evidence.registrationStrategies).toEqual(["dcr"]);
    expect(evidence.checks.every((check) => check.outcome === "passed")).toBe(true);
  });
});

describe("gradeProbeChecks", () => {
  it("calls every auth check inapplicable for a server that serves without auth", () => {
    const checks = gradeProbeChecks(probe({ status: "ready" }));
    expect(checks.map((check) => check.outcome)).toEqual(
      Object.values(BENCHMARK_PROBE_CHECK_IDS).map(() => "not_applicable"),
    );
  });

  it("calls every auth check unrun when the target never produced an MCP answer", () => {
    // "Reachable but not MCP" leaves every obligation untested. Reporting it
    // as inapplicable would drop it from the denominator, which is the same
    // as saying the server had no obligation to meet.
    const checks = gradeProbeChecks(
      probe({ status: "reachable", error: "answered with an HTML page" }),
    );
    expect(checks.every((check) => check.outcome === "could_not_run")).toBe(true);
  });

  it("fails a relative resource_metadata URL in the challenge", () => {
    const checks = gradeProbeChecks(
      probe({
        oauth: {
          wwwAuthenticate:
            'Bearer resource_metadata="/.well-known/oauth-protected-resource"',
        },
      }),
    );
    expect(
      checks.find(
        (check) =>
          check.id ===
          BENCHMARK_PROBE_CHECK_IDS.challengeAdvertisesResourceMetadata,
      ),
    ).toMatchObject({ outcome: "failed" });
  });

  it("cannot judge the challenge when no WWW-Authenticate header arrived", () => {
    const checks = gradeProbeChecks(
      probe({ oauth: { wwwAuthenticate: undefined } }),
    );
    expect(
      checks.find(
        (check) =>
          check.id ===
          BENCHMARK_PROBE_CHECK_IDS.challengeAdvertisesResourceMetadata,
      ),
    ).toMatchObject({ outcome: "could_not_run" });
  });

  it("cannot judge the authorization server when metadata was never fetched", () => {
    const checks = gradeProbeChecks(
      probe({
        oauth: { resourceMetadata: undefined, discoveryError: "404" },
      }),
    );
    expect(
      checks.find(
        (check) =>
          check.id === BENCHMARK_PROBE_CHECK_IDS.resourceMetadataDiscoverable,
      ),
    ).toMatchObject({ outcome: "failed", detail: "404" });
    expect(
      checks.find(
        (check) =>
          check.id === BENCHMARK_PROBE_CHECK_IDS.authorizationServerAdvertised,
      ),
    ).toMatchObject({ outcome: "could_not_run" });
  });
});

describe("runBenchmarkAuthProbe", () => {
  it("dials through the egress guard and never opts into loopback", async () => {
    const probeServer = vi.fn(async () => probe());
    const evidence = await runBenchmarkAuthProbe(
      { serverUrl: ENDPOINT },
      { probeServer: probeServer as never, fetchFn: vi.fn() as never },
    );

    expect(evidence.status).toBe("completed");
    expect(probeServer).toHaveBeenCalledTimes(1);
    expect((probeServer.mock.calls[0] as unknown[])[0]).toMatchObject({
      url: ENDPOINT,
    });
  });

  it("refuses a loopback endpoint rather than probing it", async () => {
    const probeServer = vi.fn(async () => probe());
    const evidence = await runBenchmarkAuthProbe(
      { serverUrl: "http://127.0.0.1:3000/mcp" },
      { probeServer: probeServer as never },
    );

    expect(evidence.status).toBe("refused");
    expect(probeServer).not.toHaveBeenCalled();
  });
});
