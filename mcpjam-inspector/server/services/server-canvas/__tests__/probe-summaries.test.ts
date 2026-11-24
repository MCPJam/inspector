import { describe, expect, it } from "vitest";
import {
  MCP_TASKS_TOOL_CHECK_IDS,
  checkIntrusiveness,
  type ProbeMcpServerResult,
} from "@mcpjam/sdk";
import { PROBE_CHECKS } from "../../../../shared/conformance-settings.js";
import { BlockedEgressTargetError } from "../../../utils/hosted-egress-guard.js";
import {
  METADATA_REFUSED,
  authorizationSummary,
  httpTransportSummary,
  runHttpProbes,
} from "../probes/http-probes.js";
import { storableUrl } from "../probes/shared.js";

function probe(overrides: Partial<ProbeMcpServerResult> = {}): ProbeMcpServerResult {
  return {
    url: "https://srv.example.com/mcp",
    protocolVersion: "2025-11-25",
    status: "ready",
    transport: {
      selected: "streamable-http",
      attempts: [
        {
          name: "streamable_initialize",
          request: { method: "POST", url: "https://srv.example.com/mcp", headers: {} },
          response: {
            status: 200,
            statusText: "OK",
            headers: { "mcp-session-id": "session-value" },
          },
          durationMs: 1,
        },
      ],
    },
    initialize: {
      protocolVersion: "2025-11-25",
      contentType: "text/event-stream; charset=utf-8",
    },
    oauth: { required: false, optional: false, registrationStrategies: [] },
    ...overrides,
  };
}

describe("HTTP probe summaries", () => {
  it("maps a ready server's transport without storing the session id", () => {
    const summary = httpTransportSummary(probe(), 5);
    expect(summary).toEqual({
      probeId: "http-transport",
      status: "ok",
      coverage: "complete",
      at: 5,
      values: {
        status: "ready",
        selectedTransport: "streamable-http",
        protocolVersion: "2025-11-25",
        streamableHttp: true,
        responseContentType: "text/event-stream",
        sessionIdIssued: true,
      },
    });
    expect(JSON.stringify(summary)).not.toContain("session-value");
  });

  it("reports a server that did not answer as failed, with a fixed detail", () => {
    const summary = httpTransportSummary(
      probe({ status: "error", error: "fetch https://srv.example.com/mcp?key=abc failed" }),
      5,
    );
    expect(summary.status).toBe("failed");
    expect(JSON.stringify(summary)).not.toContain("key=abc");
  });

  it("keeps issuers verbatim so the catalog can compare them exactly", () => {
    const summary = authorizationSummary(
      probe({
        status: "oauth_required",
        oauth: {
          required: true,
          optional: false,
          wwwAuthenticate: 'Bearer realm="x"',
          resourceMetadata: {
            resource: "https://srv.example.com/mcp",
            authorization_servers: ["https://auth.example.com/", "https://u:p@auth2.example.com/x?k=1"],
          },
          authorizationServerMetadataUrl:
            "https://auth.example.com/.well-known/openid-configuration",
          authorizationServerMetadata: { issuer: "https://auth.example.com" },
          registrationStrategies: ["preregistered"],
          discoveryError: "HTTP 404",
        },
      }),
      5,
    );
    expect(summary.coverage).toBe("partial");
    expect(summary.values).toMatchObject({
      challengeHasResourceMetadata: false,
      prmAuthorizationServers: ["https://auth.example.com/", "https://auth2.example.com/x"],
      issuer: "https://auth.example.com",
      asMetadataKind: "oidc",
      registrationEndpoint: false,
      cimdSupported: false,
    });
  });

  it("scrubs only what can carry a credential", () => {
    expect(storableUrl("https://auth.example.com")).toBe("https://auth.example.com");
    expect(storableUrl("https://a.example.com/p?token=x#f")).toBe("https://a.example.com/p");
    expect(storableUrl("https://user:pw@a.example.com/")).toBe("https://a.example.com/");
    expect(storableUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("runHttpProbes", () => {
  const SERVER = "https://srv.example.com/mcp";
  const IDP = "https://idp.corp.example";

  /** A public server whose metadata names an authorization server the guard refuses. */
  const privateIdp: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith(IDP)) {
      throw new BlockedEgressTargetError(
        'Request URL hostname "idp.corp.example" resolves to a private address',
      );
    }
    if (init?.method === "POST") {
      return new Response("", {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="https://srv.example.com/.well-known/oauth-protected-resource/mcp"`,
        },
      });
    }
    if (url.startsWith("https://srv.example.com/.well-known/oauth-protected-resource")) {
      return new Response(
        JSON.stringify({ resource: SERVER, authorization_servers: [IDP] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  };

  it("public server, private AS: keeps the transport facts and marks authorization partial", async () => {
    const { httpTransport, authorization } = await runHttpProbes(
      { serverUrl: SERVER, now: () => 5, privateTarget: false },
      { fetchFn: privateIdp },
    );
    expect(httpTransport).toMatchObject({
      status: "ok",
      values: { status: "oauth_required" },
    });
    expect(authorization).toMatchObject({
      status: "ok",
      coverage: "partial",
      detail: METADATA_REFUSED,
      values: {
        oauthRequired: true,
        prmFound: true,
        prmAuthorizationServers: [IDP],
        asMetadataFound: false,
      },
    });
    expect(JSON.stringify(authorization)).not.toContain("resolves to");
  });

  it("fails both probes when the server URL itself is refused", async () => {
    const summaries = await runHttpProbes(
      { serverUrl: SERVER, now: () => 5, privateTarget: false },
      {
        fetchFn: async () => {
          throw new BlockedEgressTargetError(
            'Request URL hostname "srv.example.com" resolves to a private address',
          );
        },
      },
    );
    for (const summary of [summaries.httpTransport, summaries.authorization]) {
      expect(summary).toMatchObject({
        status: "failed",
        coverage: "not-captured",
        detail: "MCPJam may not reach this server address from here.",
      });
    }
  });
});

describe("conformance probe checks", () => {
  it("are all side-effecting, so the background runner refuses them", () => {
    const refs = [
      ...PROBE_CHECKS.logProbe,
      ...PROBE_CHECKS.inputRequiredProbe,
      ...PROBE_CHECKS.toolCallProbe,
    ].filter((id) => !id.startsWith("readiness-"));
    for (const id of refs) {
      expect(checkIntrusiveness(`protocol:${id}`)).toBe("side-effecting");
    }
    for (const id of PROBE_CHECKS.tasksProbe) {
      expect(MCP_TASKS_TOOL_CHECK_IDS).toContain(id);
      expect(checkIntrusiveness(`tasks:${id}`)).toBe("side-effecting");
    }
  });
});
