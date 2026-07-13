import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { runXaaFlow } from "../../src/xaa/run-xaa-flow.js";
import { resetXAAIdpKeyPairForTests } from "../../src/xaa/mint/keypair.js";

const SERVER_URL = "https://mcp.example.com/mcp";
const AS_ISSUER = "https://auth.example.com";
const TOKEN_ENDPOINT = "https://auth.example.com/oauth/token";
const ISSUER_BASE = "https://issuer.example.com/api/mcp";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

interface StubOptions {
  prm?: unknown;
  asMetadata?: unknown;
  token?: { status: number; body: unknown };
  mcpStatus?: number;
  mcpBody?: unknown;
}

function stubFetch(opts: StubOptions) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
      const t = opts.token ?? { status: 200, body: {} };
      return json(t.body, t.status);
    }
    if (url === SERVER_URL && method === "POST") {
      return json(
        opts.mcpBody ?? {
          jsonrpc: "2.0",
          id: "mcpjam-xaa-cli",
          result: { serverInfo: {} },
        },
        opts.mcpStatus ?? 200,
      );
    }
    return json({}, 404);
  });
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

  it("sends the MCP-Protocol-Version header on the initialize probe", async () => {
    let mcpHeaders: Record<string, string> = {};
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method || "GET").toUpperCase();
      if (url === TOKEN_ENDPOINT && method === "POST") {
        return json({ access_token: "at-1", token_type: "Bearer" });
      }
      if (url === SERVER_URL && method === "POST") {
        mcpHeaders = (init?.headers as Record<string, string>) ?? {};
        return json({ jsonrpc: "2.0", id: "mcpjam-xaa-cli", result: {} });
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
    });

    expect(result.completed).toBe(true);
    expect(mcpHeaders["MCP-Protocol-Version"]).toBe("2025-11-25");
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

  it("discovers PRM served at the origin root for a path resource", async () => {
    const rootPrm =
      "https://mcp.example.com/.well-known/oauth-protected-resource";
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
        return json({ jsonrpc: "2.0", id: "mcpjam-xaa-cli", result: {} });
      }
      return json({}, 404);
    }) as unknown as typeof fetch;

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
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method || "GET").toUpperCase();
      if (url === TOKEN_ENDPOINT && method === "POST") {
        return json({ access_token: "at-1", token_type: "Bearer" });
      }
      if (url === serverWithSlash && method === "POST") {
        return json({ jsonrpc: "2.0", id: "mcpjam-xaa-cli", result: {} });
      }
      return json({}, 404);
    }) as unknown as typeof fetch;

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
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method || "GET").toUpperCase();
      if (url === TOKEN_ENDPOINT && method === "POST") {
        return json({ access_token: "at-1", token_type: "Bearer" });
      }
      if (url === serverWithQuery && method === "POST") {
        return json({ jsonrpc: "2.0", id: "mcpjam-xaa-cli", result: {} });
      }
      return json({}, 404);
    }) as unknown as typeof fetch;

    const result = await runXaaFlow({
      serverUrl: serverWithQuery,
      authzServerIssuer: AS_ISSUER,
      tokenEndpoint: TOKEN_ENDPOINT,
      issuerBaseUrl: ISSUER_BASE,
      subject: "user-1",
      clientId: "client-1",
    });

    expect(result.idJag?.claims.resource).toBe(
      "https://mcp.example.com/mcp?tenant=acme",
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
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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

  it("a negative-test ID-JAG fails local inspection but is still sent", async () => {
    global.fetch = stubFetch({
      token: { status: 401, body: { error: "invalid_grant" } },
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
    expect(result.completed).toBe(false);
  });
});
