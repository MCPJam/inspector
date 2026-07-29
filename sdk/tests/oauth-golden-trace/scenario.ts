/**
 * HP-44 — the in-memory capture scenario.
 *
 * A complete MCP resource server + authorization server implemented as a `fetch`
 * stub, so the REAL emulator code path (`OAuthConformanceTest` →
 * `sdk/src/oauth/state-machines/`) can be driven end to end in CI with no
 * credentials, no network, and no browser.
 *
 * This is what makes the self-diff possible today: `mcpjam` is first-party and
 * fully source-verified, so proving the oracle against ourselves costs nothing
 * and settles whether the harness works BEFORE any effort goes into proxy
 * capture for hosts we may never be able to run.
 *
 * Scenario capabilities are parameterized because they GATE the diff — and
 * because several of them change what a conformant client is supposed to do.
 * `publishesPrm: false` in particular is not a broken server: it is the
 * condition under which VS Code and Cline correctly omit `resource` entirely.
 */

import type { OAuthConformanceConfig } from "../../src/oauth-conformance/types.js";
import type { TraceScenario } from "../../src/oauth-golden-trace/index.js";

export const MCP_SERVER_URL = "https://mcp.example.test/mcp";
export const AUTH_SERVER_URL = "https://as.example.test";
export const PRM_URL =
  "https://mcp.example.test/.well-known/oauth-protected-resource/mcp";
export const AS_METADATA_URL =
  "https://as.example.test/.well-known/oauth-authorization-server";

export type ScenarioOverrides = {
  /** Publish an RFC 9728 PRM document. Default true. */
  publishesPrm?: boolean;
  /**
   * The `resource` value the PRM document publishes. Defaults to the MCP server
   * URL — note that when these are identical, "sends the server URL" and "sends
   * the PRM resource" are byte-identical on the wire, which the differ reports
   * as a gap rather than pretending to distinguish them.
   */
  prmResource?: string;
  /** Advertise a `registration_endpoint`. Default true. */
  supportsDcr?: boolean;
  /** Advertise `client_id_metadata_document_supported`. Default false. */
  supportsCimd?: boolean;
  /** Protocol version the MCP server returns from `initialize`. */
  serverProtocolVersion?: string;
};

export type ScenarioFixture = {
  scenario: TraceScenario;
  fetchFn: typeof fetch;
  config: OAuthConformanceConfig;
  /** Stubbed authorization-code completion — no browser involved. */
  deps: { completeHeadlessAuthorization: () => Promise<{ code: string }> };
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Build a scenario fixture.
 *
 * The returned `scenario` block describes exactly the capabilities the stub
 * implements, so a trace captured against it carries an accurate gate. Keeping
 * these in one place is deliberate: a `scenario` that lies about its server is
 * worse than no gate at all, because the differ would then compare
 * genuinely-incomparable captures and report the difference as an emulator bug.
 */
export function createScenarioFixture(
  overrides: ScenarioOverrides = {},
): ScenarioFixture {
  const publishesPrm = overrides.publishesPrm ?? true;
  const supportsDcr = overrides.supportsDcr ?? true;
  const supportsCimd = overrides.supportsCimd ?? false;
  const serverProtocolVersion = overrides.serverProtocolVersion ?? "2025-11-25";
  const prmResource = overrides.prmResource ?? MCP_SERVER_URL;

  const scenario: TraceScenario = {
    scenarioId: `in-memory-dcr-authcode-prm${publishesPrm ? "" : "-noprm"}`,
    description:
      "In-memory MCP resource server + authorization server: 401 challenge → RFC 9728 PRM → RFC 8414 AS metadata → RFC 7591 DCR → authorization code + PKCE S256 → token → MCP initialize.",
    mcpServerUrl: MCP_SERVER_URL,
    authorizationServerUrl: AUTH_SERVER_URL,
    capabilities: {
      publishesPrm,
      ...(publishesPrm ? { prmResource } : {}),
      supportsDcr,
      supportsCimd,
      codeChallengeMethods: ["S256"],
      asMetadataDocuments: ["/.well-known/oauth-authorization-server"],
      challengesUnauthenticated: true,
    },
  };

  const fetchFn: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });

    const authorization = headers.authorization ?? headers.Authorization;
    const parsed = new URL(url);
    const path = parsed.pathname;

    // ── MCP resource server ──
    if (parsed.origin === new URL(MCP_SERVER_URL).origin) {
      if (publishesPrm && path === new URL(PRM_URL).pathname) {
        return jsonResponse({
          resource: prmResource,
          authorization_servers: [AUTH_SERVER_URL],
          scopes_supported: ["mcp:read", "mcp:write"],
          bearer_methods_supported: ["header"],
        });
      }

      if (path === new URL(MCP_SERVER_URL).pathname) {
        if (!authorization) {
          return new Response(null, {
            status: 401,
            headers: publishesPrm
              ? { "WWW-Authenticate": `Bearer resource_metadata="${PRM_URL}"` }
              : { "WWW-Authenticate": "Bearer" },
          });
        }
        return jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: serverProtocolVersion,
            serverInfo: { name: "hp44-in-memory-server", version: "1.0.0" },
            capabilities: {},
          },
        });
      }

      return jsonResponse({ error: "not_found" }, 404);
    }

    // ── Authorization server ──
    if (path === new URL(AS_METADATA_URL).pathname) {
      return jsonResponse({
        issuer: AUTH_SERVER_URL,
        authorization_endpoint: `${AUTH_SERVER_URL}/authorize`,
        token_endpoint: `${AUTH_SERVER_URL}/token`,
        ...(supportsDcr ? { registration_endpoint: `${AUTH_SERVER_URL}/register` } : {}),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["mcp:read", "mcp:write"],
        ...(supportsCimd ? { client_id_metadata_document_supported: true } : {}),
      });
    }

    if (path === "/register") {
      return jsonResponse(
        {
          client_id: "hp44-issued-client-id",
          client_id_issued_at: 1_800_000_000,
          redirect_uris: ["http://127.0.0.1:33418/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        },
        201,
      );
    }

    if (path === "/token") {
      return jsonResponse({
        access_token: "hp44-access-token-value-not-a-real-credential",
        refresh_token: "hp44-refresh-token-value-not-a-real-credential",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "mcp:read mcp:write",
      });
    }

    return jsonResponse({ error: "not_found" }, 404);
  }) as typeof fetch;

  return {
    scenario,
    fetchFn,
    config: {
      serverUrl: MCP_SERVER_URL,
      protocolVersion: "2025-11-25",
      registrationStrategy: "dcr",
      auth: { mode: "headless" },
      redirectUrl: "http://127.0.0.1:33418/callback",
      fetchFn,
    },
    deps: {
      completeHeadlessAuthorization: async () => ({
        code: "hp44-authorization-code-not-a-real-credential",
      }),
    },
  };
}
