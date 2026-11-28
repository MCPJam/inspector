import { afterEach, expect, it, vi } from "vitest";
import { runOAuthLogin } from "../src/oauth-login.js";

const server = "https://mcp.example.com/mcp";
const issuer = "https://auth.example.com";
const nextIssuer = "https://new-auth.example.com";
const metadataUrl =
  "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
const toolName = "test-tool";
const toolArgs = { text: "original arguments" };

afterEach(() => vi.unstubAllGlobals());

it.each([
  { scenario: "step-up succeeds", retry: true, passed: true },
  {
    scenario: "metadata is on another public origin",
    retry: true,
    passed: true,
  },
  {
    scenario: "metadata points at a private origin",
    retry: false,
    passed: false,
  },
  { scenario: "step-up is refused again", retry: true, passed: false },
  { scenario: "an unrelated 403", retry: false, passed: false },
  { scenario: "the challenge adds no scope", retry: false, passed: false },
  { scenario: "the issuer changes", retry: false, passed: false },
  { scenario: "the user declines step-up", retry: false, passed: false },
])("$scenario", async ({ scenario, retry, passed }) => {
  const declined = scenario === "the user declines step-up";
  const authorizations: URL[] = [];
  const calls: { token: string | null; params: unknown }[] = [];
  const challengedMetadataUrl =
    scenario === "metadata is on another public origin"
      ? "https://metadata.example.com/resource"
      : scenario === "metadata points at a private origin"
        ? "http://127.0.0.1/resource"
        : metadataUrl;
  let fetchedCrossOriginMetadata = false;
  let fetchedPrivateMetadata = false;
  let registrations = 0;
  let tokenExchanges = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "http://127.0.0.1/resource") fetchedPrivateMetadata = true;
    if (
      url === metadataUrl ||
      url === "https://metadata.example.com/resource"
    ) {
      if (url !== metadataUrl) {
        fetchedCrossOriginMetadata = true;
        expect(new Headers(init?.headers).get("Authorization")).toBeNull();
      }
      return Response.json({
        resource: server,
        authorization_servers: [
          calls.length && scenario === "the issuer changes"
            ? nextIssuer
            : issuer,
        ],
      });
    }
    for (const authServer of [issuer, nextIssuer]) {
      if (url === authServer + "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: authServer,
          authorization_endpoint: authServer + "/authorize",
          token_endpoint: authServer + "/token",
          registration_endpoint: authServer + "/register",
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        });
      }
    }
    if (url === issuer + "/register") {
      registrations++;
      return Response.json({ client_id: "original-client" }, { status: 201 });
    }
    if (url === issuer + "/token") {
      tokenExchanges++;
      return Response.json({
        access_token:
          tokenExchanges === 1 ? "original-token" : "upgraded-token",
        token_type: "Bearer",
      });
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
    if (!token) {
      return new Response(null, {
        status: 401,
        headers: {
          "WWW-Authenticate": `Bearer scope="mcp:read", resource_metadata="${metadataUrl}"`,
        },
      });
    }
    if (request.method === "server/discover") {
      return reply({
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
      });
    }
    if (request.method === "tools/list") {
      return reply({
        tools: [{ name: toolName, inputSchema: { type: "object" } }],
        ttlMs: 0,
        cacheScope: "private",
      });
    }
    if (request.method !== "tools/call")
      throw new Error("Unexpected MCP method");
    calls.push({ token, params: request.params });
    if (calls.length === 2 && passed) {
      return reply({ content: [{ type: "text", text: "success" }] });
    }
    const scope =
      calls.length === 2
        ? "mcp:admin"
        : scenario === "the challenge adds no scope"
          ? "mcp:read"
          : "mcp:write";
    return new Response(null, {
      status: 403,
      headers:
        scenario === "an unrelated 403"
          ? {}
          : {
              "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="${challengedMetadataUrl}"`,
            },
    });
  };
  vi.stubGlobal("fetch", fetchFn);

  const result = await runOAuthLogin(
    {
      serverUrl: server,
      protocolVersion: "2026-07-28",
      auth: { mode: "headless" },
      fetchFn,
      verification: {
        listTools: true,
        callTool: { name: toolName, params: toolArgs },
      },
    },
    {
      completeHeadlessAuthorization: async ({ authorizationUrl }) => {
        authorizations.push(new URL(authorizationUrl));
        if (declined && authorizations.length === 2)
          throw new Error("User declined additional scopes.");
        return { code: "auth-code" };
      },
    }
  );

  const failedStepUp =
    declined ||
    scenario === "the issuer changes" ||
    scenario === "metadata points at a private origin";
  expect(result.completed).toBe(!failedStepUp);
  if (failedStepUp) {
    expect(result.error?.message).toBeTruthy();
    expect(result.error?.message).toBe(result.verification?.callTool?.error);
  }
  if (declined) {
    expect(result.error?.message).toBe("User declined additional scopes.");
  }
  expect(fetchedCrossOriginMetadata).toBe(
    scenario === "metadata is on another public origin"
  );
  expect(fetchedPrivateMetadata).toBe(false);
  expect(
    result.verification?.listTools?.passed,
    result.verification?.listTools?.error
  ).toBe(true);
  expect(result.verification?.callTool?.passed).toBe(passed);
  expect(registrations).toBe(1);
  expect(tokenExchanges).toBe(retry ? 2 : 1);
  expect(authorizations.map((url) => url.searchParams.get("scope"))).toEqual(
    retry || declined ? ["mcp:read", "mcp:read mcp:write"] : ["mcp:read"]
  );
  expect(calls.map(({ token }) => token)).toEqual(
    retry
      ? ["Bearer original-token", "Bearer upgraded-token"]
      : ["Bearer original-token"]
  );
  for (const { params } of calls) {
    expect(params).toMatchObject({ name: toolName, arguments: toolArgs });
  }
  if (retry) {
    for (const field of ["state", "code_challenge"]) {
      expect(authorizations[1].searchParams.get(field)).toBeTruthy();
      expect(authorizations[1].searchParams.get(field)).not.toBe(
        authorizations[0].searchParams.get(field)
      );
    }
    expect(result.credentials.accessToken).toBe("upgraded-token");
  }
  if (scenario === "the issuer changes") {
    expect(result.verification?.callTool?.error).toMatch(/original issuer/);
  }
});
