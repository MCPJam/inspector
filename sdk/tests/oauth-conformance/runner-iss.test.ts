import { OAuthConformanceTest } from "../../src/oauth-conformance/index.js";
import { DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL } from "../../src/oauth/client-identity.js";

// RFC 9207 issuer validation in the runner: 2026-07-28 applies all four cases
// before the token request; earlier versions keep their old behavior.

const serverUrl = "https://mcp.example.com/mcp";
const resourceMetadataUrl =
  "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
const authServerUrl = "https://auth.example.com";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createFetch(issParameterSupported: boolean) {
  const tokenRequests: string[] = [];
  const fetchFn = jest.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url === serverUrl && !headers.get("Authorization")) {
      return new Response(null, {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
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
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        client_id_metadata_document_supported: true,
        ...(issParameterSupported
          ? { authorization_response_iss_parameter_supported: true }
          : {}),
      });
    }
    if (url === DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL) {
      return jsonResponse({
        client_id: DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
        client_name: "MCPJam SDK OAuth Conformance",
        redirect_uris: ["http://127.0.0.1:3333/callback"],
      });
    }
    if (url === `${authServerUrl}/token`) {
      tokenRequests.push(url);
      return jsonResponse({
        access_token: "access-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (url === serverUrl) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          protocolVersion: "2026-07-28",
          serverInfo: { name: "mock-server", version: "1.0.0" },
          capabilities: {},
          tools: [],
          resultType: "complete",
        },
      });
    }
    return jsonResponse({ error: "not found" }, 404);
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, tokenRequests };
}

async function run(options: {
  protocolVersion: "2025-11-25" | "2026-07-28";
  issParameterSupported: boolean;
  iss?: string;
}) {
  const { fetchFn, tokenRequests } = createFetch(options.issParameterSupported);
  const result = await new OAuthConformanceTest(
    {
      serverUrl,
      protocolVersion: options.protocolVersion,
      registrationStrategy: "cimd",
      auth: { mode: "headless" },
      fetchFn,
      readinessIds: [],
    },
    {
      completeHeadlessAuthorization: jest.fn(async () => ({
        code: "auth-code",
        ...(options.iss !== undefined ? { iss: options.iss } : {}),
      })),
    },
  ).run();
  const codeStep = result.steps.find(
    (step) => step.step === "received_authorization_code",
  );
  return { result, codeStep, tokenRequests };
}

describe("OAuthConformanceTest RFC 9207 issuer check", () => {
  it("2026-07-28: accepts a matching iss", async () => {
    const { codeStep, tokenRequests } = await run({
      protocolVersion: "2026-07-28",
      issParameterSupported: true,
      iss: authServerUrl,
    });
    expect(codeStep?.status).toBe("passed");
    expect(tokenRequests).toHaveLength(1);
  });

  it.each([true, false])(
    "2026-07-28: rejects a mismatched iss before the token request (advertised: %s)",
    async (issParameterSupported) => {
      const { codeStep, tokenRequests } = await run({
        protocolVersion: "2026-07-28",
        issParameterSupported,
        iss: "https://evil.example.com",
      });
      expect(codeStep?.status).toBe("failed");
      expect(codeStep?.error?.message).toMatch(/does not match the issuer/);
      expect(tokenRequests).toHaveLength(0);
    },
  );

  it("2026-07-28: rejects a missing iss when the server advertises iss support", async () => {
    const { codeStep, tokenRequests } = await run({
      protocolVersion: "2026-07-28",
      issParameterSupported: true,
    });
    expect(codeStep?.status).toBe("failed");
    expect(codeStep?.error?.message).toMatch(
      /did not include an `iss` parameter/,
    );
    expect(tokenRequests).toHaveLength(0);
  });

  it("2026-07-28: accepts a missing iss when the server doesn't advertise iss support", async () => {
    const { codeStep, tokenRequests } = await run({
      protocolVersion: "2026-07-28",
      issParameterSupported: false,
    });
    expect(codeStep?.status).toBe("passed");
    expect(tokenRequests).toHaveLength(1);
  });

  it("2025-11-25: keeps accepting a missing iss even when advertised", async () => {
    const { codeStep, tokenRequests } = await run({
      protocolVersion: "2025-11-25",
      issParameterSupported: true,
    });
    expect(codeStep?.status).toBe("passed");
    expect(tokenRequests).toHaveLength(1);
  });
});
