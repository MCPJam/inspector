import { describe, expect, it, vi } from "vitest";
import { scoreFromOAuthResult } from "../../src/conformance-score.js";
import { OAuthConformanceTest } from "../../src/oauth-conformance/runner.js";
import type { OAuthConformanceConfig } from "../../src/oauth-conformance/types.js";
import { DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL } from "../../src/oauth/client-identity.js";
import { resolveInitializeProtocolVersion } from "../../src/oauth/state-machines/shared/initialize.js";

const protocolVersions = [
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
] as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function runFlow({
  protocolVersion = "2025-11-25",
  registrationStrategy = "preregistered",
  mode = "headless",
  oauthConformanceChecks = true,
  advertiseRegistration = true,
}: {
  protocolVersion?: OAuthConformanceConfig["protocolVersion"];
  registrationStrategy?: OAuthConformanceConfig["registrationStrategy"];
  mode?: "headless" | "client_credentials";
  oauthConformanceChecks?: boolean;
  advertiseRegistration?: boolean;
} = {}) {
  const authServerUrl = "https://auth.example.com";
  const serverUrl = `${authServerUrl}/mcp`;
  const resourceMetadataUrl = `${authServerUrl}/.well-known/oauth-protected-resource/mcp`;
  const redirectUrl = "http://127.0.0.1:3333/callback";
  const registrationRequests: string[] = [];
  const clientId = "registered-client";
  const clientSecret = "registered-secret";

  const fetchFn: typeof fetch = vi.fn(async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);

    if (url === serverUrl) {
      if (headers.get("Mcp-Session-Id")) {
        return jsonResponse({ error: "unknown_session" }, 404);
      }
      if (headers.get("Authorization") !== "Bearer access-token") {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
          },
        });
      }
      return jsonResponse({
        jsonrpc: "2.0",
        result:
          protocolVersion === "2026-07-28"
            ? { tools: [] }
            : {
                protocolVersion:
                  resolveInitializeProtocolVersion(protocolVersion),
                serverInfo: { name: "mock-server", version: "1.0.0" },
                capabilities: {},
              },
      });
    }

    if (url === resourceMetadataUrl) {
      return jsonResponse({
        resource: serverUrl,
        authorization_servers: [authServerUrl],
      });
    }

    if (url === `${authServerUrl}/.well-known/oauth-authorization-server`) {
      return jsonResponse({
        issuer: authServerUrl,
        authorization_endpoint: `${authServerUrl}/authorize`,
        token_endpoint: `${authServerUrl}/token`,
        ...(advertiseRegistration
          ? { registration_endpoint: `${authServerUrl}/register` }
          : {}),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "client_credentials"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
        code_challenge_methods_supported: ["S256"],
        client_id_metadata_document_supported: true,
      });
    }

    if (url === DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL) {
      return jsonResponse({
        client_id: DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
        client_name: "MCPJam SDK OAuth Conformance",
        redirect_uris: [redirectUrl],
      });
    }

    if (url === `${authServerUrl}/register`) {
      registrationRequests.push(String(init?.body));
      return jsonResponse(
        { client_id: clientId, client_secret: clientSecret },
        201
      );
    }

    if (url.startsWith(`${authServerUrl}/authorize?`)) {
      return jsonResponse({ error: "invalid_redirect_uri" }, 400);
    }

    if (url === `${authServerUrl}/token`) {
      const body = new URLSearchParams(String(init?.body));
      if (body.get("client_id") === "invalid-client-id") {
        return jsonResponse({ error: "invalid_client" }, 401);
      }
      if (body.get("redirect_uri")?.includes("invalid=1")) {
        return jsonResponse({ error: "invalid_redirect_uri" }, 400);
      }
      return jsonResponse({
        access_token: "access-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }

    return jsonResponse({ error: "not_found" }, 404);
  });

  const test = new OAuthConformanceTest(
    {
      serverUrl,
      protocolVersion,
      registrationStrategy,
      auth:
        mode === "client_credentials"
          ? { mode, clientId, clientSecret }
          : { mode },
      client: { preregistered: { clientId, clientSecret } },
      redirectUrl,
      fetchFn,
      oauthConformanceChecks,
    },
    { completeHeadlessAuthorization: async () => ({ code: "auth-code" }) }
  );

  return { result: await test.run(), registrationRequests };
}

describe.each(["headless", "client_credentials"] as const)(
  "pre-registered OAuth checks with %s authentication",
  (mode) => {
    it.each(protocolVersions)(
      "skips DCR without sending a registration request on %s",
      async (protocolVersion) => {
        const { result, registrationRequests } = await runFlow({
          protocolVersion,
          mode,
        });

        expect(registrationRequests).toEqual([]);
        expect(
          result.steps.find(
            (step) => step.step === "oauth_dcr_http_redirect_uri"
          )
        ).toMatchObject({
          status: "skipped",
          skipReason: "not-applicable",
          durationMs: 0,
          httpAttempts: [],
          error: {
            message:
              "Dynamic client registration checks do not apply to pre-registered clients",
          },
        });
        for (const check of [
          "oauth_invalid_client",
          "oauth_invalid_token",
          "oauth_token_format",
        ]) {
          expect(result.steps.find((step) => step.step === check)?.status).toBe(
            "passed"
          );
        }
        if (mode === "headless") {
          for (const check of [
            "oauth_invalid_authorize_redirect",
            "oauth_invalid_redirect",
          ]) {
            expect(
              result.steps.find((step) => step.step === check)?.status
            ).toBe("passed");
          }
        }
        expect(result.outcome).toBe("passed");
        expect(result.passed).toBe(true);
        const score = scoreFromOAuthResult(result);
        const withoutDcr = scoreFromOAuthResult({
          ...result,
          steps: result.steps.filter(
            (step) => step.step !== "oauth_dcr_http_redirect_uri"
          ),
        });
        expect(score.score).toBe(100);
        expect(score.applicable).toBe(withoutDcr.applicable);
        expect(score.notApplicable).toBe(withoutDcr.notApplicable + 1);
      }
    );
  }
);

it.each(["dcr", "cimd"] as const)(
  "keeps the advertised DCR policy check running for %s",
  async (registrationStrategy) => {
    const { result, registrationRequests } = await runFlow({
      registrationStrategy,
    });

    expect(
      registrationRequests.some((body) =>
        body.includes("http://evil.example/callback")
      )
    ).toBe(true);
    expect(
      result.steps.find((step) => step.step === "oauth_dcr_http_redirect_uri")
        ?.status
    ).toBe("failed");
    expect(result.outcome).toBe("failed");
  }
);

it("marks DCR inapplicable for pre-reg even without an advertised endpoint", async () => {
  const { result, registrationRequests } = await runFlow({
    advertiseRegistration: false,
  });

  expect(registrationRequests).toEqual([]);
  expect(
    result.steps.find((step) => step.step === "oauth_dcr_http_redirect_uri")
  ).toMatchObject({ status: "skipped", skipReason: "not-applicable" });
  expect(result.outcome).toBe("passed");
});

it("does not add a DCR result when OAuth conformance checks are disabled", async () => {
  const { result, registrationRequests } = await runFlow({
    oauthConformanceChecks: false,
  });

  expect(registrationRequests).toEqual([]);
  expect(
    result.steps.some((step) => step.step === "oauth_dcr_http_redirect_uri")
  ).toBe(false);
  expect(result.outcome).toBe("passed");
});
