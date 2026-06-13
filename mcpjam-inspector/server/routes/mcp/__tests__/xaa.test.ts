import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { securityHeadersMiddleware } from "../../../middleware/security-headers.js";
import { originValidationMiddleware } from "../../../middleware/origin-validation.js";
import { sessionAuthMiddleware } from "../../../middleware/session-auth.js";
import {
  generateSessionToken,
  getSessionToken,
} from "../../../services/session-token.js";
import {
  initXAAIdpKeyPair,
  resetXAAIdpKeyPairForTests,
} from "../../../services/xaa-idp-keypair.js";
import xaa, { createXaaRouter } from "../xaa.js";

function jsonResponse(
  body: unknown,
  init?: { status?: number; contentType?: string },
): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      "content-type": init?.contentType ?? "application/json",
    },
  });
}

function decodeJwtPayload(token: string): Record<string, any> {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
}

describe("mcp xaa routes", () => {
  const originalKeyDir = process.env.XAA_IDP_KEY_DIR;
  let tempDir: string;
  let app: Hono;
  let token: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-route-"));
    process.env.XAA_IDP_KEY_DIR = tempDir;
    resetXAAIdpKeyPairForTests();
    initXAAIdpKeyPair();
    token = generateSessionToken();

    app = new Hono();
    app.use("*", securityHeadersMiddleware);
    app.use("*", originValidationMiddleware);
    app.use("*", sessionAuthMiddleware);
    app.route("/api/mcp/xaa", xaa);
  });

  afterEach(() => {
    resetXAAIdpKeyPairForTests();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalKeyDir === undefined) {
      delete process.env.XAA_IDP_KEY_DIR;
    } else {
      process.env.XAA_IDP_KEY_DIR = originalKeyDir;
    }
  });

  it("serves JWKS publicly without a session token", async () => {
    const response = await app.request("/api/mcp/xaa/.well-known/jwks.json");

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].kid).toBe("xaa-idp-1");
  });

  it("serves the discovery document publicly without a session token", async () => {
    const response = await app.request(
      "http://localhost/api/mcp/xaa/.well-known/openid-configuration",
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.issuer).toBe("http://localhost/api/mcp/xaa");
    expect(body.jwks_uri).toBe(
      "http://localhost/api/mcp/xaa/.well-known/jwks.json",
    );
  });

  it("ignores forwarded proxy headers for the local router", async () => {
    // The local desktop router has no proxy in front of it, so a spoofed
    // X-Forwarded-Proto must not flip the issuer to https.
    const response = await app.request(
      "http://localhost/api/mcp/xaa/.well-known/openid-configuration",
      {
        headers: {
          "x-forwarded-proto": "https",
          "x-forwarded-host": "evil.example.com",
        },
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.issuer).toBe("http://localhost/api/mcp/xaa");
    expect(body.jwks_uri).toBe(
      "http://localhost/api/mcp/xaa/.well-known/jwks.json",
    );
  });

  it("requires a session token for protected endpoints", async () => {
    const response = await app.request("/api/mcp/xaa/authenticate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-12345" }),
    });

    expect(response.status).toBe(401);
  });

  it("authenticates and exchanges an ID token for a broken ID-JAG", async () => {
    const headers = {
      "Content-Type": "application/json",
      "X-MCP-Session-Auth": `Bearer ${getSessionToken() || token}`,
    };

    const authenticateResponse = await app.request("/api/mcp/xaa/authenticate", {
      method: "POST",
      headers,
      body: JSON.stringify({
        userId: "user-12345",
        email: "demo.user@example.com",
      }),
    });

    expect(authenticateResponse.status).toBe(200);
    const authenticateBody = await authenticateResponse.json();
    expect(authenticateBody.id_token).toEqual(expect.any(String));

    const tokenExchangeResponse = await app.request("/api/mcp/xaa/token-exchange", {
      method: "POST",
      headers,
      body: JSON.stringify({
        identityAssertion: authenticateBody.id_token,
        audience: "https://auth.example.com",
        resource: "https://mcp.example.com",
        clientId: "mcpjam-debugger",
        negativeTestMode: "wrong_audience",
      }),
    });

    expect(tokenExchangeResponse.status).toBe(200);
    const tokenExchangeBody = await tokenExchangeResponse.json();
    const payload = decodeJwtPayload(tokenExchangeBody.id_jag);
    expect(payload.aud).toBe("https://wrong-audience.example.com");
  });

  describe("POST /discover-as", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function authHeaders() {
      return {
        "Content-Type": "application/json",
        "X-MCP-Session-Auth": `Bearer ${getSessionToken() || token}`,
      };
    }

    it("resolves metadata via the root well-known form", async () => {
      const fetchMock = vi.fn(async (input: string | URL) => {
        const url = input.toString();
        if (url === "https://as.example.com/.well-known/openid-configuration") {
          return jsonResponse({
            issuer: "https://as.example.com",
            token_endpoint: "https://as.example.com/oauth/token",
            grant_types_supported: [
              "urn:ietf:params:oauth:grant-type:jwt-bearer",
            ],
          });
        }
        return new Response(null, { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const response = await app.request("/api/mcp/xaa/discover-as", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ issuer: "https://as.example.com" }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.issuer).toBe("https://as.example.com");
      expect(body.jwtBearerSupport).toBe("pass");
      expect(body.hasTokenEndpoint).toBe(true);
      expect(body.issuerMismatch).toBeNull();
    });

    it("resolves metadata via the path-insertion well-known form", async () => {
      const fetchMock = vi.fn(async (input: string | URL) => {
        const url = input.toString();
        if (
          url ===
          "https://login.example.com/.well-known/openid-configuration/realms/acme"
        ) {
          return jsonResponse({
            issuer: "https://login.example.com/realms/acme",
            token_endpoint:
              "https://login.example.com/realms/acme/protocol/openid-connect/token",
            grant_types_supported: [
              "urn:ietf:params:oauth:grant-type:jwt-bearer",
            ],
          });
        }
        return new Response(null, { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const response = await app.request("/api/mcp/xaa/discover-as", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          issuer: "https://login.example.com/realms/acme",
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.issuer).toBe("https://login.example.com/realms/acme");
      expect(body.jwtBearerSupport).toBe("pass");
    });

    it("reports a scheme-only issuer mismatch", async () => {
      const fetchMock = vi.fn(async () =>
        jsonResponse({
          issuer: "http://as.example.com",
          token_endpoint: "http://as.example.com/oauth/token",
          grant_types_supported: [
            "urn:ietf:params:oauth:grant-type:jwt-bearer",
          ],
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const response = await app.request("/api/mcp/xaa/discover-as", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ issuer: "https://as.example.com" }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.issuerMismatch).toMatchObject({
        requested: "https://as.example.com",
        advertised: "http://as.example.com",
        schemeOnly: true,
      });
    });

    it("returns 404 when no well-known endpoint has metadata", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 404 })),
      );

      const response = await app.request("/api/mcp/xaa/discover-as", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ issuer: "https://as.example.com" }),
      });

      expect(response.status).toBe(404);
    });
  });
});

describe("hosted xaa outbound guards", () => {
  const originalKeyDir = process.env.XAA_IDP_KEY_DIR;
  let tempDir: string;
  let app: Hono;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-hosted-route-"));
    process.env.XAA_IDP_KEY_DIR = tempDir;
    resetXAAIdpKeyPairForTests();
    initXAAIdpKeyPair();

    // Hosted-mode router: httpsOnlyProxy rejects http + private/reserved hosts.
    // No protected middlewares here so the test exercises the guard directly.
    app = new Hono();
    app.route(
      "/api/web/xaa",
      createXaaRouter({
        issuerBasePath: "/api/web",
        httpsOnlyProxy: true,
        trustForwardedHeaders: true,
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetXAAIdpKeyPairForTests();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalKeyDir === undefined) {
      delete process.env.XAA_IDP_KEY_DIR;
    } else {
      process.env.XAA_IDP_KEY_DIR = originalKeyDir;
    }
  });

  it("rejects discovery against a reserved internal address", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.request("/api/web/xaa/discover-as", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issuer: "https://169.254.169.254" }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.message).toBe("URL not allowed");
    // The guard rejects before any outbound fetch is attempted.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an http health-check target in hosted mode", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.request("/api/web/xaa/health-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "http://example.com/health" }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.message).toBe("URL not allowed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not follow a health-check redirect to an internal address", async () => {
    // redirect: manual means the 3xx is returned without being followed, so
    // the internal Location is never fetched.
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.request("/api/web/xaa/health-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Public literal IP: passes validateUrl (IP literals skip DNS) without a
      // real network lookup.
      body: JSON.stringify({ url: "https://93.184.216.34/health" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("redirect_not_followed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("registration-backed /proxy/token", () => {
  const originalKeyDir = process.env.XAA_IDP_KEY_DIR;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-reg-proxy-"));
    process.env.XAA_IDP_KEY_DIR = tempDir;
    resetXAAIdpKeyPairForTests();
    initXAAIdpKeyPair();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetXAAIdpKeyPairForTests();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalKeyDir === undefined) {
      delete process.env.XAA_IDP_KEY_DIR;
    } else {
      process.env.XAA_IDP_KEY_DIR = originalKeyDir;
    }
  });

  function buildApp(options: {
    resolver?: (args: {
      registrationId: string;
      bearerToken: string;
    }) => Promise<{
      clientSecret: string;
      tokenEndpoint: string | null;
      targetClientId: string | null;
      scopes: string[] | null;
    }>;
  }) {
    const app = new Hono();
    app.route(
      "/api/web/xaa",
      createXaaRouter({
        issuerBasePath: "/api/web",
        httpsOnlyProxy: false,
        resolveRegistrationSecret: options.resolver,
      }),
    );
    return app;
  }

  it("rejects registrationId on an instance without a secret resolver", async () => {
    const app = buildApp({});

    const response = await app.request("/api/web/xaa/proxy/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        registrationId: "app_1",
        assertion: "aaa.bbb.ccc",
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { message?: string };
    expect(body.message).toContain("not available");
  });

  it("requires a bearer token before resolving the secret", async () => {
    const resolver = vi.fn();
    const app = buildApp({ resolver });

    const response = await app.request("/api/web/xaa/proxy/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        registrationId: "app_1",
        assertion: "aaa.bbb.ccc",
      }),
    });

    expect(response.status).toBe(401);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("forces the stored token endpoint and strips client-supplied endpoint/headers/secret", async () => {
    const resolver = vi.fn(async () => ({
      clientSecret: "stored-secret",
      tokenEndpoint: "https://stored-as.example.com/oauth/token",
      targetClientId: "stored-client-id",
      scopes: null,
    }));
    const app = buildApp({ resolver });

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: "tok", token_type: "Bearer" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.request("/api/web/xaa/proxy/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        registrationId: "app_1",
        assertion: "aaa.bbb.ccc",
        // A caller must not be able to redirect the stored secret or smuggle
        // headers/credentials alongside it.
        tokenEndpoint: "https://attacker.example.com/exfil",
        headers: { "X-Evil": "1" },
        clientSecret: "attacker-secret",
        clientId: "attacker-client-id",
        scope: "read:tools",
        resource: "https://mcp.example.com",
      }),
    });

    expect(response.status).toBe(200);
    expect(resolver).toHaveBeenCalledWith({
      registrationId: "app_1",
      bearerToken: "user-token",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toBe("https://stored-as.example.com/oauth/token");

    const headers = calledInit.headers as Record<string, string>;
    expect(headers["X-Evil"]).toBeUndefined();

    const form = new URLSearchParams(String(calledInit.body));
    expect(form.get("client_secret")).toBe("stored-secret");
    expect(form.get("client_id")).toBe("stored-client-id");
    expect(form.get("assertion")).toBe("aaa.bbb.ccc");
    expect(form.get("scope")).toBe("read:tools");
  });

  it("rejects a registration without a stored token endpoint", async () => {
    const resolver = vi.fn(async () => ({
      clientSecret: "stored-secret",
      tokenEndpoint: null,
      targetClientId: null,
      scopes: null,
    }));
    const app = buildApp({ resolver });

    const response = await app.request("/api/web/xaa/proxy/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        registrationId: "app_1",
        assertion: "aaa.bbb.ccc",
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { message?: string };
    expect(body.message).toContain("no stored token endpoint");
  });
});

describe("POST /negative-tests", () => {
  const originalKeyDir = process.env.XAA_IDP_KEY_DIR;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "xaa-negtest-"));
    process.env.XAA_IDP_KEY_DIR = tempDir;
    resetXAAIdpKeyPairForTests();
    initXAAIdpKeyPair();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetXAAIdpKeyPairForTests();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalKeyDir === undefined) {
      delete process.env.XAA_IDP_KEY_DIR;
    } else {
      process.env.XAA_IDP_KEY_DIR = originalKeyDir;
    }
  });

  function buildApp(
    resolver?: (args: {
      registrationId: string;
      bearerToken: string;
    }) => Promise<{
      clientSecret: string;
      tokenEndpoint: string | null;
      targetClientId: string | null;
      scopes: string[] | null;
    }>,
  ) {
    const app = new Hono();
    app.route(
      "/api/web/xaa",
      createXaaRouter({
        issuerBasePath: "/api/web",
        httpsOnlyProxy: false,
        resolveRegistrationSecret: resolver,
      }),
    );
    return app;
  }

  const INLINE_BODY = {
    audience: "https://auth.example.com",
    resource: "https://mcp.example.com",
    clientId: "mcpjam-debugger",
    tokenEndpoint: "https://auth.example.com/oauth/token",
  };

  it("marks a case red when the auth server wrongly issues a token for a broken assertion", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: "tok", token_type: "Bearer" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const app = buildApp();
    const response = await app.request("/api/web/xaa/negative-tests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(INLINE_BODY),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      results: Array<{ mode: string; verdict: string }>;
      failures: number;
    };
    expect(body.results).toHaveLength(11);
    expect(body.failures).toBe(11);
    const expired = body.results.find((r) => r.mode === "expired");
    expect(expired?.verdict).toBe("fail");
  });

  it("marks cases green when the auth server rejects broken assertions", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const app = buildApp();
    const response = await app.request("/api/web/xaa/negative-tests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(INLINE_BODY),
    });

    const body = (await response.json()) as {
      results: Array<{ verdict: string }>;
      failures: number;
    };
    expect(body.failures).toBe(0);
    expect(body.results.every((r) => r.verdict === "pass")).toBe(true);
  });

  it("yields partial results when a case times out (one slow case doesn't sink the run)", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return await new Promise<Response>((_resolve, reject) => {
          setTimeout(() => {
            const err = new Error("aborted");
            err.name = "TimeoutError";
            reject(err);
          }, 5);
        });
      }
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const app = buildApp();
    const response = await app.request("/api/web/xaa/negative-tests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(INLINE_BODY),
    });

    const body = (await response.json()) as {
      results: Array<{ outcome: string; verdict: string }>;
    };
    expect(body.results).toHaveLength(11);
    expect(body.results.some((r) => r.outcome === "timeout")).toBe(true);
    expect(body.results.some((r) => r.verdict === "pass")).toBe(true);
  });

  it("rejects an mcpjam-issuer-only registration (no own auth server)", async () => {
    const resolver = vi.fn(async () => ({
      clientSecret: "x",
      tokenEndpoint: null,
      targetClientId: null,
      scopes: null,
    }));
    const app = buildApp(resolver);

    const response = await app.request("/api/web/xaa/negative-tests", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer user-token",
      },
      body: JSON.stringify({
        audience: "https://auth.example.com",
        resource: "https://mcp.example.com",
        registrationId: "app_1",
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { message?: string };
    expect(body.message).toContain("its own auth server");
  });
});
