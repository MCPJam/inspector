/**
 * HP-44 — HAR ingest, the path for hosts we cannot run in-process.
 *
 * The HAR below is shaped like a REAL capture, not a tidy one: it contains
 * unrelated telemetry traffic, it stops before the token exchange because the
 * proxy never saw the browser leg, and it carries a live access token. All three
 * are the normal case, and each is asserted here.
 */

import {
  captureHarTrace,
  formatHarIngestReportHuman,
} from "../../src/oauth-golden-trace/index.js";
import type { TraceScenario } from "../../src/oauth-golden-trace/index.js";

const MCP_SERVER_URL = "https://mcp.vendor.test/mcp";
const AS_URL = "https://auth.vendor.test";

const SCENARIO: TraceScenario = {
  scenarioId: "vendor-dcr-authcode-prm",
  mcpServerUrl: MCP_SERVER_URL,
  authorizationServerUrl: AS_URL,
  capabilities: {
    publishesPrm: true,
    prmResource: MCP_SERVER_URL,
    supportsDcr: true,
    supportsCimd: false,
    codeChallengeMethods: ["S256"],
    asMetadataDocuments: ["/.well-known/oauth-authorization-server"],
    challengesUnauthenticated: true,
  },
};

function header(name: string, value: string) {
  return { name, value };
}

const HAR = {
  log: {
    version: "1.2",
    creator: { name: "mitmproxy", version: "11.0.0" },
    entries: [
      // Unrelated traffic — the normal contents of a desktop client's capture.
      {
        startedDateTime: "2026-07-29T09:00:00.000Z",
        request: {
          method: "POST",
          url: "https://telemetry.vendor.test/v1/events",
          headers: [header("User-Agent", "VendorApp/3.2.1")],
        },
        response: { status: 200, headers: [], content: { mimeType: "application/json", text: "{}" } },
      },
      {
        startedDateTime: "2026-07-29T09:00:01.000Z",
        request: {
          method: "GET",
          url: "https://fonts.googleapis.com/css2?family=Inter",
          headers: [],
        },
        response: { status: 200, headers: [], content: { mimeType: "text/css", text: "" } },
      },
      // The handshake.
      {
        startedDateTime: "2026-07-29T09:00:02.000Z",
        request: {
          method: "POST",
          url: MCP_SERVER_URL,
          headers: [
            header("User-Agent", "VendorApp/3.2.1"),
            header("Content-Type", "application/json"),
          ],
          postData: {
            mimeType: "application/json",
            text: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: { protocolVersion: "2025-06-18", capabilities: {} },
            }),
          },
        },
        response: {
          status: 401,
          headers: [
            header(
              "WWW-Authenticate",
              `Bearer resource_metadata="${MCP_SERVER_URL.replace("/mcp", "")}/.well-known/oauth-protected-resource/mcp"`,
            ),
          ],
        },
      },
      {
        startedDateTime: "2026-07-29T09:00:03.000Z",
        request: {
          method: "GET",
          url: "https://mcp.vendor.test/.well-known/oauth-protected-resource/mcp",
          headers: [
            header("User-Agent", "VendorApp/3.2.1"),
            // The `rmcp` signature: a stale version pinned on OAuth discovery
            // while the MCP wire negotiated something newer.
            header("MCP-Protocol-Version", "2024-11-05"),
          ],
        },
        response: {
          status: 200,
          headers: [header("Content-Type", "application/json")],
          content: {
            mimeType: "application/json",
            text: JSON.stringify({
              resource: MCP_SERVER_URL,
              authorization_servers: [AS_URL],
            }),
          },
        },
      },
      {
        startedDateTime: "2026-07-29T09:00:04.000Z",
        request: {
          method: "POST",
          url: `${AS_URL}/register`,
          headers: [
            header("User-Agent", "VendorApp/3.2.1"),
            header("Content-Type", "application/json"),
          ],
          postData: {
            mimeType: "application/json",
            text: JSON.stringify({
              client_name: "Vendor App",
              redirect_uris: ["http://127.0.0.1:49871/callback"],
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
            }),
          },
        },
        response: {
          status: 201,
          headers: [header("Content-Type", "application/json")],
          content: {
            mimeType: "application/json",
            text: JSON.stringify({ client_id: "vendor-client-42" }),
          },
        },
      },
      // A live token on the wire — must not survive ingest.
      {
        startedDateTime: "2026-07-29T09:00:05.000Z",
        request: {
          method: "POST",
          url: `${AS_URL}/token`,
          headers: [
            header("User-Agent", "VendorApp/3.2.1"),
            header("Content-Type", "application/x-www-form-urlencoded"),
          ],
          postData: {
            mimeType: "application/x-www-form-urlencoded",
            params: [
              header("grant_type", "authorization_code"),
              header("code", "live-authorization-code-abcdefghijklmnop"),
              header("code_verifier", "live-verifier-value-abcdefghijklmnopqrst"),
              header("resource", MCP_SERVER_URL),
            ],
          },
        },
        response: {
          status: 200,
          headers: [header("Content-Type", "application/json")],
          content: {
            mimeType: "application/json",
            text: JSON.stringify({
              access_token: "live-access-token-abcdefghijklmnopqrstuvwxyz",
              refresh_token: "live-refresh-token-abcdefghijklmnopqrstuvwxyz",
              token_type: "Bearer",
              expires_in: 3600,
            }),
          },
        },
      },
    ],
  },
};

describe("captureHarTrace", () => {
  it("keeps the handshake and drops unrelated traffic, reporting what it dropped", () => {
    const { trace, report } = captureHarTrace({
      har: HAR,
      hostId: "vendor",
      scenario: SCENARIO,
      hostVersion: "3.2.1",
      oauthImplementation: {
        kind: "dependency",
        package: "rmcp",
        version: "2.2.0",
        resolvedFrom: "Cargo.lock",
      },
    });

    expect(report.totalEntries).toBe(6);
    expect(report.keptEntries).toBe(4);
    expect(report.dropped).toHaveLength(2);
    expect(report.dropped.map((entry) => entry.url)).toEqual([
      "https://telemetry.vendor.test/v1/events",
      "https://fonts.googleapis.com/css2?family=Inter",
    ]);

    expect(trace.observations.legOrder).toEqual([
      "mcp-unauthenticated",
      "prm-discovery",
      "dcr-register",
      "token",
    ]);
  });

  it("reports the legs the capture never reached rather than inferring them", () => {
    const { trace, report } = captureHarTrace({
      har: HAR,
      hostId: "vendor",
      scenario: SCENARIO,
      hostVersion: "3.2.1",
    });

    // The proxy never saw /authorize (browser leg) or the AS metadata document.
    expect(report.missingLegs).toEqual([
      "as-metadata-discovery",
      "authorize",
      "mcp-initialize",
    ]);

    // And every field those legs would have carried is `not-observed`, NOT absent.
    expect(trace.observations.resourceIndicator.onAuthorize.state).toBe(
      "not-observed",
    );
    expect(trace.observations.pkce.challengeMethod.state).toBe("not-observed");

    // The legs that WERE captured produce real findings.
    expect(trace.observations.resourceIndicator.onToken).toEqual({
      state: "present",
      value: ["{mcp_server}/mcp"],
    });
    // And the value is classified against the scenario, not just recorded.
    expect(trace.observations.resourceIndicator.valueSource).toEqual({
      state: "present",
      value: "mcp-server-url",
    });

    const rendered = formatHarIngestReportHuman(report);
    expect(rendered).toContain("MISSING LEGS");
    expect(rendered).toContain("authorize");
  });

  it("redacts live credentials at ingest, not at render time", () => {
    const { trace } = captureHarTrace({
      har: HAR,
      hostId: "vendor",
      scenario: SCENARIO,
      hostVersion: "3.2.1",
    });

    const serialized = JSON.stringify(trace);
    expect(serialized).not.toContain("live-access-token");
    expect(serialized).not.toContain("live-refresh-token");
    expect(serialized).not.toContain("live-authorization-code");
    expect(serialized).not.toContain("live-verifier-value");
  });

  it("captures the split-wire protocol version the report flagged as invisible from docs", () => {
    const { trace } = captureHarTrace({
      har: HAR,
      hostId: "vendor",
      scenario: SCENARIO,
      hostVersion: "3.2.1",
    });
    const pv = trace.observations.protocolVersion;

    // 2024-11-05 on OAuth discovery, 2025-06-18 in the initialize body: exactly
    // the `rmcp` finding, which no vendor doc states and which a single-field
    // schema would have averaged away.
    expect(pv.headerOnOAuthDiscovery).toEqual({
      state: "present",
      value: ["2024-11-05"],
    });
    expect(pv.initializeBody).toEqual({ state: "present", value: "2025-06-18" });
    expect(pv.headerDisagreesWithInitializeBody).toBe(true);
  });

  it("records the DCR identity and recovers the loopback port", () => {
    const { trace } = captureHarTrace({
      har: HAR,
      hostId: "vendor",
      scenario: SCENARIO,
      hostVersion: "3.2.1",
    });

    expect(trace.observations.dcrIdentity.clientName).toEqual({
      state: "present",
      value: "Vendor App",
    });
    expect(trace.observations.dcrIdentity.redirectUris).toEqual({
      state: "present",
      value: ["http://127.0.0.1:{port}/callback"],
    });
    expect(trace.observations.dcrIdentity.observedLoopbackPorts).toEqual({
      state: "present",
      value: [49871],
    });
    expect(trace.observations.userAgent.byLeg["dcr-register"]).toEqual({
      state: "present",
      value: ["VendorApp/3.2.1"],
    });
  });

  it("marks the subject as unstamped when no version or dependency is supplied", () => {
    const { trace } = captureHarTrace({
      har: HAR,
      hostId: "vendor",
      scenario: SCENARIO,
    });

    // A trace that cannot name the build it recorded goes stale invisibly, so this
    // is representable only as `not-observed` — and the differ reports it as a gap.
    expect(trace.subject.hostVersion.state).toBe("not-observed");
    expect(trace.subject.oauthImplementation.state).toBe("not-observed");
    if (trace.subject.oauthImplementation.state === "not-observed") {
      expect(trace.subject.oauthImplementation.reason).toContain("dependency");
    }
  });

  it("derives the capture date from the HAR when none is supplied", () => {
    const { trace } = captureHarTrace({
      har: HAR,
      hostId: "vendor",
      scenario: SCENARIO,
    });
    expect(trace.capture.capturedAt).toBe("2026-07-29");
    expect(trace.capture.method).toEqual({
      via: "har",
      harCreator: "mitmproxy",
      harVersion: "1.2",
    });
  });

  it("warns loudly when no capture date can be established", () => {
    const { trace, report } = captureHarTrace({
      har: { log: { version: "1.2", entries: [] } },
      hostId: "vendor",
      scenario: SCENARIO,
    });
    expect(trace.capture.capturedAt).toBe("unknown");
    expect(report.warnings.join(" ")).toContain("unusable as dated evidence");
  });
});
