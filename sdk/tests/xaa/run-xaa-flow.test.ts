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
        { jsonrpc: "2.0", id: "mcpjam-xaa-cli", result: { serverInfo: {} } },
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
      prm: { authorization_servers: [AS_ISSUER] },
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
