import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { runXaaFlow } from "../../src/xaa/run-xaa-flow.js";
import {
  getXAAIdpJwks,
  resetXAAIdpKeyPairForTests,
} from "../../src/xaa/mint/keypair.js";

const SERVER_URL = "https://mcp.example.com/mcp";
const AS_ISSUER = "https://auth.example.com";
const TOKEN_ENDPOINT = "https://auth.example.com/oauth/token";
const ISSUER_BASE = "https://issuer.example.com/api/mcp";
const ISSUER = `${ISSUER_BASE}/xaa`;
const ISSUER_METADATA = `${ISSUER}/.well-known/openid-configuration`;
const ISSUER_JWKS = `${ISSUER}/.well-known/jwks.json`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

interface StubOptions {
  prm?: unknown;
  asMetadata?: unknown;
  token?: { status: number; body: unknown };
  tokenResponses?: Array<{ status: number; body: unknown }>;
  mcpStatus?: number;
  mcpBody?: unknown;
  issuerMetadata?: unknown;
  issuerJwks?: unknown;
}

type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

function publishedIssuerResponse(
  url: string,
  options: Pick<StubOptions, "issuerMetadata" | "issuerJwks"> = {}
): Response | undefined {
  if (url === ISSUER_METADATA) {
    return json(
      options.issuerMetadata ?? { issuer: ISSUER, jwks_uri: ISSUER_JWKS }
    );
  }
  if (url === ISSUER_JWKS) {
    return json(options.issuerJwks ?? getXAAIdpJwks());
  }
  return undefined;
}

function withPublishedIssuer(
  implementation: FetchImplementation,
  options: Pick<StubOptions, "issuerMetadata" | "issuerJwks"> = {}
) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return publishedIssuerResponse(url, options) ?? implementation(input, init);
  });
}

function stubFetch(opts: StubOptions) {
  let tokenResponseIndex = 0;
  return withPublishedIssuer(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method || "GET").toUpperCase();
      if (url.includes(".well-known/oauth-protected-resource")) {
        return opts.prm ? json(opts.prm) : json({}, 404);
      }
      if (
        url.includes(".well-known/oauth-authorization-server") ||
        url.includes(".well-known/openid-configuration")
      ) {
        return opts.asMetadata ? json(opts.asMetadata) : json({}, 404);
      }
      if (url === TOKEN_ENDPOINT && method === "POST") {
        const queued = opts.tokenResponses?.[tokenResponseIndex++];
        const t = queued ?? opts.token ?? { status: 200, body: {} };
        return json(t.body, t.status);
      }
      if (url === SERVER_URL && method === "POST") {
        return json(
          opts.mcpBody ?? {
            jsonrpc: "2.0",
            id: "mcpjam-xaa-cli",
            result: { protocolVersion: "2025-11-25", serverInfo: {} },
          },
          opts.mcpStatus ?? 200
        );
      }
      return json({}, 404);
    },
    opts
  );
}

describe("runXaaFlow", () => {
  const originalKeyDir = process.env.XAA_IDP_KEY_DIR;
  const originalFetch = global.fetch;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-flow-"));
    process.env.XAA_IDP_KEY_DIR = tempDir;
    resetXAAIdpKeyPairForTests();
  });

  afterEach(() => {
    resetXAAIdpKeyPairForTests();
    rmSync(tempDir, { recursive: true, force: true });
    global.fetch = originalFetch;
    if (originalKeyDir === undefined) delete process.env.XAA_IDP_KEY_DIR;
    else process.env.XAA_IDP_KEY_DIR = originalKeyDir;
  });

  it("drives a valid flow to completion against a trusting AS", async () => {
    global.fetch = stubFetch({
      token: {
        status: 200,
        body: { access_token: "at-123", token_type: "Bearer", expires_in: 300 },
      },
    }) as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      authzServerIssuer: AS_ISSUER,
      tokenEndpoint: TOKEN_ENDPOINT,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      email: "u@example.com",
      clientId: "client-1",
      scope: "read:tools",
    });

    expect(result.completed).toBe(true);
    expect(result.issuer).toBe("https://issuer.example.com/api/mcp/xaa");
    expect(result.idJag?.verified).toBe(true);
    expect(result.idJag?.claims).toMatchObject({
      iss: "https://issuer.example.com/api/mcp/xaa",
      sub: "user-1",
      aud: AS_ISSUER,
      resource: "https://mcp.example.com/mcp",
      client_id: "client-1",
    });
    expect(result.redemption?.tokenIssued).toBe(true);
    expect(result.mcp?.ok).toBe(true);
  });

  it("discovers the AS + token endpoint when not supplied", async () => {
    global.fetch = stubFetch({
      prm: {
        resource: "https://mcp.example.com/mcp",
        authorization_servers: [AS_ISSUER],
      },
      asMetadata: { issuer: AS_ISSUER, token_endpoint: TOKEN_ENDPOINT },
      token: {
        status: 200,
        body: { access_token: "at-xyz", token_type: "Bearer" },
      },
    }) as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      clientId: "client-1",
    });

    expect(result.authzServerIssuer).toBe(AS_ISSUER);
    expect(result.tokenEndpoint).toBe(TOKEN_ENDPOINT);
    expect(result.completed).toBe(true);
  });

  it("does not report completion when the MCP init returns a 200 JSON-RPC error", async () => {
    global.fetch = stubFetch({
      token: {
        status: 200,
        body: { access_token: "at-123", token_type: "Bearer" },
      },
      mcpStatus: 200,
      mcpBody: {
        jsonrpc: "2.0",
        id: "mcpjam-xaa-cli",
        error: { code: -32001, message: "Unauthorized" },
      },
    }) as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      authzServerIssuer: AS_ISSUER,
      tokenEndpoint: TOKEN_ENDPOINT,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      clientId: "client-1",
    });

    expect(result.redemption?.tokenIssued).toBe(true); // token was still issued
    expect(result.mcp?.status).toBe(200);
    expect(result.mcp?.ok).toBe(false);
    expect(result.mcp?.error).toBe("-32001: Unauthorized");
    expect(result.completed).toBe(false);
  });

  it("does not report success on a 2xx body with no JSON-RPC result", async () => {
    global.fetch = stubFetch({
      token: {
        status: 200,
        body: { access_token: "at-123", token_type: "Bearer" },
      },
      // A 2xx non-MCP body: neither error nor a JSON-RPC `result`.
      mcpBody: { status: "ok" },
    }) as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      authzServerIssuer: AS_ISSUER,
      tokenEndpoint: TOKEN_ENDPOINT,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      clientId: "client-1",
    });

    expect(result.redemption?.tokenIssued).toBe(true);
    expect(result.mcp?.ok).toBe(false);
    expect(result.mcp?.error).toMatch(/initialize result/i);
    expect(result.completed).toBe(false);
  });

  it("rejects an initialize result that negotiates a different protocol version", async () => {
    global.fetch = stubFetch({
      token: {
        status: 200,
        body: { access_token: "at-123", token_type: "Bearer" },
      },
      mcpBody: {
        jsonrpc: "2.0",
        id: "mcpjam-xaa-cli",
        result: { protocolVersion: "2025-06-18", capabilities: {} },
      },
    }) as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      authzServerIssuer: AS_ISSUER,
      tokenEndpoint: TOKEN_ENDPOINT,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      clientId: "client-1",
    });

    expect(result.mcp?.ok).toBe(false);
    expect(result.mcp?.error).toMatch(/2025-06-18.*expected 2025-11-25/i);
    expect(result.completed).toBe(false);
  });

  it("advertises the XAA extension on the MCP initialize probe", async () => {
    let mcpHeaders: Record<string, string> = {};
    let mcpRequest: Record<string, unknown> | undefined;
    global.fetch = withPublishedIssuer(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method || "GET").toUpperCase();
        if (url === TOKEN_ENDPOINT && method === "POST") {
          return json({ access_token: "at-1", token_type: "Bearer" });
        }
        if (url === SERVER_URL && method === "POST") {
          mcpHeaders = (init?.headers as Record<string, string>) ?? {};
          mcpRequest = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          return json({
            jsonrpc: "2.0",
            id: "mcpjam-xaa-cli",
            result: {
              protocolVersion: "2025-11-25",
              capabilities: {
                extensions: {
                  "io.modelcontextprotocol/enterprise-managed-authorization":
                    {},
                },
              },
            },
          });
        }
        return json({}, 404);
      }
    ) as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      authzServerIssuer: AS_ISSUER,
      tokenEndpoint: TOKEN_ENDPOINT,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      clientId: "client-1",
    });

    expect(result.completed).toBe(true);
    expect(
      mcpHeaders["MCP-Protocol-Version"] ?? mcpHeaders["mcp-protocol-version"]
    ).toBe("2025-11-25");
    expect(mcpRequest).toMatchObject({
      params: {
        capabilities: {
          extensions: {
            "io.modelcontextprotocol/enterprise-managed-authorization": {},
          },
        },
      },
    });
    expect(result.mcp?.xaaExtension).toBe("advertised");
  });

  it("does not report success on a non-MCP 2xx body that merely has a result field", async () => {
    global.fetch = stubFetch({
      token: {
        status: 200,
        body: { access_token: "at-123", token_type: "Bearer" },
      },
      // A `result` field but no JSON-RPC envelope (wrong/absent jsonrpc + id).
      mcpBody: { result: { anything: true } },
    }) as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      authzServerIssuer: AS_ISSUER,
      tokenEndpoint: TOKEN_ENDPOINT,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      clientId: "client-1",
    });

    expect(result.mcp?.ok).toBe(false);
    expect(result.mcp?.error).toMatch(/initialize result/i);
    expect(result.completed).toBe(false);
  });

  it("preserves the trailing slash when building PRM discovery URLs", async () => {
    const serverWithSlash = "https://mcp.example.com/mcp/";
    const insertionPrm =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp/";
    global.fetch = withPublishedIssuer(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method || "GET").toUpperCase();
        // PRM is published ONLY at the slash-preserving path-insertion URL.
        if (url.includes(".well-known/oauth-protected-resource")) {
          return url === insertionPrm
            ? json({
                resource: "https://mcp.example.com/mcp/",
                authorization_servers: [AS_ISSUER],
              })
            : json({}, 404);
        }
        if (
          url.includes(".well-known/oauth-authorization-server") ||
          url.includes(".well-known/openid-configuration")
        ) {
          return json({ issuer: AS_ISSUER, token_endpoint: TOKEN_ENDPOINT });
        }
        if (url === TOKEN_ENDPOINT && method === "POST") {
          return json({ access_token: "at-1", token_type: "Bearer" });
        }
        if (url === serverWithSlash && method === "POST") {
          return json({
            jsonrpc: "2.0",
            id: "mcpjam-xaa-cli",
            result: { protocolVersion: "2025-11-25" },
          });
        }
        return json({}, 404);
      }
    ) as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: serverWithSlash,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      clientId: "client-1",
    });

    expect(result.authzServerIssuer).toBe(AS_ISSUER);
    expect(result.completed).toBe(true);
  });

  it("discovers PRM served at the origin root for a path resource", async () => {
    const rootPrm =
      "https://mcp.example.com/.well-known/oauth-protected-resource";
    global.fetch = withPublishedIssuer(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method || "GET").toUpperCase();
        // PRM is published ONLY at the origin root, not the path-insertion form.
        if (url.includes(".well-known/oauth-protected-resource")) {
          return url === rootPrm
            ? json({
                resource: "https://mcp.example.com/mcp",
                authorization_servers: [AS_ISSUER],
              })
            : json({}, 404);
        }
        if (
          url.includes(".well-known/oauth-authorization-server") ||
          url.includes(".well-known/openid-configuration")
        ) {
          return json({ issuer: AS_ISSUER, token_endpoint: TOKEN_ENDPOINT });
        }
        if (url === TOKEN_ENDPOINT && method === "POST") {
          return json({ access_token: "at-1", token_type: "Bearer" });
        }
        if (url === SERVER_URL && method === "POST") {
          return json({
            jsonrpc: "2.0",
            id: "mcpjam-xaa-cli",
            result: { protocolVersion: "2025-11-25" },
          });
        }
        return json({}, 404);
      }
    ) as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      clientId: "client-1",
    });

    expect(result.authzServerIssuer).toBe(AS_ISSUER);
    expect(result.completed).toBe(true);
  });

  it("rejects AS metadata whose issuer differs only by a trailing slash", async () => {
    global.fetch = stubFetch({
      asMetadata: { issuer: AS_ISSUER, token_endpoint: TOKEN_ENDPOINT },
      token: {
        status: 200,
        body: { access_token: "at-1", token_type: "Bearer" },
      },
    }) as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      // Trailing slash — the AS advertises the canonical form without it.
      authzServerIssuer: `${AS_ISSUER}/`,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      clientId: "client-1",
    });

    expect(result.authzServerIssuer).toBe(`${AS_ISSUER}/`);
    expect(result.idJag).toBeUndefined();
    expect(result.error).toMatch(/does not match/i);
    expect(result.completed).toBe(false);
  });

  it("tries every advertised authorization server until one resolves", async () => {
    const deadAs = "https://dead-as.example.com";
    global.fetch = withPublishedIssuer(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method || "GET").toUpperCase();
        if (url.includes(".well-known/oauth-protected-resource")) {
          return json({
            resource: "https://mcp.example.com/mcp",
            authorization_servers: [deadAs, AS_ISSUER],
          });
        }
        // The first advertised AS has no discoverable metadata.
        if (url.startsWith(deadAs)) {
          return json({}, 404);
        }
        if (
          url.includes(".well-known/oauth-authorization-server") ||
          url.includes(".well-known/openid-configuration")
        ) {
          return json({ issuer: AS_ISSUER, token_endpoint: TOKEN_ENDPOINT });
        }
        if (url === TOKEN_ENDPOINT && method === "POST") {
          return json({ access_token: "at-1", token_type: "Bearer" });
        }
        if (url === SERVER_URL && method === "POST") {
          return json({
            jsonrpc: "2.0",
            id: "mcpjam-xaa-cli",
            result: { protocolVersion: "2025-11-25" },
          });
        }
        return json({}, 404);
      }
    ) as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      clientId: "client-1",
    });

    expect(result.authzServerIssuer).toBe(AS_ISSUER);
    expect(result.completed).toBe(true);
  });

  it("rejects PRM whose resource does not identify the requested server", async () => {
    global.fetch = stubFetch({
      prm: {
        // Wrong resource — must not be trusted to source the AS (RFC 9728).
        resource: "https://other.example.com/mcp",
        authorization_servers: [AS_ISSUER],
      },
      asMetadata: { issuer: AS_ISSUER, token_endpoint: TOKEN_ENDPOINT },
    }) as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      clientId: "client-1",
    });

    expect(result.completed).toBe(false);
    expect(result.authzServerIssuer).toBeUndefined();
    expect(result.error).toMatch(/protected-resource metadata/i);
  });

  it("preserves a meaningful trailing slash in the canonical resource", async () => {
    const serverWithSlash = "https://mcp.example.com/mcp/";
    global.fetch = withPublishedIssuer(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method || "GET").toUpperCase();
        if (url === TOKEN_ENDPOINT && method === "POST") {
          return json({ access_token: "at-1", token_type: "Bearer" });
        }
        if (url === serverWithSlash && method === "POST") {
          return json({
            jsonrpc: "2.0",
            id: "mcpjam-xaa-cli",
            result: { protocolVersion: "2025-11-25" },
          });
        }
        return json({}, 404);
      }
    ) as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: serverWithSlash,
      authzServerIssuer: AS_ISSUER,
      tokenEndpoint: TOKEN_ENDPOINT,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      clientId: "client-1",
    });

    expect(result.idJag?.claims.resource).toBe("https://mcp.example.com/mcp/");
    expect(result.completed).toBe(true);
  });

  it("treats a top-level error string (SSE parse failure) as a failed call", async () => {
    global.fetch = withPublishedIssuer(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method || "GET").toUpperCase();
        if (url === TOKEN_ENDPOINT && method === "POST") {
          return json({ access_token: "at-1", token_type: "Bearer" });
        }
        if (url === SERVER_URL && method === "POST") {
          // The shape executeDebugOAuthProxy returns when it can't parse the SSE
          // stream: a top-level string `error`, no `transport` field.
          return json({ error: "Failed to parse SSE stream" });
        }
        return json({}, 404);
      }
    ) as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      authzServerIssuer: AS_ISSUER,
      tokenEndpoint: TOKEN_ENDPOINT,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      clientId: "client-1",
    });

    expect(result.mcp?.ok).toBe(false);
    expect(result.mcp?.error).toBe("Failed to parse SSE stream");
    expect(result.completed).toBe(false);
  });

  it("rejects AS metadata whose issuer does not match the requested issuer", async () => {
    global.fetch = stubFetch({
      prm: {
        resource: "https://mcp.example.com/mcp",
        authorization_servers: [AS_ISSUER],
      },
      // Mismatched issuer — must not be trusted to source the token endpoint.
      asMetadata: {
        issuer: "https://evil.example.com",
        token_endpoint: "https://evil.example.com/token",
      },
    }) as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      clientId: "client-1",
    });

    expect(result.completed).toBe(false);
    expect(result.tokenEndpoint).toBeUndefined();
    expect(result.error).toMatch(/token endpoint/i);
  });

  it("preserves the query string in the canonical resource", async () => {
    const serverWithQuery = "https://mcp.example.com/mcp?tenant=acme";
    global.fetch = withPublishedIssuer(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method || "GET").toUpperCase();
        if (url === TOKEN_ENDPOINT && method === "POST") {
          return json({ access_token: "at-1", token_type: "Bearer" });
        }
        if (url === serverWithQuery && method === "POST") {
          return json({
            jsonrpc: "2.0",
            id: "mcpjam-xaa-cli",
            result: { protocolVersion: "2025-11-25" },
          });
        }
        return json({}, 404);
      }
    ) as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: serverWithQuery,
      authzServerIssuer: AS_ISSUER,
      tokenEndpoint: TOKEN_ENDPOINT,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      clientId: "client-1",
    });

    expect(result.idJag?.claims.resource).toBe(
      "https://mcp.example.com/mcp?tenant=acme"
    );
    expect(result.completed).toBe(true);
  });

  it("detects a JSON-RPC error delivered over SSE from the MCP init", async () => {
    const sse =
      "event: message\n" +
      "data: " +
      JSON.stringify({
        jsonrpc: "2.0",
        id: "mcpjam-xaa-cli",
        error: { code: -32002, message: "Server error" },
      }) +
      "\n\n";
    global.fetch = withPublishedIssuer(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = (init?.method || "GET").toUpperCase();
        if (url === TOKEN_ENDPOINT && method === "POST") {
          return json({ access_token: "at-1", token_type: "Bearer" });
        }
        if (url === SERVER_URL && method === "POST") {
          return new Response(sse, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        return json({}, 404);
      }
    ) as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      authzServerIssuer: AS_ISSUER,
      tokenEndpoint: TOKEN_ENDPOINT,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      clientId: "client-1",
    });

    expect(result.redemption?.tokenIssued).toBe(true);
    expect(result.mcp?.ok).toBe(false);
    expect(result.mcp?.error).toBe("-32002: Server error");
    expect(result.completed).toBe(false);
  });

  it("reports a redemption failure without crashing", async () => {
    global.fetch = stubFetch({
      token: {
        status: 400,
        body: {
          error: "unsupported_grant_type",
          error_description: "jwt-bearer not supported",
        },
      },
    }) as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      authzServerIssuer: AS_ISSUER,
      tokenEndpoint: TOKEN_ENDPOINT,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      clientId: "client-1",
    });

    expect(result.completed).toBe(false);
    expect(result.idJag?.verified).toBe(true); // mint + inspect still succeeded
    expect(result.redemption?.tokenIssued).toBe(false);
    expect(result.redemption?.status).toBe(400);
    expect(result.redemption?.error).toContain("jwt-bearer not supported");
    expect(result.mcp).toBeUndefined();
  });

  it("fails before redemption when the issuer publishes a different key", async () => {
    const fetchMock = stubFetch({
      issuerJwks: {
        keys: [{ kid: "xaa-idp-1", kty: "RSA", n: "different", e: "AQAB" }],
      },
      token: {
        status: 200,
        body: { access_token: "must-not-be-issued", token_type: "Bearer" },
      },
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      authzServerIssuer: AS_ISSUER,
      tokenEndpoint: TOKEN_ENDPOINT,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      clientId: "client-1",
    });

    expect(result.completed).toBe(false);
    expect(result.error).toMatch(/does not publish the local signing key/i);
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          input.toString() === TOKEN_ENDPOINT && init?.method === "POST"
      )
    ).toBe(false);
  });

  it("infers client_secret_basic and surfaces advertised RAS support", async () => {
    let tokenHeaders: Record<string, string> = {};
    let tokenBody = "";
    global.fetch = withPublishedIssuer(async (input, init) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes(".well-known/oauth-protected-resource")) {
        return json({
          resource: SERVER_URL,
          authorization_servers: [AS_ISSUER],
        });
      }
      if (
        url.startsWith(AS_ISSUER) &&
        (url.includes(".well-known/oauth-authorization-server") ||
          url.includes(".well-known/openid-configuration"))
      ) {
        return json({
          issuer: AS_ISSUER,
          token_endpoint: TOKEN_ENDPOINT,
          grant_types_supported: [
            "urn:ietf:params:oauth:grant-type:jwt-bearer",
          ],
          authorization_grant_profiles_supported: [
            "urn:ietf:params:oauth:grant-profile:id-jag",
          ],
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
        });
      }
      if (url === TOKEN_ENDPOINT && method === "POST") {
        tokenHeaders = (init?.headers as Record<string, string>) ?? {};
        tokenBody = String(init?.body);
        return json({ access_token: "at-basic", token_type: "Bearer" });
      }
      if (url === SERVER_URL && method === "POST") {
        return json({
          jsonrpc: "2.0",
          id: "mcpjam-xaa-cli",
          result: { protocolVersion: "2025-11-25" },
        });
      }
      return json({}, 404);
    }) as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      clientId: "client id!",
      clientSecret: "secret (value)",
    });

    expect(result.completed).toBe(true);
    expect(tokenHeaders.Authorization).toMatch(/^Basic /);
    expect(tokenBody).not.toContain("client_secret");
    expect(tokenBody).not.toContain("client_id");
    expect(result.authorizationServerCapabilities).toMatchObject({
      idJagProfile: "advertised",
      jwtBearerGrant: "advertised",
      selectedTokenEndpointAuthMethod: "client_secret_basic",
    });
  });

  it("honors the per-request timeout", async () => {
    global.fetch = withPublishedIssuer(async (input, init) => {
      if (input.toString() === TOKEN_ENDPOINT) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason);
          });
        });
      }
      return json({}, 404);
    }) as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      authzServerIssuer: AS_ISSUER,
      tokenEndpoint: TOKEN_ENDPOINT,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      clientId: "client-1",
      timeoutMs: 10,
    });

    expect(result.completed).toBe(false);
    expect(result.error).toMatch(/timeout/i);
  });

  it("scores a negative-test rejection only after a valid baseline", async () => {
    global.fetch = stubFetch({
      tokenResponses: [
        {
          status: 200,
          body: { access_token: "baseline-token", token_type: "Bearer" },
        },
        { status: 401, body: { error: "invalid_grant" } },
      ],
    }) as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      authzServerIssuer: AS_ISSUER,
      tokenEndpoint: TOKEN_ENDPOINT,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      clientId: "client-1",
      negativeTestMode: "bad_signature",
    });

    // bad_signature can't verify locally, and the AS rejects it.
    expect(result.idJag?.verified).toBe(false);
    expect(result.redemption?.tokenIssued).toBe(false);
    expect(result.negativeProbe).toMatchObject({
      baselineAccepted: true,
      outcome: "rejected",
    });
    expect(result.completed).toBe(true);
    expect(result.mcp).toBeUndefined();
  });

  it("fails a negative probe when the AS accepts the broken assertion", async () => {
    const fetchMock = stubFetch({
      tokenResponses: [
        {
          status: 200,
          body: { access_token: "baseline-token", token_type: "Bearer" },
        },
        {
          status: 200,
          body: { access_token: "invalid-token", token_type: "Bearer" },
        },
      ],
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      authzServerIssuer: AS_ISSUER,
      tokenEndpoint: TOKEN_ENDPOINT,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      clientId: "client-1",
      negativeTestMode: "bad_signature",
    });

    expect(result.completed).toBe(false);
    expect(result.negativeProbe?.outcome).toBe("accepted");
    expect(result.error).toMatch(/accepted the deliberately invalid/i);
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          input.toString() === SERVER_URL && init?.method === "POST"
      )
    ).toBe(false);
  });

  it("reports steps in ID-JAG spec vocabulary for a valid flow", async () => {
    global.fetch = stubFetch({
      token: {
        status: 200,
        body: { access_token: "at-123", token_type: "Bearer", expires_in: 300 },
      },
    }) as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      authzServerIssuer: AS_ISSUER,
      tokenEndpoint: TOKEN_ENDPOINT,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      clientId: "client-1",
    });

    const stepNames = result.steps.map((s) => s.step);
    expect(stepNames).toContain("verify_issuer_publication");
    expect(stepNames).toContain("mint_id_jag");
    expect(stepNames).toContain("redeem_id_jag");
    expect(stepNames).toContain("authenticated_mcp_request");
    // The engine's internal HTTP-step names must not leak into CLI output.
    expect(stepNames).not.toContain("token_exchange_request");
    expect(stepNames).not.toContain("jwt_bearer_request");
  });

  it("prefixes and renames baseline/probe steps in a negative flow", async () => {
    global.fetch = stubFetch({
      tokenResponses: [
        {
          status: 200,
          body: { access_token: "baseline-token", token_type: "Bearer" },
        },
        { status: 401, body: { error: "invalid_grant" } },
      ],
    }) as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: SERVER_URL,
      authzServerIssuer: AS_ISSUER,
      tokenEndpoint: TOKEN_ENDPOINT,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      clientId: "client-1",
      negativeTestMode: "bad_signature",
    });

    const stepNames = result.steps.map((s) => s.step);
    expect(stepNames).toContain("baseline:mint_id_jag");
    expect(stepNames).toContain("baseline:redeem_id_jag");
    expect(stepNames).toContain("probe:mint_id_jag");
    expect(stepNames).toContain("probe:redeem_id_jag");
    expect(stepNames).not.toContain("baseline:token_exchange_request");
    expect(stepNames).not.toContain("probe:jwt_bearer_request");
  });
});
