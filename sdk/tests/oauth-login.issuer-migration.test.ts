import { expect, it } from "vitest";
import { runOAuthLogin } from "../src/oauth-login.js";

const server = "https://mcp.example.com/mcp";
const issuers = ["https://auth-a.example.com", "https://auth-b.example.com"];
const metadataUrl =
  "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
const protocolVersion = "2026-07-28";

it.each([
  "migrates",
  "same issuer",
  "pre-registered",
  "new token rejected",
] as const)(
  "handles an authenticated 401 when the server %s",
  async (scenario) => {
    const registrations: number[] = [];
    const authorizations: URL[] = [];
    const toolTokens: string[] = [];
    let issuerIndex = 0;
    let firstTokenVerified = false;
    const fetchFn: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === metadataUrl) {
        return Response.json({
          resource: server,
          authorization_servers: [issuers[issuerIndex]],
        });
      }
      for (const [index, issuer] of issuers.entries()) {
        if (url === issuer + "/.well-known/oauth-authorization-server") {
          return Response.json({
            issuer,
            authorization_endpoint: issuer + "/authorize",
            token_endpoint: issuer + "/token",
            registration_endpoint: issuer + "/register",
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
          });
        }
        if (url === issuer + "/register") {
          registrations.push(index);
          return Response.json(
            { client_id: "client-" + index },
            { status: 201 }
          );
        }
        if (url === issuer + "/token") {
          const body = new URLSearchParams(String(init?.body));
          expect(body.get("client_id")).toBe("client-" + index);
          return Response.json({
            access_token: "token-" + index,
            token_type: "Bearer",
          });
        }
      }
      if (url !== server) throw new Error("Unexpected URL: " + url);
      if (init?.method !== "POST") return new Response(null, { status: 405 });

      const token = new Headers(init.headers).get("authorization");
      const request = JSON.parse(String(init.body));
      const reply = (result: object) =>
        Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: { resultType: "complete", ...result },
        });
      if (
        !token ||
        (token === "Bearer token-0" && firstTokenVerified) ||
        (scenario === "new token rejected" &&
          request.method === "server/discover")
      ) {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${metadataUrl}"`,
          },
        });
      }
      switch (request.method) {
        case "server/discover":
          return reply({
            supportedVersions: [protocolVersion],
            capabilities: { tools: {} },
          });
        case "tools/list":
          if (token === "Bearer token-0") {
            firstTokenVerified = true;
            if (scenario !== "same issuer") issuerIndex = 1;
          }
          return reply({
            tools: [{ name: "test-tool", inputSchema: { type: "object" } }],
            ttlMs: 0,
            cacheScope: "private",
          });
        case "tools/call":
          toolTokens.push(token);
          return reply({ content: [{ type: "text", text: "success" }] });
        default:
          throw new Error("Unexpected MCP method");
      }
    };

    const result = await runOAuthLogin(
      {
        serverUrl: server,
        protocolVersion,
        auth: { mode: "headless" },
        fetchFn,
        verification: { listTools: true, callTool: { name: "test-tool" } },
        ...(scenario === "pre-registered"
          ? {
              registrationMode: "preregistered" as const,
              client: { preregistered: { clientId: "client-0" } },
            }
          : {}),
      },
      {
        completeHeadlessAuthorization: async ({ authorizationUrl }) => {
          authorizations.push(new URL(authorizationUrl));
          return { code: "auth-code" };
        },
      }
    );

    const reauthorized =
      scenario === "migrates" || scenario === "new token rejected";
    expect(registrations).toEqual(
      reauthorized ? [0, 1] : scenario === "pre-registered" ? [] : [0]
    );
    expect(
      authorizations.map((url) => [
        url.origin,
        url.searchParams.get("client_id"),
      ])
    ).toEqual(
      reauthorized
        ? [
            [issuers[0], "client-0"],
            [issuers[1], "client-1"],
          ]
        : [[issuers[0], "client-0"]]
    );
    expect(toolTokens).toEqual(
      scenario === "migrates" ? ["Bearer token-1"] : []
    );
    if (scenario === "migrates") {
      expect(result.completed).toBe(true);
      expect(result.credentials.accessToken).toBe("token-1");
      expect(result.verification?.callTool?.passed).toBe(true);
    }
    if (scenario === "pre-registered" || scenario === "new token rejected") {
      expect(result.completed).toBe(false);
      expect(result.credentials.accessToken).toBeUndefined();
      expect(result.error?.message).toMatch(
        /new (authorization server|issuer)/
      );
    }
  }
);
